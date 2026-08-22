import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { OcxAssistantContentPart, OcxMessage, OcxToolResultMessage } from "../../types";
import { namespacedToolName } from "../../types";
import type { CursorRunRequest } from "./types";
import { cursorNeedsExternalToolContinuation, isCursorExternalWireModel } from "./discovery";
import { normalizeCursorToolResultText } from "./tool-result-normalize";
import { debugProviderDiagnostic } from "../../lib/debug";
import {
  createCursorBlobRequestScope,
  cursorBlobMaxEntryBytes,
  releaseCursorBlobRequestScope,
  sealCursorBlobRequestScope,
  storeCursorBlob,
  type CursorBlobRequestScopeToken,
} from "./native-exec";
import { estimateTokens } from "../../lib/token-estimate";
import { parseDataUrl } from "../image";
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AssistantMessageSchema,
  AgentRunRequestSchema,
  ConversationActionSchema,
  ConversationStepSchema,
  ConversationStateStructureSchema,
  type ConversationStateStructure,
  ConversationTurnStructureSchema,
  McpArgsSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpImageContentSchema,
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

/**
 * Action text for external-model tool-result continuations. Native models keep
 * resumeAction; external wire models continue as userMessageAction so the
 * results already stored in history blobs are visible without a ResumeAction.
 */
export const CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT =
  "Continue: the requested tool results are provided in the conversation history above.";

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

