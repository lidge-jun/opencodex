import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxUsage } from "../../types";

/**
 * Shared stream-json protocol for official coding-agent CLIs (CodeBuddy Code and Qoder CLI).
 *
 * The vendor speaks the Anthropic/Claude-Code `stream-json` protocol ("the naming and protocol
 * align with Anthropic Claude Code v2.1.88"). A headless turn is a newline-delimited JSON stream on stdout:
 *
 *   {"type":"system","subtype":"init", ...}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta",...}}}   (with --include-partial-messages)
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text"|"thinking"|"tool_use",...}]}}
 *   {"type":"result","subtype":"success","is_error":false,"usage":{...},"total_cost_usd":...,"session_id":...}
 *
 * Diagnostics ride stderr and are NOT protocol data. This module is pure: it never spawns a process
 * and never touches the network, so it is unit-testable against captured fixtures.
 */

/** Hard ceiling on a single buffered stdout line, so a runaway frame cannot exhaust memory. */
export const MAX_STREAM_LINE_BYTES = 8 * 1024 * 1024;
/** Hard ceiling on the total stdout bytes consumed for one turn. */
export const MAX_STREAM_TOTAL_BYTES = 64 * 1024 * 1024;
/** Hard ceiling on projected conversation history text (characters) to prevent runaway memory. */
export const MAX_PROJECTED_HISTORY_CHARS = 200_000;

export class CodingAgentStreamLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingAgentStreamLimitError";
  }
}

export class CodingAgentProtocolError extends Error {
  readonly code: string = "protocol_error";
  readonly status: number = 502;
  constructor(message: string) {
    super(message);
    this.name = "CodingAgentProtocolError";
  }
}

/** A parsed protocol frame. */
export type StreamMessage = Record<string, unknown>;

/**
 * Split an async byte stream into JSONL frames.
 *
 * Handles the streaming hazards the task calls out (§二十五): fragmented JSON across chunks, split
 * multi-byte UTF-8 (via the decoder's `stream` mode), partial trailing lines, and multiple frames in
 * one chunk. A non-empty frame that does not parse to a JSON record fails closed so corrupted
 * protocol output cannot be mistaken for a successful response.
 */
export async function* readJsonLines(
  chunks: AsyncIterable<Uint8Array>,
  limits: { maxLineBytes?: number; maxTotalBytes?: number } = {},
): AsyncGenerator<StreamMessage> {
  const maxLineBytes = limits.maxLineBytes ?? MAX_STREAM_LINE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_STREAM_TOTAL_BYTES;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let totalBytes = 0;

  const flushLine = function* (line: string): Generator<StreamMessage> {
    if (encoder.encode(line).byteLength > maxLineBytes) {
      throw new CodingAgentStreamLimitError("Coding-agent stream line exceeded the byte ceiling");
    }
    const trimmed = line.trim();
    if (!trimmed) return; // Blank lines and whitespace-only lines are ignored as padding.
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const snippet = trimmed.slice(0, 64).replace(/[\r\n]+/g, " ");
      throw new CodingAgentProtocolError(
        `Malformed stream-json frame received from coding-agent CLI: ${snippet}`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const snippet = trimmed.slice(0, 64).replace(/[\r\n]+/g, " ");
      throw new CodingAgentProtocolError(
        `Non-object stream-json frame received from coding-agent CLI: ${snippet}`,
      );
    }
    yield parsed as StreamMessage;
  };

  for await (const chunk of chunks) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new CodingAgentStreamLimitError("Coding-agent stream exceeded the total byte ceiling");
    }
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      yield* flushLine(line);
      newline = buffer.indexOf("\n");
    }
    if (encoder.encode(buffer).byteLength > maxLineBytes) {
      throw new CodingAgentStreamLimitError("Coding-agent stream line exceeded the byte ceiling");
    }
  }
  // Flush the decoder's trailing bytes and any final line without a newline terminator.
  buffer += decoder.decode();
  if (buffer.trim()) yield* flushLine(buffer);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Extract OpenCodex usage from a `result` frame's Anthropic-shaped usage object. */
