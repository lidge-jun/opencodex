import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { OcxAssistantContentPart, OcxMessage, OcxToolResultMessage } from "../../types";
import { namespacedToolName } from "../../types";
import type { CursorRunRequest } from "./types";
import { isCursorExternalWireModel } from "./discovery";
import { debugProviderDiagnostic } from "../../lib/debug";
import {
  createCursorBlobRequestScope,
  releaseCursorBlobRequestScope,
  sealCursorBlobRequestScope,
  storeCursorBlob,
  type CursorBlobRequestScopeToken,
} from "./native-exec";
import { estimateTokens } from "../../lib/token-estimate";
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
  type McpToolDefinition,
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

function jsonBlob(value: unknown): { data: Uint8Array; serialized: string } {
  const serialized = JSON.stringify(value);
  return { data: encoder.encode(serialized), serialized };
}

type RootBlobCandidate = {
  data: Uint8Array;
  byteLength: number;
  /**
   * The exact JSON handed to storeCursorBlob(). Retained so a token estimate can read
   * what the wire actually carries without re-serializing — and without drifting from
   * it after pruning or truncation (#373).
   */
  serialized: string;
  role: "system" | "user" | "assistant" | "toolResult";
  messageIndex?: number;
  /** Original JSON text payload used when an active tool result must be truncated to fit. */
  text?: string;
};

function rootBlobCandidate(
  value: unknown,
  role: RootBlobCandidate["role"],
  opts?: { messageIndex?: number; text?: string },
): RootBlobCandidate {
  const { data, serialized } = jsonBlob(value);
  return {
    data,
    byteLength: data.byteLength,
    serialized,
    role,
    ...(opts?.messageIndex !== undefined ? { messageIndex: opts.messageIndex } : {}),
    ...(opts?.text !== undefined ? { text: opts.text } : {}),
  };
}

function truncateToolResultBlob(entry: RootBlobCandidate, maxBytes: number): RootBlobCandidate | null {
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
    const result = rootBlobCandidate(
      { role: "user", content: [{ type: "text", text: truncated }] },
      "toolResult",
      { messageIndex: entry.messageIndex, text: truncated },
    );
    if (result.byteLength <= maxBytes) return result;
    if (end === 0) break;
    keepBytes = Math.max(0, end - (result.byteLength - maxBytes) - 16);
  }
  const markerOnly = rootBlobCandidate(
    { role: "user", content: [{ type: "text", text: marker.trimStart() }] },
    "toolResult",
    { messageIndex: entry.messageIndex, text: marker.trimStart() },
  );
  return markerOnly.byteLength <= maxBytes ? markerOnly : null;
}

