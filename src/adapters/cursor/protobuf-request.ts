import { create, toBinary } from "@bufbuild/protobuf";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { OcxAssistantContentPart, OcxMessage, OcxToolResultMessage } from "../../types";
import { namespacedToolName } from "../../types";
import { estimateTokens } from "../../lib/token-estimate";
import type { CursorRunRequest } from "./types";
import { isCursorExternalWireModel } from "./discovery";
import { debugProviderDiagnostic } from "../../lib/debug";
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
const decoder = new TextDecoder();

/** Parameter id advertised by Cursor's `default` model for its Cost/Balance/Intelligence control. */
export const CURSOR_ROUTING_LEVEL_PARAMETER_ID = "optimization";
// Cursor external workers reject oversized root replay sets with a late invalid_argument after
// hydrating every blob (observed at 208 roots with usedTokens=0). Keep headroom below that boundary,
// retaining all system prompts and the newest model-visible history. Cursor IDE similarly bounds /
// compacts long conversations rather than replaying an unbounded message list.
export const CURSOR_EXTERNAL_ROOT_BLOB_LIMIT = 192;
/** Approximate prompt-size guard; tool schemas and protocol framing consume context separately. */
export const CURSOR_EXTERNAL_ROOT_BYTE_LIMIT = 512 * 1024;

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

type StoredRootBlob = {
  id: Uint8Array;
  byteLength: number;
  role: "system" | "user" | "assistant" | "toolResult";
  messageIndex?: number;
  /** Original JSON text payload used when an active tool result must be truncated to fit. */
  text?: string;
};

function storedRootBlob(
  value: unknown,
  role: StoredRootBlob["role"],
  opts?: { messageIndex?: number; text?: string },
): StoredRootBlob {
  const data = jsonBlob(value);
  return {
    id: storeCursorBlob(data),
    byteLength: data.byteLength,
    role,
    ...(opts?.messageIndex !== undefined ? { messageIndex: opts.messageIndex } : {}),
    ...(opts?.text !== undefined ? { text: opts.text } : {}),
  };
}

function truncateToolResultBlob(entry: StoredRootBlob, maxBytes: number): StoredRootBlob | null {
  if (entry.byteLength <= maxBytes) return entry;
  if (entry.role !== "toolResult" || entry.text === undefined) return null;
  const marker = "\n…[truncated for Cursor external replay budget]";
  const encoded = encoder.encode(entry.text);
  // Leave headroom for JSON envelope (`role`/`content` wrapper) around the truncated text.
  let keepBytes = Math.min(encoded.byteLength, Math.max(0, maxBytes - encoder.encode(marker).byteLength - 96));
  for (let attempt = 0; attempt < 8; attempt++) {
    let end = keepBytes;
    while (end > 0 && end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) end -= 1;
    const truncated = `${decoder.decode(encoded.subarray(0, end))}${marker}`;
    const result = storedRootBlob(
      { role: "user", content: [{ type: "text", text: truncated }] },
      "toolResult",
      { messageIndex: entry.messageIndex, text: truncated },
    );
    if (result.byteLength <= maxBytes) return result;
    if (end === 0) break;
    keepBytes = Math.max(0, end - (result.byteLength - maxBytes) - 16);
  }
  const markerOnly = storedRootBlob(
    { role: "user", content: [{ type: "text", text: marker.trimStart() }] },
    "toolResult",
    { messageIndex: entry.messageIndex, text: marker.trimStart() },
  );
  return markerOnly.byteLength <= maxBytes ? markerOnly : null;
}

function systemPromptBlobs(request: CursorRunRequest): StoredRootBlob[] {
  const prompts = request.system.length > 0 ? [...request.system] : ["You are a helpful assistant."];
  if (cursorRequestHasShellAlias(request.tools)) prompts.push(CURSOR_SHELL_ALIAS_SYSTEM_NOTE);
  const cursorToolGuidance = buildCursorToolGuidanceSystemNote(
    cursorToolsForActivePrompt(request.tools, activePromptText(request), request.toolChoice),
    request.toolChoice,
  );
  if (cursorToolGuidance) prompts.push(cursorToolGuidance);
  return prompts.map(content => storedRootBlob({ role: "system", content }, "system"));
}

function assistantRootText(
  message: Extract<OcxMessage, { role: "assistant" }>,
  includeThinking: boolean,
): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => (part.type === "text" ? part.text : includeThinking && part.type === "thinking" ? part.thinking : undefined))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