export function usageFromResult(message: StreamMessage): OcxUsage | undefined {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const cachedInputTokens = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined;
  const cacheCreationInputTokens =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined;
  if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens, cacheReadInputTokens: cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
  };
}

/**
 * Mutable per-turn parse state shared across frames of one stream (§十二).
 * Thinking and text states are strictly decoupled.
 */
export interface StreamParseState {
  sawPartialText: boolean;
  sawPartialThinking: boolean;
  sawTerminalResult: boolean;
  openToolCallId?: string;
}

/**
 * Map ONE protocol frame to zero or more AdapterEvents.
 *
 * Token-level streaming comes from `stream_event` frames (enabled by `--include-partial-messages`);
 * the complete `assistant` frame is only used as a fallback when no partial deltas were seen, so text
 * and thinking are never emitted twice.
 */
export function mapStreamMessageToEvents(message: StreamMessage, state: StreamParseState): AdapterEvent[] {
  const type = asString(message.type);
  const events: AdapterEvent[] = [];

  if (type === "stream_event") {
    const event = asRecord(message.event);
    if (event) events.push(...mapRawStreamEvent(event, state));
    return events;
  }

  if (type === "assistant") {
    // Fallback path: a complete assistant message. Surface text and thinking independently
    // only when the partial delta stream did not already carry them (§十二).
    const content = asRecord(message.message)?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const part = asRecord(block);
        if (!part) continue;
        const blockType = asString(part.type);
        if (blockType === "text" && !state.sawPartialText) {
          const text = asString(part.text);
          if (text) events.push({ type: "text_delta", text });
        } else if (blockType === "thinking" && !state.sawPartialThinking) {
          const thinking = asString(part.thinking);
          if (thinking) events.push({ type: "thinking_delta", thinking });
        }
      }
    }
    return events;
  }

  if (type === "result") {
    const isError = message.is_error === true || asString(message.subtype) === "error_during_execution";
    const usage = usageFromResult(message);
    if (isError) {
      const errors = Array.isArray(message.errors)
        ? message.errors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const detail = asString(message.result) || errors[0] || "Coding-agent CLI ended the turn with an execution error";
      const vendorCode = typeof message.error_code === "number" ? message.error_code : undefined;
      // Qoder documents code 118 and emits the "credit usage limit" wording. Keep the
      // match deliberately narrow so other coding-agent CLIs retain their established
      // generic-upstream handling for ambiguous text such as "insufficient credits".
      const insufficientQuota = vendorCode === 118 || /credit usage limit/i.test(detail);
      const authentication = /not logged in|invalid (?:personal access )?token|authentication/i.test(detail);
      const rateLimited = !insufficientQuota && /rate limit|too many requests/i.test(detail);
      const modelUnavailable = /model (?:is )?(?:not found|unavailable|unsupported)|invalid model/i.test(detail);
      events.push({
        type: "error",
        message: detail,
        status: insufficientQuota || rateLimited ? 429 : authentication ? 401 : modelUnavailable ? 400 : 502,
        errorType: insufficientQuota
          ? "insufficient_quota"
          : rateLimited
            ? "rate_limit_error"
            : authentication
              ? "authentication_error"
              : modelUnavailable
                ? "invalid_request_error"
                : "upstream_error",
        code: insufficientQuota
          ? "insufficient_quota"
          : rateLimited
            ? "rate_limit_exceeded"
            : authentication
              ? "invalid_api_key"
              : modelUnavailable
                ? "model_not_found"
                : "upstream_error",
        retryable: rateLimited,
        ...(usage ? { usage } : {}),
      });
      return events;
    }
    state.sawTerminalResult = true;
    events.push({ type: "done", ...(usage ? { usage } : {}), stopReason: "stop" });
    return events;
  }

  // system/init, user echoes, task_* background events: not client-visible output.
  return events;
}