function systemPromptBlobs(request: CursorRunRequest): RootBlobCandidate[] {
  const prompts = request.system.length > 0 ? [...request.system] : ["You are a helpful assistant."];
  if (cursorRequestHasShellAlias(request.tools)) prompts.push(CURSOR_SHELL_ALIAS_SYSTEM_NOTE);
  const cursorToolGuidance = buildCursorToolGuidanceSystemNote(
    cursorToolsForActivePrompt(request.tools, activePromptText(request), request.toolChoice),
    request.toolChoice,
  );
  if (cursorToolGuidance) prompts.push(cursorToolGuidance);
  return prompts.map(content => rootBlobCandidate({ role: "system", content }, "system"));
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
function rootPromptMessages(request: CursorRunRequest, requestScope: CursorBlobRequestScopeToken): {
  ids: Uint8Array[];
  byteLength: number;
  historyMessageStart: number;
  /** Serialized text of the roots that survived pruning, in wire order. */
  serialized: string[];
} {
  const entries = systemPromptBlobs(request);
  const systemEntryCount = entries.length;
  const messages = request.rawMessages;
  if (!messages?.length) {
    return {
      ids: entries.map(entry => storeCursorBlob(entry.data, requestScope)),
      byteLength: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
      historyMessageStart: 0,
      serialized: entries.map(entry => entry.serialized),
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
        entries.push(rootBlobCandidate({
          role: "user",
          content: [{ type: "text", text }],
        }, "user", { messageIndex: i }));
      }
    } else if (message.role === "assistant") {
      // External Cursor clients do not replay hidden reasoning as assistant-visible prompt text.
      // Native Composer state can preserve it through ThinkingMessage/history structures.
      const text = assistantRootText(message, !externalModel).trim();
      if (text.length > 0) {
        entries.push(rootBlobCandidate(
          { role: "assistant", content: [{ type: "text", text }] },
          "assistant",
          { messageIndex: i },
        ));
      }
      // Assistant tool CALLS are intentionally NOT replayed as visible "[Tool Call]" text here.
    } else if (message.role === "toolResult") {
      const prefix = message.isError ? "[Tool Error]" : "[Tool Result]";
      const text = `${prefix}\n${toolResultToText(message)}`;
      entries.push(rootBlobCandidate(
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
      .filter((entry): entry is RootBlobCandidate => entry !== null);
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
    const keptPrior: RootBlobCandidate[] = [];
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
    ids: selected.map(entry => storeCursorBlob(entry.data, requestScope)),
    byteLength: selected.reduce((sum, entry) => sum + entry.byteLength, 0),
    historyMessageStart,
    serialized: selected.map(entry => entry.serialized),
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

function toolCallStep(
  part: Extract<OcxAssistantContentPart, { type: "toolCall" }>,
  requestScope: CursorBlobRequestScopeToken,
  result?: OcxToolResultMessage,
): Uint8Array {
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
  })), requestScope);
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

function assistantStep(part: OcxAssistantContentPart, requestScope: CursorBlobRequestScopeToken): Uint8Array | undefined {
  if (part.type === "toolCall") return toolCallStep(part, requestScope);
  if (part.type === "thinking") {
    return storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: "thinkingMessage",
        value: create(ThinkingMessageSchema, { text: part.thinking }),
      },
    })), requestScope);
  }
  if (part.text.length === 0) return undefined;
  return storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
    message: {
      case: "assistantMessage",
      value: create(AssistantMessageSchema, { text: part.text }),
    },
  })), requestScope);
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