// Cursor builds the actual model prompt from rootPromptMessagesJson (turns[] is UI/display metadata),
// so prior history — including assistant tool calls and tool results — must be replayed here or a
// ResumeAction has nothing model-visible to continue from. The active user message is excluded
// because it travels in the action. Tool results are rendered as user-role text with a marker, and
// each entry is a SHA-256 blob ID (Cursor fetches the bytes back via getBlobArgs). Mirrors the
// danger-pi reference buildRootPromptMessagesJson.
function rootPromptMessages(request: CursorRunRequest): {
  ids: Uint8Array[];
  byteLength: number;
  historyMessageStart: number;
} {
  const entries = systemPromptBlobs(request);
  const systemEntryCount = entries.length;
  const messages = request.rawMessages;
  if (!messages?.length) {
    return {
      ids: entries.map(entry => entry.id),
      byteLength: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
      historyMessageStart: 0,
    };
  }

  const externalModel = isCursorExternalWireModel(request.modelId);
  const lastRawIsToolResult = messages.at(-1)?.role === "toolResult";
  const activeUserIndex = lastRawIsToolResult ? -1 : lastActionIndex(messages);

  for (let i = 0; i < messages.length; i++) {
    if (i === activeUserIndex) break;
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user" || message.role === "developer") {
      const text = contentText(message).trim();
      // Cursor root replay expects OpenAI-style content parts for historical user messages.
      // A bare string survives blob hydration but external workers reject the completed replay
      // before tokenization (`usedTokens: 0`, then invalid_argument).
      if (text.length > 0) {
        entries.push(storedRootBlob({
          role: "user",
          content: [{ type: "text", text }],
        }, "user", { messageIndex: i }));
      }
    } else if (message.role === "assistant") {
      // External Cursor clients do not replay hidden reasoning as assistant-visible prompt text.
      // Native Composer state can preserve it through ThinkingMessage/history structures.
      const text = assistantRootText(message, !externalModel).trim();
      if (text.length > 0) {
        entries.push(storedRootBlob(
          { role: "assistant", content: [{ type: "text", text }] },
          "assistant",
          { messageIndex: i },
        ));
      }
      // Assistant tool CALLS are intentionally NOT replayed as visible "[Tool Call]" text here.
    } else if (message.role === "toolResult") {
      const prefix = message.isError ? "[Tool Error]" : "[Tool Result]";
      const text = `${prefix}\n${toolResultToText(message)}`;
      entries.push(storedRootBlob(
        { role: "user", content: [{ type: "text", text }] },
        "toolResult",
        { messageIndex: i, text },
      ));
    }
  }

  let selected = entries;
  let historyMessageStart = 0;
  if (externalModel) {
    const systemEntries = entries.slice(0, systemEntryCount);
    const history = entries.slice(systemEntryCount);
    const systemBytes = systemEntries.reduce((sum, entry) => sum + entry.byteLength, 0);
    const historyLimit = Math.max(0, CURSOR_EXTERNAL_ROOT_BLOB_LIMIT - systemEntryCount);
    const historyBudget = Math.max(0, CURSOR_EXTERNAL_ROOT_BYTE_LIMIT - systemBytes);

    // Retain the active trailing tool-result block when it fits (may truncate text).
    // If even a truncation marker cannot fit the remaining budget, omit it rather than
    // emitting an oversized root blob.
    let activeStart = history.length;
    while (activeStart > 0 && history[activeStart - 1]?.role === "toolResult") activeStart -= 1;
    const active = history
      .slice(activeStart)
      .map(entry => truncateToolResultBlob(entry, historyBudget))
      .filter((entry): entry is StoredRootBlob => entry !== null);
    let activeBytes = active.reduce((sum, entry) => sum + entry.byteLength, 0);
    while (active.length > 1 && activeBytes > historyBudget) {
      const dropped = active.shift();
      activeBytes -= dropped?.byteLength ?? 0;
    }
    if (active.length === 1 && active[0] && activeBytes > historyBudget) {
      const truncated = truncateToolResultBlob(active[0], historyBudget);
      if (truncated) {
        active[0] = truncated;
        activeBytes = truncated.byteLength;
      } else {
        active.length = 0;
        activeBytes = 0;
      }
    }

    const prior = history.slice(0, activeStart);
    const keptPrior: StoredRootBlob[] = [];
    let priorBytes = 0;
    // Take complete turns from the end: a turn starts at a user/developer root entry.
    let i = prior.length - 1;
    while (i >= 0 && keptPrior.length + active.length < historyLimit) {
      let turnStart = i;
      while (turnStart > 0 && prior[turnStart]?.role !== "user") turnStart -= 1;
      const turn = prior.slice(turnStart, i + 1);
      const turnBytes = turn.reduce((sum, entry) => sum + entry.byteLength, 0);
      if (
        keptPrior.length + active.length + turn.length > historyLimit
        || priorBytes + activeBytes + turnBytes > historyBudget
      ) {
        break;
      }
      keptPrior.unshift(...turn);
      priorBytes += turnBytes;
      i = turnStart - 1;
    }

    const historyEntries = [...keptPrior, ...active];
    // Guard against orphan assistant / toolResult at the start of the retained suffix.
    while (historyEntries[0]?.role === "assistant" || historyEntries[0]?.role === "toolResult") {
      // Never drop the sole active tool-result block.
      if (historyEntries.length <= active.length) break;
      historyEntries.shift();
    }
    selected = [...systemEntries, ...historyEntries];
    const firstKept = historyEntries.find(entry => entry.messageIndex !== undefined);
    historyMessageStart = firstKept?.messageIndex ?? (messages.length);
  }

  return {
    ids: selected.map(entry => entry.id),
    byteLength: selected.reduce((sum, entry) => sum + entry.byteLength, 0),
    historyMessageStart,
  };
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

