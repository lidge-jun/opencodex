import type { ProviderAdapter } from "../../../src/adapters/base";
import type { AdapterWire } from "../../../src/adapters/contracts";
import { createCursorRequest } from "../../../src/adapters/cursor/request-builder";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import type { OcxParsedRequest } from "../../../src/types";
import { withTestTranslatorBudget } from "../translator-budget";

export interface ToolWireDriver {
  observeOutbound(adapter: ProviderAdapter, parsed: OcxParsedRequest): Promise<string>;
  extractWireToolName?(body: string, canonicalName: string): string;
  streamingToolCall?(wireName: string, wrappedArguments: string): Response;
  streamingToolCallFragments?(wireName: string, argumentFragments: readonly string[]): Response;
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

function splitInTwo(input: string): [string, string] {
  const split = Math.max(1, Math.floor(input.length / 2));
  return [input.slice(0, split), input.slice(split)];
}

function openAiChatToolCallFragments(wireName: string, argumentFragments: readonly string[]): Response {
  const fragments = argumentFragments.length > 0 ? argumentFragments : [""];
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

function openAiChatToolCall(wireName: string, wrappedArguments: string): Response {
  return openAiChatToolCallFragments(wireName, splitInTwo(wrappedArguments));
}

function anthropicToolCallFragments(wireName: string, argumentFragments: readonly string[]): Response {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response([
    frame("content_block_start", {
      type: "content_block_start",
      content_block: { type: "tool_use", id: "toolu_patch", name: wireName },
    }),
    ...argumentFragments.map(partialJson => frame("content_block_delta", {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: partialJson },
    })),
    frame("content_block_stop", { type: "content_block_stop" }),
    frame("message_stop", { type: "message_stop" }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

function anthropicToolCall(wireName: string, wrappedArguments: string): Response {
  return anthropicToolCallFragments(wireName, splitInTwo(wrappedArguments));
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

function kiroToolCallFragments(wireName: string, argumentFragments: readonly string[]): Response {
  const frames = [
    kiroFrame({ name: wireName, toolUseId: "call_patch" }),
    ...argumentFragments.map(input => kiroFrame({ input, name: wireName, toolUseId: "call_patch" })),
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

function kiroToolCall(wireName: string, wrappedArguments: string): Response {
  return kiroToolCallFragments(wireName, splitInTwo(wrappedArguments));
}

const openAiChatDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
    return parsed.tools?.find(tool => tool.function?.name?.includes(canonicalName))?.function?.name ?? canonicalName;
  },
  streamingToolCall: openAiChatToolCall,
  streamingToolCallFragments: openAiChatToolCallFragments,
};

const anthropicDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as { tools?: Array<{ name?: string }> };
    return parsed.tools?.find(tool => tool.name?.includes(canonicalName))?.name ?? canonicalName;
  },
  streamingToolCall: anthropicToolCall,
  streamingToolCallFragments: anthropicToolCallFragments,
};

const googleDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as {
      tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }>;
    };
    for (const toolGroup of parsed.tools ?? []) {
      const match = toolGroup.functionDeclarations?.find(tool => tool.name?.includes(canonicalName));
      if (match?.name) return match.name;
    }
    return canonicalName;
  },
  streamingToolCall: googleToolCall,
};

const commandCodeDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as { params?: { tools?: Array<{ name?: string }> } };
    return parsed.params?.tools?.find(tool => tool.name?.includes(canonicalName))?.name ?? canonicalName;
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
    return tools.find(tool => tool.toolSpecification?.name?.includes(canonicalName))?.toolSpecification?.name ?? canonicalName;
  },
  streamingToolCall: kiroToolCall,
  streamingToolCallFragments: kiroToolCallFragments,
};

const responsesDriver: ToolWireDriver = {
  observeOutbound: observeHttpOutbound,
  extractWireToolName(body, canonicalName) {
    const parsed = JSON.parse(body) as { tools?: Array<{ name?: string }> };
    return parsed.tools?.find(tool => tool.name?.includes(canonicalName))?.name ?? canonicalName;
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
      return JSON.stringify(createCursorRequest(parsed));
    },
  },
} satisfies Record<AdapterWire, ToolWireDriver>;