function conversationTurns(
  request: CursorRunRequest,
  requestScope: CursorBlobRequestScopeToken,
  historyMessageStart = 0,
): Uint8Array[] {
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
    for (const part of pendingToolCalls.values()) current.steps.push(toolCallStep(part, requestScope));
    turns.push(storeCursorBlob(toBinary(ConversationTurnStructureSchema, create(ConversationTurnStructureSchema, {
      turn: {
        case: "agentConversationTurn",
        value: create(AgentConversationTurnStructureSchema, current),
      },
    })), requestScope));
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
            })), requestScope));
          }
          continue;
        }
        if (part.type === "toolCall") {
          pendingToolCalls.set(part.id, part);
          continue;
        }
        const step = assistantStep(part, requestScope);
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
        })), requestScope));
        continue;
      }
      const priorCall = pendingToolCalls.get(message.toolCallId);
      if (priorCall) {
        current.steps.push(toolCallStep(priorCall, requestScope, message));
        pendingToolCalls.delete(message.toolCallId);
      } else {
        current.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: toolResultToText(message) }),
          },
        })), requestScope));
      }
      continue;
    }
    flush();
    current = {
      userMessage: storeCursorBlob(toBinary(UserMessageSchema, create(UserMessageSchema, {
        text: contentText(message),
        messageId: crypto.randomUUID(),
      })), requestScope),
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
 * The model-visible text of one finalized tool definition. The schema travels as
 * packed protobuf bytes, so it is decoded back to JSON to be counted the way the
 * model reads it.
 */
function modelVisibleToolText(definition: McpToolDefinition): string {
  let inputSchema: unknown;
  try {
    inputSchema = toJson(ValueSchema, fromBinary(ValueSchema, definition.inputSchema));
  } catch {
    inputSchema = undefined;
  }
  return JSON.stringify({
    name: definition.toolName || definition.name,
    description: definition.description,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
  });
}

export interface PreparedCursorRunRequest {
  bytes: Uint8Array;
  blobRequestScope: CursorBlobRequestScopeToken;
  /** Only present when the caller asked for it; see prepareCursorRunRequest(). */
  estimatedInputTokens?: number;
}

/**
 * Build the wire payload once, and optionally derive a token estimate from the very
 * same roots, action text, and tool definitions that produced it.
 *
 * Cursor only reports absolute context size in checkpoint frames, which live in a
 * process-local map — so after a restart a turn with no checkpoint reports
 * inputTokens=0 and Codex sees an almost-empty context (#373). The estimate fills
 * that gap. Deriving it here, rather than from the original request, is what keeps
 * it honest: history the pruner dropped and tools the filter removed are already
 * gone by this point.
 */
function buildPreparedCursorRunRequest(
  request: CursorRunRequest,
  requestScope: CursorBlobRequestScopeToken,
  options?: { estimateInputTokens?: boolean },
): PreparedCursorRunRequest {
  const rawText = activePromptText(request);
  const lastRole = request.messages.at(-1)?.role;
  const text = lastRole === "user" || lastRole === "developer"
    ? appendCursorGenericToolUseHint(request.tools, rawText)
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
  const rootPromptMessagesState = rootPromptMessages(request, requestScope);
  const rootPromptMessageIds = rootPromptMessagesState.ids;
  const turnIds = conversationTurns(request, requestScope, rootPromptMessagesState.historyMessageStart);
  // Hoisted out of the mcp_tools spread below so the estimate can read the same
  // filtered definitions the wire carries. Both helpers are pure.
  const visibleTools = cursorToolsForActivePrompt(request.tools, rawText, request.toolChoice);
  const mcpToolDefs = buildCursorToolDefinitions(visibleTools, request.toolChoice);
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

  const requestedModelParameters = [
    ...(request.requestedModelParameters ?? []),
    ...(request.routingLevel ? [{ id: CURSOR_ROUTING_LEVEL_PARAMETER_ID, value: request.routingLevel }] : []),
  ];
  const hasExplicitModelParameters = (request.requestedModelParameters?.length ?? 0) > 0;
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
    // Explicit model-picker parameters follow current Cursor clients and use requested_model alone.
    // Keep legacy model_details for flat model ids and the already-live Router path; sending both for
    // a parameterized external model can resolve conflicting selections and end in invalid_argument.
    ...(!hasExplicitModelParameters ? {
      modelDetails: create(ModelDetailsSchema, {
        modelId: request.modelId,
        displayModelId: request.modelId,
        displayName: request.modelId,
        displayNameShort: request.modelId,
        aliases: [],
      }),
    } : {}),
    ...(requestedModelParameters.length > 0 ? {
      requestedModel: create(RequestedModelSchema, {
        modelId: request.modelId,
        maxMode: false,
        parameters: requestedModelParameters.map(parameter =>
          create(RequestedModel_ModelParameterbytesSchema, parameter)),
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
    ...(mcpToolDefs.length > 0 ? { mcpTools: create(McpToolsSchema, { mcpTools: mcpToolDefs }) } : {}),
  });

  const message = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });
  const bytes = toBinary(AgentClientMessageSchema, message);
  if (!options?.estimateInputTokens) return { bytes, blobRequestScope: requestScope };

  // Same instances that produced `bytes`, so the estimate cannot count history or
  // tools the payload dropped — the defect that blocked PR #376.
  const modelVisibleParts = [
    ...rootPromptMessagesState.serialized,
    ...(actionCase === "userMessageAction" ? [text] : []),
    ...mcpToolDefs.map(modelVisibleToolText),
  ];
  return {
    bytes,
    blobRequestScope: requestScope,
    estimatedInputTokens: estimateTokens(modelVisibleParts.join("\n"), request.modelId),
  };
}

export function prepareCursorRunRequest(
  request: CursorRunRequest,
  options?: { estimateInputTokens?: boolean },
): PreparedCursorRunRequest {
  const requestScope = createCursorBlobRequestScope();
  try {
    const prepared = buildPreparedCursorRunRequest(request, requestScope, options);
    sealCursorBlobRequestScope(requestScope);
    return prepared;
  } catch (error) {
    releaseCursorBlobRequestScope(requestScope);
    throw error;
  }
}

/** Back-compat wrapper: callers that only need the wire bytes. */
export function encodeCursorRunRequest(request: CursorRunRequest): Uint8Array {
  return prepareCursorRunRequest(request).bytes;
}