/** Map a raw Anthropic SSE event (carried inside a `stream_event` frame) to AdapterEvents. */
function mapRawStreamEvent(event: StreamMessage, state: StreamParseState): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  const eventType = asString(event.type);

  if (eventType === "content_block_delta") {
    const delta = asRecord(event.delta);
    const deltaType = asString(delta?.type);
    if (deltaType === "text_delta") {
      const text = asString(delta?.text);
      if (text) {
        state.sawPartialText = true;
        events.push({ type: "text_delta", text });
      }
    } else if (deltaType === "thinking_delta") {
      const thinking = asString(delta?.thinking);
      if (thinking) {
        state.sawPartialThinking = true;
        events.push({ type: "thinking_delta", thinking });
      }
    } else if (deltaType === "input_json_delta") {
      // Tool-input streaming. Inert while tools are disabled (Codex's catalog is not advertised),
      // but parsed so the seam is ready and an unexpected frame never crashes.
      const partial = asString(delta?.partial_json);
      if (partial && state.openToolCallId) events.push({ type: "tool_call_delta", arguments: partial });
    }
    return events;
  }

  if (eventType === "content_block_start") {
    const block = asRecord(event.content_block);
    if (asString(block?.type) === "tool_use") {
      const id = asString(block?.id) ?? "";
      const name = asString(block?.name) ?? "tool";
      if (id) {
        state.openToolCallId = id;
        events.push({ type: "tool_call_start", id, name });
      }
    }
    return events;
  }

  if (eventType === "content_block_stop") {
    if (state.openToolCallId) {
      state.openToolCallId = undefined;
      events.push({ type: "tool_call_end" });
    }
    return events;
  }

  return events;
}

/** One content part on the stream-json input wire (Anthropic message shape). */
type WireContentPart = Record<string, unknown>;

function textPart(text: string): WireContentPart {
  return { type: "text", text };
}

/** Encode an OpenCodex image content part as an Anthropic base64/url image block; never drop it. */
function imagePart(imageUrl: string): WireContentPart | undefined {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(imageUrl);
  if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  if (/^https?:\/\//i.test(imageUrl)) return { type: "image", source: { type: "url", url: imageUrl } };
  return undefined;
}

function formatMessageForHistory(message: OcxMessage): string {
  if (message.role === "user") {
    const text = typeof message.content === "string"
      ? message.content
      : message.content.map(p => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
    return `USER:\n${text}`;
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim()) {
        parts.push(part.text.trim());
      } else if (part.type === "thinking" && part.thinking.trim()) {
        parts.push(`[Thinking: ${part.thinking.trim()}]`);
      } else if (part.type === "toolCall") {
        const args = JSON.stringify(part.arguments ?? {});
        parts.push(`[Tool call: ${part.name} (call_id: ${part.id}) with args: ${args}]`);
      }
    }
    return `ASSISTANT:\n${parts.join("\n") || "(empty response)"}`;
  }
  if (message.role === "toolResult") {
    const text = typeof message.content === "string"
      ? message.content
      : message.content.map(p => (p.type === "text" ? p.text : "[image]")).join("");
    const status = message.isError ? " (error)" : "";
    return `TOOL RESULT (call_id: ${message.toolCallId})${status}:\n${text}`;
  }
  return "";
}

/**
 * Format an isolated OpenCodex message into stream-json user message input lines.
 *
 * In stream-json mode, the official CLI stdin parser (`StreamJsonUtils.parseUserMessage`) only
 * accepts `type: "user"` frames. Writing undocumented `type: "assistant"` frames is rejected.
 * Non-user messages are therefore projected into valid user frames.
 */
export function buildInputLines(message: OcxMessage): string[] {
  if (message.role === "developer") return [];

  const content: WireContentPart[] = [];
  if (message.role === "user") {
    if (typeof message.content === "string") {
      content.push(textPart(message.content));
    } else {
      for (const part of message.content) {
        if (part.type === "text") content.push(textPart(part.text));
        else if (part.type === "image") {
          const image = imagePart(part.imageUrl);
          if (image) content.push(image);
        } else {
          content.push(textPart("[video]"));
        }
      }
    }
  } else {
    const formatted = formatMessageForHistory(message);
    if (formatted) content.push(textPart(formatted));
  }

  return content.length > 0 ? [JSON.stringify({ type: "user", message: { role: "user", content } })] : [];
}