function toolResultRootPayload(text: string): { role: "assistant"; content: [{ type: "text"; text: string }] } {
  return { role: "assistant", content: [{ type: "text", text }] };
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
      toolResultRootPayload(truncated),
      "toolResult",
      { messageIndex: entry.messageIndex, text: truncated },
    );
    if (result.byteLength <= maxBytes) return result;
    if (end === 0) break;
    keepBytes = Math.max(0, end - (result.byteLength - maxBytes) - 16);
  }
  const markerOnly = rootBlobCandidate(
    toolResultRootPayload(marker.trimStart()),
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
// because it travels in the action. Tool results are assistant-role text with a [Tool Result]
// or [Tool Error] marker so Cursor does not wrap them as `<user_query>` (#1992). Each entry is a SHA-256 blob ID.
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
      // #1920: the prefix must reflect the NORMALIZED error state (an empty
      // node_repl result is an error even when the runtime said isError=false).
      const prefix = normalizedToolResult(message, contentToText(message.content)).isError ? "[Tool Error]" : "[Tool Result]";
      const text = `${prefix}\n${toolResultToText(message)}`;
      entries.push(rootBlobCandidate(
        toolResultRootPayload(text),
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
      if (part.type === "image") return `[image produced by this tool, omitted from Cursor text replay: ${part.detail ?? "auto"}]`;
      return undefined;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function contentToText(content: OcxToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map(part => part.type === "text" ? part.text : `[image produced by this tool, omitted from Cursor text replay: ${part.detail ?? "auto"}]`)
    .join("\n");
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode a Codex inline image into Cursor wire bytes.
 *
 * `OcxImageContent.imageUrl` is either a `data:` URL or a remote https URL, so this cannot reuse
 * the MCP helper (which takes bare base64 plus a separate mime). It layers strict validation over
 * the shared `parseDataUrl` rather than tightening it, because Anthropic, Google, and Command Code
 * share that parser. `Buffer.from(x, "base64")` accepts many invalid strings silently, so the
 * charset is checked explicitly. Remote URLs are out of scope: `McpImageContent` needs bytes, and
 * fetching here would put network IO inside request construction.
 */
function decodeInlineImage(imageUrl: string): { bytes: Uint8Array; mimeType: string } | undefined {
  const parsed = parseDataUrl(imageUrl);
  if (!parsed) return undefined;
  const base64 = parsed.base64.trim();
  if (base64.length === 0 || base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) return undefined;
  try {
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    if (bytes.length === 0) return undefined;
    return { bytes, mimeType: parsed.mediaType || "application/octet-stream" };
  } catch {
    return undefined;
  }
}

/**
 * A degraded image must never make a step LARGER than the legacy encoding did, or this change
 * could fail admission for a request that previously fit. The old placeholder was
 * `[image input unsupported by Cursor adapter phase 3: <detail>]`; anything we emit in its place
 * is truncated to that budget so the zero-image case is byte-bounded by the pre-change behavior.
 */
const LEGACY_IMAGE_PLACEHOLDER_BUDGET =
  "[image input unsupported by Cursor adapter phase 3: auto]".length;

function imagePlaceholder(reason: string): string {
  const text = `[image omitted: ${reason}]`;
  return text.length <= LEGACY_IMAGE_PLACEHOLDER_BUDGET
    ? text
    : `${text.slice(0, LEGACY_IMAGE_PLACEHOLDER_BUDGET - 1)}]`;
}

type DecodedResultPart =
  | { kind: "text"; text: string }
  | { kind: "image"; bytes: Uint8Array; mimeType: string }
  | { kind: "undecodable" };

type NormalizedToolResult = { text: string; isError: boolean };

/**
 * Decode a tool result's parts ONCE. `toolCallStep` may re-serialize a step several times while
 * shrinking it to fit blob admission, and decoding base64 on every attempt made that loop
 * quadratic (an audit measured ~3s for 100 images).
 */
function decodeResultParts(message: OcxToolResultMessage): DecodedResultPart[] | undefined {
  const content = message.content;
  if (typeof content === "string") return undefined;
  return content.map((part): DecodedResultPart => {
    if (part.type === "text") return { kind: "text", text: part.text };
    const decoded = decodeInlineImage(part.imageUrl);
    return decoded ? { kind: "image", ...decoded } : { kind: "undecodable" };
  });
}

function countImages(parts: DecodedResultPart[] | undefined): number {
  return parts ? parts.filter(p => p.kind === "image").length : 0;
}

/**
 * Build the wire content items for a tool result, preserving part order.
 *
 * Images become real `McpImageContent` — the Cursor schema has an image case on
 * `McpToolResultContentItem`, and `native-exec-mcp.ts` already uses it for MCP-invoked tools.
 * Flattening them to placeholder text blinded every screenshot-returning tool (Computer Use,
 * browser QA) that Codex routes through this path.
 */
function toolResultContentItems(
  message: OcxToolResultMessage,
  decoded?: DecodedResultPart[],
  maxImages = Number.POSITIVE_INFINITY,
  normalizedText?: NormalizedToolResult,
) {
  const parts = decoded ?? decodeResultParts(message);
  const textItem = (text: string) => [create(McpToolResultContentItemSchema, {
    content: { case: "text" as const, value: create(McpTextContentSchema, { text }) },
  })];
  if (!parts) {
    const normalized = normalizedText
      ?? normalizedToolResult(message, typeof message.content === "string" ? message.content : "");
    return textItem(normalized.text);
  }
  const normalized = normalizedText ?? normalizedDecodedTextResult(message, parts);
  if (normalized) {
    // #1920/#1866: empty or failure-state Computer Use / node_repl results are
    // normalized before they reach the native wire. Pure-text part arrays use
    // the same newline-joined representation this serializer already emitted;
    // image-bearing and undecodable results stay on the lossless part path.
    return textItem(normalized.text);
  }
  // Images are dropped OLDEST first when the step must shrink: the most recent screenshot is the
  // one the model is reasoning about, so it is the last to go.
  const totalImages = countImages(parts);
  const allowed = Math.max(0, Math.min(totalImages, maxImages));
  let seen = 0;
  // Consecutive text runs are newline-joined into ONE item, exactly as the legacy encoding did.
  // Emitting one protobuf item per part adds per-item framing, which was enough to push a
  // previously admissible step past the blob ceiling (round-3 audit: 1020 -> 1025 bytes at a
  // 1024 limit). A result with no images must serialize identically to before this feature.
  const items: ReturnType<typeof create<typeof McpToolResultContentItemSchema>>[] = [];
  let pendingText: string[] = [];
  const flushText = () => {
    if (pendingText.length === 0) return;
    const text = pendingText.join("\n");
    pendingText = [];
    items.push(create(McpToolResultContentItemSchema, {
      content: { case: "text" as const, value: create(McpTextContentSchema, { text }) },
    }));
  };
  for (const part of parts) {
    if (part.kind === "text") {
      pendingText.push(part.text);
      continue;
    }
    if (part.kind === "undecodable") {
      pendingText.push(imagePlaceholder("no inline data"));
      continue;
    }
    seen++;
    if (seen <= totalImages - allowed) {
      pendingText.push(imagePlaceholder(`${part.bytes.byteLength}B over step limit`));
      continue;
    }
    flushText();
    items.push(create(McpToolResultContentItemSchema, {
      content: { case: "image" as const, value: create(McpImageContentSchema, {
        data: part.bytes,
        mimeType: part.mimeType,
      }) },
    }));
  }
  flushText();
  if (items.length === 0) {
    items.push(create(McpToolResultContentItemSchema, {
      content: { case: "text" as const, value: create(McpTextContentSchema, { text: "" }) },
    }));
  }
  return items;
}

function toolResultToText(message: OcxToolResultMessage): string {
  const normalized = normalizedToolResult(message, contentToText(message.content));
  return [
    "[tool_result]",
    `call_id: ${message.toolCallId}`,
    `name: ${namespacedToolName(message.toolNamespace, message.toolName)}`,
    `is_error: ${normalized.isError}`,
    "output:",
    normalized.text,
  ].join("\n");
}

/**
 * Shared #1920 normalization entry: pure-text results only. Image-bearing or
 * encrypted results pass through untouched (their content is not plain text).
 */
function normalizedToolResult(message: OcxToolResultMessage, text: string): NormalizedToolResult {
  if (message.containsEncryptedContent) return { text, isError: message.isError };
  return normalizeCursorToolResultText(text, {
    toolName: message.toolName,
    toolNamespace: message.toolNamespace,
    isError: message.isError,
  });
}

/**
 * A content-part result is plain text only when every decoded part is text (the empty array is the
 * empty text result). Join it exactly as toolResultContentItems already did, then share the string
 * normalization contract. Any image or undecodable part keeps the existing part-preserving path.
 */
function normalizedDecodedTextResult(
  message: OcxToolResultMessage,
  parts: DecodedResultPart[],
): NormalizedToolResult | undefined {
  if (parts.some(part => part.kind !== "text")) return undefined;
  return normalizedToolResult(message, parts.map(part => part.kind === "text" ? part.text : "").join("\n"));
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
  const decodedResult = result ? decodeResultParts(result) : undefined;
  const serialize = (maxImages: number): Uint8Array => toBinary(ConversationStepSchema, create(ConversationStepSchema, {
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
            ...(result ? { result: toolResultPart(result, decodedResult, maxImages) } : {}),
          }),
        },
      }),
    },
  }));

  // A step is stored as ONE blob, so its images share an entry with the call's arguments, text,
  // mime strings, and protobuf framing. A byte budget over decoded images alone cannot bound that
  // (an audit reproduced a 448-byte-argument call whose 460-byte image pushed a previously
  // admitted step past the ceiling). Measure the real serialized size instead, then drop images —
  // oldest first, so the most recent screenshot survives — until the step fits.
  const limit = cursorBlobMaxEntryBytes();
  const imageCount = countImages(decodedResult);
  let encoded = serialize(imageCount);
  for (let allowed = imageCount - 1; allowed >= 0 && encoded.byteLength > limit; allowed--) {
    encoded = serialize(allowed);
  }
  return storeCursorBlob(encoded, requestScope);
}

