import { create, toBinary } from "@bufbuild/protobuf";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { OcxAssistantContentPart, OcxMessage, OcxToolResultMessage } from "../../types";
import { namespacedToolName } from "../../types";
import type { CursorRunRequest } from "./types";
import { storeCursorBlob } from "./native-exec";
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AssistantMessageSchema,
  AgentRunRequestSchema,
  ConversationActionSchema,
  ConversationStepSchema,
  ConversationStateStructureSchema,
  ConversationTurnStructureSchema,
  McpArgsSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolResultContentItemSchema,
  McpToolResultSchema,
  ModelDetailsSchema,
  ResumeActionSchema,
  ThinkingMessageSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "./gen/agent_pb";
import { OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";

const encoder = new TextEncoder();

function jsonBlob(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function rootPromptMessages(request: CursorRunRequest): Uint8Array[] {
  // Each entry is a SHA-256 blob ID (not inline JSON); Cursor fetches the bytes back via getBlobArgs.
  return request.system.length > 0
    ? request.system.map(content => storeCursorBlob(jsonBlob({ role: "system", content })))
    : [storeCursorBlob(jsonBlob({ role: "system", content: "You are a helpful assistant." }))];
}

function contentText(message: OcxMessage): string {
  if (message.role === "toolResult") return toolResultToText(message);
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      if (part.type === "image") return `[image input unsupported by Cursor adapter phase 3: ${part.detail ?? "auto"}]`;
      return undefined;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function contentToText(content: OcxToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map(part => part.type === "text" ? part.text : `[image input unsupported by Cursor adapter phase 3: ${part.detail ?? "auto"}]`)
    .join("\n");
}

function toolResultToText(message: OcxToolResultMessage): string {
  return [
    "[tool_result]",
    `call_id: ${message.toolCallId}`,
    `name: ${namespacedToolName(message.toolNamespace, message.toolName)}`,
    `is_error: ${message.isError}`,
    "output:",
    contentToText(message.content),
  ].join("\n");
}

function argBytes(value: unknown): Uint8Array {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue));
  } catch {
    return encoder.encode(JSON.stringify(value));
  }
}

function toolCallStep(part: Extract<OcxAssistantContentPart, { type: "toolCall" }>, result?: OcxToolResultMessage): Uint8Array {
  const args: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(part.arguments ?? {})) args[key] = argBytes(value);
  const toolName = namespacedToolName(part.namespace, part.name);
  return storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
    message: {
      case: "toolCall",
      value: create(ToolCallSchema, {
        tool: {
          case: "mcpToolCall",
          value: create(McpToolCallSchema, {
            args: create(McpArgsSchema, {
              name: toolName,
              toolName,
              toolCallId: part.id,
              providerIdentifier: OCX_RESPONSES_TOOL_PROVIDER,
              args,
            }),
            ...(result ? { result: toolResultPart(result) } : {}),
          }),
        },
      }),
    },
  })));
}

function toolResultPart(message: OcxToolResultMessage) {
  return create(McpToolResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, {
        isError: message.isError,
        content: [create(McpToolResultContentItemSchema, {
          content: { case: "text", value: create(McpTextContentSchema, { text: contentToText(message.content) }) },
        })],
      }),
    },
  });
}

function assistantStep(part: OcxAssistantContentPart): Uint8Array | undefined {
  if (part.type === "toolCall") return toolCallStep(part);
  if (part.type === "thinking") {
    return storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: "thinkingMessage",
        value: create(ThinkingMessageSchema, { text: part.thinking }),
      },
    })));
  }
  if (part.text.length === 0) return undefined;
  return storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
    message: {
      case: "assistantMessage",
      value: create(AssistantMessageSchema, { text: part.text }),
    },
  })));
}

function lastActionIndex(messages: readonly OcxMessage[] | undefined): number {
  if (!messages) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user" || role === "developer") return i;
    if (role === "toolResult") continue;
  }
  return -1;
}

function conversationTurns(request: CursorRunRequest): Uint8Array[] {
  const messages = request.rawMessages;
  if (!messages?.length) return [];
  const end = lastActionIndex(messages);
  const historyEnd = messages.at(-1)?.role === "toolResult" ? messages.length : Math.max(0, end);
  const turns: Uint8Array[] = [];
  let current: { userMessage: Uint8Array; steps: Uint8Array[] } | undefined;
  const pendingToolCalls = new Map<string, Extract<OcxAssistantContentPart, { type: "toolCall" }>>();
  const flush = () => {
    if (!current) return;
    for (const part of pendingToolCalls.values()) current.steps.push(toolCallStep(part));
    turns.push(storeCursorBlob(toBinary(ConversationTurnStructureSchema, create(ConversationTurnStructureSchema, {
      turn: {
        case: "agentConversationTurn",
        value: create(AgentConversationTurnStructureSchema, current),
      },
    }))));
    current = undefined;
    pendingToolCalls.clear();
  };

  for (const message of messages.slice(0, historyEnd)) {
    if (message.role === "assistant") {
      if (!current) continue;
      for (const part of message.content) {
        if (part.type === "toolCall") {
          pendingToolCalls.set(part.id, part);
          continue;
        }
        const step = assistantStep(part);
        if (step) current.steps.push(step);
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (!current) continue;
      const priorCall = pendingToolCalls.get(message.toolCallId);
      if (priorCall) {
        current.steps.push(toolCallStep(priorCall, message));
        pendingToolCalls.delete(message.toolCallId);
      } else {
        current.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: toolResultToText(message) }),
          },
        }))));
      }
      continue;
    }
    flush();
    current = {
      userMessage: storeCursorBlob(toBinary(UserMessageSchema, create(UserMessageSchema, {
        text: contentText(message),
        messageId: crypto.randomUUID(),
      }))),
      steps: [],
    };
  }
  flush();
  return turns;
}

function lastUserText(request: CursorRunRequest): string {
  const last = request.messages.at(-1);
  return last?.role === "user" || last?.role === "developer" || last?.role === "tool" ? last.content : "";
}

export function encodeCursorRunRequest(request: CursorRunRequest): Uint8Array {
  const text = lastUserText(request);
  // A tool-result-only turn (the last raw message is a toolResult) continues the SAME Cursor
  // conversation with the tool result carried as structured conversation history (mcpToolCall.result
  // in conversationTurns). It must NOT inject the tool result text as a new UserMessageAction — that
  // would pollute the model input and double-deliver the result. Use ResumeAction so Cursor picks up
  // from the history we provided.
  const lastRawIsToolResult = request.rawMessages?.at(-1)?.role === "toolResult";
  const action = create(ConversationActionSchema, {
    action: !lastRawIsToolResult && text.trim().length > 0
      ? {
          case: "userMessageAction",
          value: create(UserMessageActionSchema, {
            userMessage: create(UserMessageSchema, {
              text,
              messageId: crypto.randomUUID(),
            }),
          }),
        }
      : {
          case: "resumeAction",
          value: create(ResumeActionSchema, {}),
        },
  });

  const runRequest = create(AgentRunRequestSchema, {
    conversationId: request.conversationId,
    conversationState: create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: rootPromptMessages(request),
      turns: conversationTurns(request),
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [],
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      readPaths: [],
    }),
    action,
    modelDetails: create(ModelDetailsSchema, {
      modelId: request.modelId,
      displayModelId: request.modelId,
      displayName: request.modelId,
      displayNameShort: request.modelId,
      aliases: [],
    }),
  });

  const message = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });
  return toBinary(AgentClientMessageSchema, message);
}
