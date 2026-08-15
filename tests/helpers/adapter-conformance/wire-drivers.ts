import { create, fromBinary } from "@bufbuild/protobuf";
import type { ProviderAdapter } from "../../../src/adapters/base";
import type { AdapterWire } from "../../../src/adapters/registry";
import { decodeCursorArgsMap } from "../../../src/adapters/cursor/arg-codec";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import {
  handleCursorNativeKv,
  releaseCursorBlobRequestScope,
  type CursorBlobRequestScopeToken,
} from "../../../src/adapters/cursor/native-exec";
import { prepareCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";
import { createCursorRequest } from "../../../src/adapters/cursor/request-builder";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import type { OcxParsedRequest } from "../../../src/types";
import { withTestTranslatorBudget } from "../translator-budget";

export interface ToolWireDriver {
  observeOutbound(adapter: ProviderAdapter, parsed: OcxParsedRequest): Promise<string>;
  extractWireToolName?(body: string, canonicalName: string): string;
  streamingToolCall?(wireName: string, wrappedArguments: string): Response;
}

async function observeHttpOutbound(adapter: ProviderAdapter, parsed: OcxParsedRequest): Promise<string> {
  const testAdapter = withTestTranslatorBudget(adapter);
  const request = await testAdapter.buildRequest(parsed);
  try {
    return request.body;
  } finally {
    request.releaseBodyObservation?.();
  }
}

function cursorBlobData(blobId: Uint8Array, scope: CursorBlobRequestScopeToken): Uint8Array {
  const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
    id: 1,
    message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
  }), scope));
  if (reply.message.case !== "kvClientMessage") {
    throw new Error(`Cursor conformance expected kvClientMessage, got ${reply.message.case || "empty"}`);
  }
  const kv = reply.message.value;
  if (kv.message.case !== "getBlobResult" || !kv.message.value.blobData) {
    throw new Error(`Cursor conformance could not hydrate blob ${Buffer.from(blobId).toString("hex")}`);
  }
  return kv.message.value.blobData;
}

function splitInTwo(input: string): [string, string] {
  const split = Math.max(1, Math.floor(input.length / 2));
  return [input.slice(0, split), input.slice(split)];
}

function openAiChatToolCall(wireName: string, wrappedArguments: string): Response {
  const fragments = splitInTwo(wrappedArguments);
  const frames = fragments.map((argumentsFragment, index) => ({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          ...(index === 0 ? { id: "call_patch", type: "function" } : {}),
          function: {
            ...(index === 0 ? { name: wireName } : {}),
            arguments: argumentsFragment,
          },
        }],
      },
      finish_reason: index === fragments.length - 1 ? "tool_calls" : null,
    }],
  }));
  return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function anthropicToolCall(wireName: string, wrappedArguments: string): Response {
  const fragments = splitInTwo(wrappedArguments);
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response([
    frame("content_block_start", {
      type: "content_block_start",
      content_block: { type: "tool_use", id: "toolu_patch", name: wireName },
    }),
    ...fragments.map(partialJson => frame("content_block_delta", {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: partialJson },
    })),
    frame("content_block_stop", { type: "content_block_stop" }),
    frame("message_stop", { type: "message_stop" }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

function googleToolCall(wireName: string, wrappedArguments: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      candidates: [{
        content: { parts: [{ functionCall: { name: wireName, args: JSON.parse(wrappedArguments) } }] },
        finishReason: "STOP",
      }],
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function commandCodeToolCall(wireName: string, wrappedArguments: string): Response {
  return new Response([
    JSON.stringify({
      type: "tool-call",
      toolCallId: "call_patch",
      toolName: wireName,
      input: JSON.parse(wrappedArguments),
    }),
    JSON.stringify({ type: "finish", rawFinishReason: "tool_use" }),
  ].join("\n"));
}

const kiroEncoder = new TextEncoder();
function kiroFrame(payload: unknown): Uint8Array {
  return encodeMessage(
    { ":message-type": "event", ":event-type": "toolUseEvent" },
    kiroEncoder.encode(JSON.stringify(payload)),
  );
}

function kiroToolCall(wireName: string, wrappedArguments: string): Response {
  const fragments = splitInTwo(wrappedArguments);
  const frames = [
    kiroFrame({ name: wireName, toolUseId: "call_patch" }),
    ...fragments.map(input => kiroFrame({ input, name: wireName, toolUseId: "call_patch" })),
    kiroFrame({ name: wireName, stop: true, toolUseId: "call_patch" }),
  ];
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]!);
      else controller.close();
    },
  }));
}

