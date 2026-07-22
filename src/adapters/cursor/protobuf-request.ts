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
  McpToolsSchema,
  ModelDetailsSchema,
  RequestedModelSchema,
  RequestedModel_ModelParameterbytesSchema,
  ResumeActionSchema,
  RequestContextSchema,
  RequestContextEnvSchema,
  ThinkingMessageSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "./gen/agent_pb";
import {
  appendCursorGenericToolUseHint,
  appendCursorShellAliasHint,
  cursorToolsForActivePrompt,
  buildCursorToolGuidanceSystemNote,
  buildCursorToolDefinitions,
  cursorRequestHasShellAlias,
  CURSOR_SHELL_ALIAS_SYSTEM_NOTE,
  OCX_RESPONSES_TOOL_PROVIDER,
} from "./tool-definitions";

const encoder = new TextEncoder();

/** Parameter id advertised by Cursor's `default` model for its Cost/Balance/Intelligence control. */
export const CURSOR_ROUTING_LEVEL_PARAMETER_ID = "optimization";

/** Runtime timezone for protobuf RequestContextEnv (dynamic, never hardcoded). */
function runtimeTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

/** Builds a RequestContext with env.timeZone populated dynamically. */
function buildRequestContext() {
  return create(RequestContextSchema, {
    env: create(RequestContextEnvSchema, {
      timeZone: runtimeTimeZone(),
    }),
  });
}

function jsonBlob(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function systemPromptBlobs(request: CursorRunRequest): Uint8Array[] {
  const prompts = request.system.length > 0 ? [...request.system] : ["You are a helpful assistant."];
  if (cursorRequestHasShellAlias(request.tools)) prompts.push(CURSOR_SHELL_ALIAS_SYSTEM_NOTE);
  const cursorToolGuidance = buildCursorToolGuidanceSystemNote(
    cursorToolsForActivePrompt(request.tools, activePromptText(request), request.toolChoice),
    request.toolChoice,
  );
  if (cursorToolGuidance) prompts.push(cursorToolGuidance);
  return prompts.map(content => storeCursorBlob(jsonBlob({ role: "system", content })));
}

function assistantRootText(message: Extract<OcxMessage, { role: "assistant" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => (part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : undefined))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

// Cursor builds the actual model prompt from rootPromptMessagesJson (turns[] is UI/display metadata),
// so prior history — including assistant tool calls and tool results — must be replayed here or a
// ResumeAction has nothing model-visible to continue from. The active user message is excluded
// because it travels in the action. Tool results are rendered as user-role text with a marker, and
// each entry is a SHA-256 blob ID (Cursor fetches the bytes back via getBlobArgs). Mirrors the
// danger-pi reference buildRootPromptMessagesJson.
function rootPromptMessages(request: CursorRunRequest): Uint8Array[] {
  const entries = systemPromptBlobs(request);
  const messages = request.rawMessages;
  if (!messages?.length) return entries;

  const lastRawIsToolResult = messages.at(-1)?.role === "toolResult";
  const activeUserIndex = lastRawIsToolResult ? -1 : lastActionIndex(messages);

  for (let i = 0; i < messages.length; i++) {
    if (i === activeUserIndex) break;
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user" || message.role === "developer") {
      const text = contentText(message).trim();
      if (text.length > 0) entries.push(storeCursorBlob(jsonBlob({ role: "user", content: text })));
    } else if (message.role === "assistant") {
      const text = assistantRootText(message).trim();
      if (text.length > 0) entries.push(storeCursorBlob(jsonBlob({ role: "assistant", content: [{ type: "text", text }] })));
      // Assistant tool CALLS are intentionally NOT replayed as visible "[Tool Call]" text here.
      // rootPromptMessagesJson is the model-visible prompt, so a synthetic "[Tool Call]" marker in an
      // assistant turn gets few-shot-mimicked: the model then emits later (esp. parallel/mixed) tool
      // calls as inert text instead of real tool frames, halting multi-tool continuations. The paired
      // tool result below ([Tool Result]/[Tool Error]) carries the call id/name/output Cursor needs to
      // continue, and conversationTurns replays the native mcpToolCall step. Mirrors request-builder.ts
      // contentPartToText() which returns undefined for toolCall for the same reason.
    } else if (message.role === "toolResult") {
      const prefix = message.isError ? "[Tool Error]" : "[Tool Result]";
      const text = `${prefix}\n${toolResultToText(message)}`;
      entries.push(storeCursorBlob(jsonBlob({ role: "user", content: [{ type: "text", text }] })));
    }
  }
  return entries;
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

export function activePromptText(request: CursorRunRequest): string {
  const last = request.messages.at(-1);
  if (last?.role === "user" || last?.role === "developer") return last.content;
  for (let i = (request.rawMessages?.length ?? 0) - 1; i >= 0; i--) {
    const message = request.rawMessages?.[i];
    if (message?.role === "user" || message?.role === "developer") {
      const text = contentText(message);
      if (text.trim().length > 0) return text;
    }
  }
  return last?.role === "tool" ? last.content : "";
}

export function encodeCursorRunRequest(request: CursorRunRequest): Uint8Array {
  const rawText = activePromptText(request);
  const lastRole = request.messages.at(-1)?.role;
  const text = lastRole === "user" || lastRole === "developer"
    ? appendCursorShellAliasHint(request.tools, appendCursorGenericToolUseHint(request.tools, rawText))
    : rawText;
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
            requestContext: buildRequestContext(),
          }),
        }
      : {
          case: "resumeAction",
          value: create(ResumeActionSchema, {
            requestContext: buildRequestContext(),
          }),
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
    ...(request.routingLevel ? {
      requestedModel: create(RequestedModelSchema, {
        modelId: request.modelId,
        maxMode: false,
        parameters: [create(RequestedModel_ModelParameterbytesSchema, {
          id: CURSOR_ROUTING_LEVEL_PARAMETER_ID,
          value: request.routingLevel,
        })],
      }),
    } : {}),
    // Mirror the client (Responses) tool definitions into the top-level AgentRunRequest.mcp_tools
    // channel. Advertising them ONLY via native-exec `requestContextArgs` (RequestContext.tools) is
    // insufficient: cursor models report those tools as unavailable and fall back to native tools.
    // Populating mcp_tools registers them into the model's callable catalog (verified live: the
    // model actually calls the injected tool on gpt-5.6-luna and claude-4.5-sonnet). Phase 42 tried
    // this but assigned the field with the wrong shape and crashed Cursor's binary parser ("illegal
    // tag"); the correct `McpTools` wrapper is wire-compatible (verified — no parse crash on either
    // model family). See devlog/260711_cursor_browser_bridge/004.
    //
    // Use the SAME `cursorToolsForActivePrompt`-filtered visible set that RequestContext.tools and
    // the event-state `clientToolNames` use (live-transport.ts). Advertising the raw `request.tools`
    // here would let mcp_tools expose a tool that the event state does not recognize for a generic
    // tool-count prompt, so a call to it would be rejected as an unknown Responses tool.
    ...(() => {
      const visibleTools = cursorToolsForActivePrompt(request.tools, activePromptText(request), request.toolChoice);
      const mcpToolDefs = buildCursorToolDefinitions(visibleTools, request.toolChoice);
      return mcpToolDefs.length > 0 ? { mcpTools: create(McpToolsSchema, { mcpTools: mcpToolDefs }) } : {};
    })(),
  });

  const message = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });
  return toBinary(AgentClientMessageSchema, message);
}