function toolResultPart(message: OcxToolResultMessage, decoded?: DecodedResultPart[], maxImages?: number) {
  const parts = decoded ?? decodeResultParts(message);
  const normalized = parts
    ? normalizedDecodedTextResult(message, parts)
    : normalizedToolResult(message, typeof message.content === "string" ? message.content : "");
  return create(McpToolResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, {
        isError: normalized?.isError ?? message.isError,
        content: toolResultContentItems(message, parts, maxImages, normalized),
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
        // #1920/#1866: this external-replay site bypasses toolResultToText, so it
        // must consume the normalizer directly — cursor/grok-4.6 is the exact
        // reported repro path for empty Computer Use results.
        const normalized = normalizedToolResult(message, contentToText(message.content));
        const prefix = normalized.isError ? "[Tool Error]" : "[Tool Result]";
        current.steps.push(storeCursorBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: `${prefix}\n${normalized.text}` }),
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
  const lastRawIsToolResult = request.rawMessages?.at(-1)?.role === "toolResult";
  // Native models resume the remembered Cursor conversation. External wire
  // models continue as userMessageAction so history-blob tool results stay
  // visible without a ResumeAction. Some native composer ids are also routed
  // through the external continuation path (cursorNeedsExternalToolContinuation)
  // because a bare resumeAction makes them continue exploring with native tools
  // instead of answering (observed on composer-2.5; see discovery.ts).
  const externalToolContinuation = lastRawIsToolResult && cursorNeedsExternalToolContinuation(request.modelId);
  const actionCase = (externalToolContinuation || (!lastRawIsToolResult && text.trim().length > 0))
    ? "userMessageAction"
    : "resumeAction";
  const actionText = externalToolContinuation
    ? CURSOR_EXTERNAL_TOOL_CONTINUATION_TEXT
    : text;
  const action = create(ConversationActionSchema, {
    action: actionCase === "userMessageAction"
      ? {
          case: "userMessageAction",
          value: create(UserMessageActionSchema, {
            userMessage: create(UserMessageSchema, {
              text: actionText,
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
  let continuationMode: "full-replay" | "checkpoint" = "full-replay";
  let checkpointInvalidationReason = request.checkpointInvalidationReason;
  let conversationState: ConversationStateStructure | undefined;
  let rootPromptMessagesState: ReturnType<typeof rootPromptMessages> | undefined;
  if (request.checkpointBytes && request.checkpointBytes.byteLength > 0) {
    try {
      conversationState = fromBinary(ConversationStateStructureSchema, request.checkpointBytes);
      continuationMode = "checkpoint";
      const suffixStart = request.checkpointSuffixStart;
      if (
        typeof suffixStart === "number"
        && Number.isSafeInteger(suffixStart)
        && suffixStart >= 0
        && request.rawMessages
        && suffixStart < request.rawMessages.length
      ) {
        const suffixRequest: CursorRunRequest = {
          ...request,
          system: [],
          rawMessages: request.rawMessages.slice(suffixStart),
        };
        const suffixRoots = rootPromptMessages(suffixRequest, requestScope);
        const suffixTurns = conversationTurns(suffixRequest, requestScope, suffixRoots.historyMessageStart);
        const suffixSystemCount = systemPromptBlobs(suffixRequest).length;
        const suffixHistoryIds = suffixRoots.ids.slice(suffixSystemCount);
        const suffixHistorySerialized = suffixRoots.serialized.slice(suffixSystemCount);
        conversationState = create(ConversationStateStructureSchema, {
          ...conversationState,
          rootPromptMessagesJson: [
            ...conversationState.rootPromptMessagesJson,
            ...suffixHistoryIds,
          ],
          turns: [
            ...conversationState.turns,
            ...suffixTurns,
          ],
        });
        rootPromptMessagesState = {
          ids: suffixHistoryIds,
          byteLength: suffixRoots.byteLength,
          historyMessageStart: suffixRoots.historyMessageStart,
          serialized: suffixHistorySerialized,
        };
      }
    } catch {
      checkpointInvalidationReason = "decode_failed";
    }
  }
  if (!conversationState) {
    rootPromptMessagesState = rootPromptMessages(request, requestScope);
    conversationState = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: rootPromptMessagesState.ids,
      turns: conversationTurns(request, requestScope, rootPromptMessagesState.historyMessageStart),
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [],
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      readPaths: [],
    });
  }
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
    continuationMode,
    checkpointPresent: continuationMode === "checkpoint",
    checkpointBytes: continuationMode === "checkpoint" ? request.checkpointBytes?.byteLength : undefined,
    checkpointInvalidationReason,
    rootBlobs: conversationState.rootPromptMessagesJson.length,
    rootBytes: rootPromptMessagesState?.byteLength ?? 0,
    turnBlobs: conversationState.turns.length,
    tools: request.tools?.length ?? 0,
  });

  const requestedModelParameters = [
    ...(request.requestedModelParameters ?? []),
    ...(request.routingLevel ? [{ id: CURSOR_ROUTING_LEVEL_PARAMETER_ID, value: request.routingLevel }] : []),
  ];
  const hasExplicitModelParameters = (request.requestedModelParameters?.length ?? 0) > 0;
  const runRequest = create(AgentRunRequestSchema, {
    conversationId: request.conversationId,
    conversationState,
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
    ...(rootPromptMessagesState?.serialized ?? []),
    ...(actionCase === "userMessageAction" ? [actionText] : []),
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