function requireWireToolName(
  match: string | undefined,
  canonicalName: string,
  wire: AdapterWire,
): string {
  if (!match) throw new Error(`${wire} outbound body advertised no tool matching "${canonicalName}"`);
  return match;
}

const openAiChatDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
    const match = parsed.tools?.find(tool => tool.function?.name?.includes(canonicalName))?.function?.name;
    return requireWireToolName(match, canonicalName, "openai-chat");
  },
  streamingToolCall: openAiChatToolCall,
};

const anthropicDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as { tools?: Array<{ name?: string }> };
    const match = parsed.tools?.find(tool => tool.name?.includes(canonicalName))?.name;
    return requireWireToolName(match, canonicalName, "anthropic");
  },
  streamingToolCall: anthropicToolCall,
};

const googleDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as {
      tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }>;
    };
    for (const toolGroup of parsed.tools ?? []) {
      const match = toolGroup.functionDeclarations?.find(tool => tool.name?.includes(canonicalName))?.name;
      if (match) return match;
    }
    return requireWireToolName(undefined, canonicalName, "google");
  },
  streamingToolCall: googleToolCall,
};

const commandCodeDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as { params?: { tools?: Array<{ name?: string }> } };
    const match = parsed.params?.tools?.find(tool => tool.name?.includes(canonicalName))?.name;
    return requireWireToolName(match, canonicalName, "command-code");
  },
  streamingToolCall: commandCodeToolCall,
};

const kiroDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as {
      conversationState?: {
        currentMessage?: {
          userInputMessage?: {
            userInputMessageContext?: {
              tools?: Array<{ toolSpecification?: { name?: string } }>;
            };
          };
        };
      };
    };
    const tools = parsed.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools ?? [];
    const match = tools.find(tool => tool.toolSpecification?.name?.includes(canonicalName))?.toolSpecification?.name;
    return requireWireToolName(match, canonicalName, "kiro");
  },
  streamingToolCall: kiroToolCall,
};

const responsesDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as { tools?: Array<{ name?: string }> };
    const match = parsed.tools?.find(tool => tool.name?.includes(canonicalName))?.name;
    return requireWireToolName(match, canonicalName, "openai-responses");
  },
};

export const TOOL_WIRE_DRIVERS = {
  "openai-chat": openAiChatDriver,
  anthropic: anthropicDriver,
  google: googleDriver,
  "command-code": commandCodeDriver,
  kiro: kiroDriver,
  "openai-responses": responsesDriver,
  cursor: {
    async observeOutbound(_adapter, parsed) {
      const request = createCursorRequest(parsed);
      const prepared = prepareCursorRunRequest(request);
      try {
        const message = fromBinary(AgentClientMessageSchema, prepared.bytes);
        if (message.message.case !== "runRequest") {
          throw new Error(`Cursor conformance expected runRequest, got ${message.message.case || "empty"}`);
        }
        const runRequest = message.message.value;
        const tools = runRequest.mcpTools?.mcpTools ?? [];
        const continuationToolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
        for (const turnId of runRequest.conversationState?.turns ?? []) {
          const turn = fromBinary(
            ConversationTurnStructureSchema,
            cursorBlobData(turnId, prepared.blobRequestScope),
          );
          if (turn.turn.case !== "agentConversationTurn") continue;
          for (const stepId of turn.turn.value.steps) {
            const step = fromBinary(
              ConversationStepSchema,
              cursorBlobData(stepId, prepared.blobRequestScope),
            );
            if (step.message.case !== "toolCall") continue;
            const tool = step.message.value.tool;
            if (tool.case !== "mcpToolCall") continue;
            const args = tool.value.args;
            continuationToolCalls.push({
              name: args?.toolName || args?.name || "",
              arguments: decodeCursorArgsMap(args?.args),
            });
          }
        }
        return JSON.stringify({
          tools: tools.map(tool => ({
            name: tool.toolName || tool.name,
            description: tool.description,
          })),
          continuationToolCalls,
        });
      } finally {
        releaseCursorBlobRequestScope(prepared.blobRequestScope);
      }
    },
  },
} satisfies Record<AdapterWire, ToolWireDriver>;