function conversationTurns(request: CursorRunRequest, historyMessageStart = 0): Uint8Array[] {
  const messages = request.rawMessages;
  if (!messages?.length) return [];
  const end = lastActionIndex(messages);
  const externalModel = isCursorExternalWireModel(request.modelId);
  const historyEnd = messages.at(-1)?.role === "toolResult" ? messages.length : Math.max(0, end);
  const start = externalModel ? Math.max(0, historyMessageStart) : 0;
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

  for (const message of messages.slice(start, historyEnd)) {
    if (message.role === "assistant") {
      if (!current) continue;
      for (const part of message.content) {
        if (externalModel) {
          // Working external-model clients replay only assistant text. Native mcpToolCall and
          // ThinkingMessage structures are Composer state and cause external workers to hydrate
          // the blobs, reach stepCompleted, then reject the turn with invalid_argument.
          if (part.type === "text" && part.text.length > 0) {
            current.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
              message: {
                case: "assistantMessage",
                value: create(AssistantMessageSchema, { text: part.text }),
              },
            }))));
          }
          continue;
        }
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
      if (externalModel) {
        const prefix = message.isError ? "[Tool Error]" : "[Tool Result]";
        current.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: `${prefix}\n${contentToText(message.content)}` }),
          },
        }))));
        continue;
      }
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

/**
 * Conservative request-local fallback when Cursor emits neither a checkpoint nor a previously
 * observed context total. This is deliberately not persisted: a later authoritative checkpoint
 * remains the only source carried across turns.
 */
export function estimateCursorInputTokens(request: CursorRunRequest): number {
  return estimateTokens(JSON.stringify({
    system: request.system,
    messages: request.rawMessages ?? request.messages,
    tools: request.tools,
  }), request.modelId);
}

export function encodeCursorRunRequest(request: CursorRunRequest): Uint8Array {
  const rawText = activePromptText(request);
  const lastRole = request.messages.at(-1)?.role;
  const text = lastRole === "user" || lastRole === "developer"
    ? appendCursorShellAliasHint(request.tools, appendCursorGenericToolUseHint(request.tools, rawText))
    : rawText;
  // Tool-result-only turns resume the remembered Cursor conversation with results in history.
  const lastRawIsToolResult = request.rawMessages?.at(-1)?.role === "toolResult";
  const actionCase = !lastRawIsToolResult && text.trim().length > 0
    ? "userMessageAction"
    : "resumeAction";
  const action = create(ConversationActionSchema, {
    action: actionCase === "userMessageAction"
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
  const rootPromptMessagesState = rootPromptMessages(request);
  const rootPromptMessageIds = rootPromptMessagesState.ids;
  const turnIds = conversationTurns(request, rootPromptMessagesState.historyMessageStart);
  debugProviderDiagnostic("cursor", "run-request", {
    wireModel: request.modelId,
    action: actionCase,
    conversationId: request.conversationId,
    turnType: lastRawIsToolResult ? "tool-continuation" : "initial",
    externalModel: isCursorExternalWireModel(request.modelId),
    rawMessages: request.rawMessages?.length ?? 0,
    rootBlobs: rootPromptMessageIds.length,
    rootBytes: rootPromptMessagesState.byteLength,
    turnBlobs: turnIds.length,
    tools: request.tools?.length ?? 0,
  });

  const runRequest = create(AgentRunRequestSchema, {
    conversationId: request.conversationId,
    conversationState: create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: rootPromptMessageIds,
      turns: turnIds,
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
    // requested_model is currently a Cursor Router-only surface. External model clients still
    // send model_details alone; sending both makes external workers reach stepCompleted and then
    // reject the turn with invalid_argument.
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