/** Fold the request's system + developer prompts into one system-prompt string. */
export function buildSystemPrompt(parsed: OcxParsedRequest): string | undefined {
  const parts: string[] = [];
  for (const line of parsed.context.systemPrompt ?? []) {
    if (line && line.trim()) parts.push(line);
  }
  for (const message of parsed.context.messages) {
    if (message.role !== "developer") continue;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.map(part => (part.type === "text" ? part.text : "")).join("");
    if (text.trim()) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Build the ordered stream-json input lines for a turn (Strategy C: Legal user-message projection).
 *
 * In stream-json mode, the vendor CLI stdin parser strictly accepts `type: "user"` frames
 * (`{"type":"user","message":{"role":"user","content":...}}`).
 * Undocumented `{"type":"assistant",...}` frames are dropped by the vendor parser.
 *
 * Multi-turn history (user, assistant, tool results) is projected into a legal user message:
 * prior conversation turns are structured as bounded context text with tool results as text,
 * clearly demarcated from the current user request. Codex retains tool control; vendor tools are never invoked.
 */
export function buildConversationInput(parsed: OcxParsedRequest): string[] {
  const nonDev = parsed.context.messages.filter(m => m.role !== "developer");
  if (nonDev.length === 0) {
    return [JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "" }] } })];
  }

  if (nonDev.length === 1 && nonDev[0]!.role === "user") {
    return buildInputLines(nonDev[0]!);
  }

  // Multi-turn conversation or history with tool results:
  const historyMessages = nonDev.slice(0, -1);
  const currentMessage = nonDev[nonDev.length - 1]!;

  const imageBlocks: WireContentPart[] = [];
  let currentRequestText = "";

  if (currentMessage.role === "user") {
    if (typeof currentMessage.content === "string") {
      currentRequestText = currentMessage.content;
    } else {
      const textParts: string[] = [];
      for (const part of currentMessage.content) {
        if (part.type === "text") textParts.push(part.text);
        else if (part.type === "image") {
          const image = imagePart(part.imageUrl);
          if (image) imageBlocks.push(image);
        } else {
          textParts.push("[video]");
        }
      }
      currentRequestText = textParts.join("\n");
    }
  } else if (currentMessage.role === "toolResult") {
    const text = typeof currentMessage.content === "string"
      ? currentMessage.content
      : currentMessage.content.map(p => (p.type === "text" ? p.text : "[image]")).join("");
    const status = currentMessage.isError ? " (error)" : "";
    currentRequestText = `TOOL RESULT (call_id: ${currentMessage.toolCallId})${status}:\n${text}\n\nPlease proceed based on the above tool result.`;
  } else {
    currentRequestText = formatMessageForHistory(currentMessage);
  }

  // Also collect any images from history messages so multimodal attachments are never dropped:
  for (const msg of historyMessages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "image") {
          const img = imagePart(part.imageUrl);
          if (img) imageBlocks.push(img);
        }
      }
    }
  }

  let historyText = historyMessages.map(formatMessageForHistory).filter(Boolean).join("\n\n");
  if (historyText.length > MAX_PROJECTED_HISTORY_CHARS) {
    historyText = `[Earlier conversation history truncated for length...]\n\n` +
      historyText.slice(historyText.length - MAX_PROJECTED_HISTORY_CHARS);
  }

  const combinedText = `Prior conversation context:\n\n${historyText}\n\nCurrent user request:\n\n${currentRequestText}`;

  const content: WireContentPart[] = [{ type: "text", text: combinedText }, ...imageBlocks];
  return [JSON.stringify({ type: "user", message: { role: "user", content } })];
}
