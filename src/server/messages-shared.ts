/**
 * Accounting and measurement pieces shared by the two Claude Messages lanes.
 *
 * claude-messages.ts (caller-credential passthrough and translate-and-replay) and
 * messages-native.ts (the proxy-managed native lane) both need this layer, and
 * neither may import the other. It once closed a cycle: messages-native.ts took this
 * code statically from claude-messages.ts while claude-messages.ts reached back
 * dynamically to dispatch, so every install that only serves caller-forward
 * passthrough still loaded the whole native lane.
 *
 * Everything here is a leaf: lib/, adapters/ primitives, and types only. Nothing
 * reaches another server/ module, so either lane can take it without pulling in the
 * other.
 */
import { sniffImageDimensions } from "../adapters/anthropic-image-guard";
import { createToolCallIdAllocator } from "../adapters/tool-call-id";
import { idleDeadline } from "../lib/abort";
import {
  CLAUDE_NATIVE_THINKING,
  projectClaudeRequest,
  type ClaudeThinkingProjection,
} from "../lib/claude-request-projection";
import { redactSecretString } from "../lib/redact";
import { sseFieldValue } from "../lib/sse-decoder";
import { estimateTokens } from "../lib/token-estimate";
import { isTranslatorBudgetExceededError } from "../lib/translator-budget";
import { AnthropicRequestError, isRec, type Rec } from "../claude/inbound-records";
import type { RequestLogContext } from "./request-log";
import { recordGenerationEvent } from "./request-log-generation-window";
import type { OcxConfig } from "../types";

export function anthropicUsageToOcx(usage: Rec | undefined): { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } | undefined {
  if (!usage) return undefined;
  const num = (v: unknown) => typeof v === "number" ? v : 0;
  const hasCache = usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  const read = num(usage.cache_read_input_tokens);
  const write = num(usage.cache_creation_input_tokens);
  // Anthropic input_tokens excludes cache read/write; normalize to the canonical
  // inclusive convention (types.ts OcxUsage / devlog 070). cached = READS only.
  return {
    inputTokens: num(usage.input_tokens) + read + write,
    outputTokens: num(usage.output_tokens),
    ...(hasCache ? {
      cachedInputTokens: read,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: write,
    } : {}),
  };
}

/** Body-occupancy guard for the native passthrough (devlog 260716_passthrough_followups/010). */
export interface PassthroughBodyGuard {
  /** Idle window in ms — raw upstream-byte inactivity while a read is pending. 0 disables. */
  stallMs: number;
  /** Cumulative body byte cap. 0 disables. */
  maxBytes: number;
  /** Client request signal for deterministic cancel classification. */
  reqSignal?: AbortSignal;
}

export type PassthroughCloseReason = "terminal" | "client_cancel" | "body_stall" | "body_overflow";
export type PassthroughFinalizeMeta = { closeReason: PassthroughCloseReason; terminalStatus?: "failed" | "incomplete" };

/**
 * Tap an Anthropic-vocabulary SSE stream for the request log (usage + terminal),
 * bounding body occupancy: idle (silence-only, timed ONLY while a reader.read() is
 * pending so downstream backpressure never counts as upstream inactivity) and a
 * cumulative byte cap. On stall/overflow, or when the upstream read fails after the
 * headers went out, it appends a protocol-compatible Anthropic `event: error` terminal
 * frame after a blank-line boundary, closes, and cancels the upstream reader — never a
 * total-wall-clock bound (slow-but-alive streams live).
 * Exported for deterministic unit tests.
 */
export function tapAnthropicSseForLog(
  upstream: ReadableStream<Uint8Array>,
  logCtx: RequestLogContext,
  finalize: (status: number, meta: PassthroughFinalizeMeta) => void,
  guard?: PassthroughBodyGuard,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let usageAcc: Rec = {};
  // message_stop or an upstream error event: the turn's own terminal already went through.
  let terminalSeen = false;
  const inspectFrame = (frame: string) => {
    const dataLine = frame
      .split("\n")
      .map(l => sseFieldValue(l, "data"))
      .filter((v): v is string => v !== null)
      .join("");
    if (!dataLine) return;
    let data: unknown;
    try { data = JSON.parse(dataLine); } catch { return; }
    if (!isRec(data)) return;
    recordGenerationEvent(logCtx, data.type);
    if (data.type === "message_start" && isRec(data.message) && isRec(data.message.usage)) {
      usageAcc = { ...usageAcc, ...data.message.usage };
    } else if (data.type === "message_delta" && isRec(data.usage)) {
      usageAcc = { ...usageAcc, ...data.usage };
    } else if (data.type === "message_stop" || data.type === "error") {
      terminalSeen = true;
    }
  };
  const inspect = (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    // SSE lines may end in CRLF, LF or CR. Normalize the inspection copy to LF (the forwarded
    // bytes are untouched), holding a trailing CR until the next chunk shows whether an LF
    // follows it, so a CRLF split across chunks stays one line ending.
    const heldCr = buffer.endsWith("\r");
    buffer = (heldCr ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n") + (heldCr ? "\r" : "");
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      inspectFrame(frame);
    }
  };
  // The last block can sit in the buffer without its blank line: an upstream that stopped after
  // it, or a held trailing CR. Count it before deciding how the turn ended (the Responses relay
  // flushes the same candidate). Returns true when this flush found the terminal in a block the
  // client has not seen a blank line after, so the caller restores one.
  const flushTail = (): boolean => {
    const terminalBefore = terminalSeen;
    const tail = (buffer + decoder.decode()).replace(/\r\n?/g, "\n");
    buffer = "";
    if (tail) inspectFrame(tail);
    return terminalSeen && !terminalBefore && !tail.endsWith("\n\n");
  };
  const reader = upstream.getReader();
  let settled = false;
  let bodyBytes = 0;
  let tapController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const recordUsage = () => {
    logCtx.usage = anthropicUsageToOcx(Object.keys(usageAcc).length > 0 ? usageAcc : undefined);
  };
  const closeWithErrorFrame = (errType: string, message: string) => {
    const payload = JSON.stringify({ type: "error", error: { type: errType, message } });
    try {
      // Leading blank line terminates any partial SSE block so the frame parses cleanly
      // (relaySseWithFailedTail policy, Anthropic wire shape).
      tapController?.enqueue(encoder.encode(`\n\nevent: error\ndata: ${payload}\n\n`));
      tapController?.close();
    } catch { /* client already torn down */ }
  };
  const failBody = (closeReason: "body_stall" | "body_overflow", errType: string, message: string) => {
    if (settled) return;
    settled = true;
    idle.cancel();
    detachAbort();
    const terminalInTail = flushTail();
    recordUsage();
    if (terminalSeen) {
      // The turn already ended (message_stop or an upstream error event): an upstream that then
      // idles or keeps sending did not cut it short. Same rule as the read-error branch,
      // including the restored blank line for a terminal found only in the tail.
      finalize(200, { closeReason: "terminal" });
      try {
        if (terminalInTail) tapController?.enqueue(encoder.encode("\n\n"));
        tapController?.close();
      } catch { /* client already torn down */ }
    } else {
      // A cut-short turn, logged as the Responses relay logs a stall-timeout incomplete
      // (httpStatusForRequestLogTerminal: only a max_output_tokens incomplete is a 200). A 200
      // row with no terminalStatus also lost its failure diagnostics in usage.jsonl.
      logCtx.upstreamError = message.slice(0, 500);
      finalize(502, { terminalStatus: "incomplete", closeReason });
      closeWithErrorFrame(errType, message);
    }
    reader.cancel(new DOMException(message, closeReason === "body_stall" ? "TimeoutError" : "QuotaExceededError")).catch(() => {});
  };
  const idle = idleDeadline(guard?.stallMs ?? 0, () => {
    failBody(
      "body_stall",
      "timeout_error",
      `anthropic passthrough body stalled: no upstream bytes for ${Math.round((guard?.stallMs ?? 0) / 1000)}s`,
    );
  });
  // Deterministic client-cancel classification: Bun may surface a client abort as a
  // reader.read() rejection OR a resolved done (src/lib/abort.ts cancelBodyOnAbort
  // rationale), so the listener performs first-wins settlement itself instead of
  // relying on which shape the read takes.
  const onClientAbort = () => {
    if (settled) return;
    settled = true;
    idle.cancel();
    detachAbort();
    finalize(499, { closeReason: "client_cancel" });
    try { tapController?.close(); } catch { /* downstream already torn down */ }
    reader.cancel(guard?.reqSignal?.reason).catch(() => {});
  };
  const detachAbort = (() => {
    const signal = guard?.reqSignal;
    if (!signal) return () => {};
    if (signal.aborted) {
      queueMicrotask(onClientAbort);
      return () => {};
    }
    signal.addEventListener("abort", onClientAbort, { once: true });
    return () => signal.removeEventListener("abort", onClientAbort);
  })();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      tapController = controller;
    },
    async pull(controller) {
      if (settled) return;
      try {
        idle.reset();
        const { done, value } = await reader.read();
        idle.pause();
        if (settled) return; // stall/overflow/abort won the race while we awaited
        if (done) {
          settled = true;
          idle.cancel();
          detachAbort();
          recordUsage();
          finalize(200, { closeReason: "terminal" });
          controller.close();
          return;
        }
        if (value.byteLength > 0) {
          bodyBytes += value.byteLength;
          if (guard && guard.maxBytes > 0 && bodyBytes > guard.maxBytes) {
            failBody(
              "body_overflow",
              "api_error",
              `anthropic passthrough body exceeded ${guard.maxBytes} bytes`,
            );
            return;
          }
        }
        inspect(value);
        controller.enqueue(value);
      } catch (err) {
        if (settled) return;
        // Bun can settle a fetch body read before it dispatches the abort listeners
        // (consumeForInspection in relay.ts): read the signal itself before calling this
        // rejection an upstream failure.
        if (guard?.reqSignal?.aborted) {
          onClientAbort();
          return;
        }
        settled = true;
        idle.cancel();
        detachAbort();
        const terminalInTail = flushTail();
        recordUsage();
        if (isTranslatorBudgetExceededError(err)) {
          // A local cap, not an upstream failure: the non-streaming native Messages fold
          // maps this error to a 413 itself, so it still errors the stream.
          finalize(200, { closeReason: "terminal" });
          try { controller.error(err); } catch { /* torn down */ }
          return;
        }
        if (terminalSeen) {
          // Only the transport trailer was lost; the client already has the turn's terminal.
          // The Responses relay likewise reports a read error only without a seen terminal.
          finalize(200, { closeReason: "terminal" });
          try {
            // An SSE parser drops an event that EOF cuts off before its blank line, so restore
            // the delimiter when the terminal was only found in that unterminated tail.
            if (terminalInTail) controller.enqueue(encoder.encode("\n\n"));
            controller.close();
          } catch { /* torn down */ }
          reader.cancel(err).catch(() => {});
          return;
        }
        // The upstream read failed after the 200 went out (a mid-stream socket reset). Log it
        // the way the Responses relay does (onReadError): a truncated body is a failed turn,
        // not a completed one. The client gets the same Anthropic error terminal as a stall,
        // instead of a connection reset — or, on some Bun releases, a bare EOF that reads as
        // a finished message.
        const message = redactSecretString(`anthropic passthrough upstream stream failed: ${err instanceof Error ? err.message : String(err)}`);
        logCtx.transportPhase = "mid_stream";
        logCtx.terminalSource = "synthetic";
        logCtx.upstreamError = message.slice(0, 500);
        if (logCtx.activeAttempt) logCtx.activeAttempt.streamAborted = true;
        finalize(502, { terminalStatus: "failed", closeReason: "terminal" });
        closeWithErrorFrame("api_error", message);
        reader.cancel(err).catch(() => {});
      }
    },
    cancel(reason) {
      if (!settled) {
        settled = true;
        idle.cancel();
        detachAbort();
        finalize(499, { closeReason: "client_cancel" });
      }
      reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * `tool_use.id` / `tool_result.tool_use_id` must match Anthropic's wire contract
 * (`^[a-zA-Z0-9_-]+$`, <=64 chars). Third-party models mint other shapes — Devin's
 * swe-2 emits `Bash:0#<hex>` — and a session history carrying them 400s the moment it
 * is switched to a native Anthropic model ("messages.N.content.M.tool_use.id: String
 * should match pattern"). The adapter path normalizes these via
 * adapters/tool-call-id.ts (#1780); this passthrough bypasses that adapter, so the same
 * allocator runs here. Stateless per request: conforming ids pass through byte-identical
 * (prompt-cache keys untouched), rewritten ids keep call/result pairing stable.
 * An empty id has no representable wire form, and forwarding `""` is what Anthropic
 * rejects (#1767), so the request fails locally with a 400 before any upstream fetch.
 */
export function sanitizePassthroughToolCallIds(messages: unknown[]): void {
  const blocks: Rec[] = [];
  for (const message of messages) {
    if (!isRec(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) if (isRec(block)) blocks.push(block);
  }
  const fieldOf = (block: Rec): "id" | "tool_use_id" | undefined => {
    if (typeof block.type !== "string") return undefined;
    if (block.type.endsWith("tool_use")) return "id";
    if (block.type.endsWith("tool_result")) return "tool_use_id";
    return undefined;
  };
  const callIds = createToolCallIdAllocator();
  for (const block of blocks) {
    const field = fieldOf(block);
    if (field && typeof block[field] === "string") callIds.reserve(block[field] as string);
  }
  for (const block of blocks) {
    const field = fieldOf(block);
    if (!field || typeof block[field] !== "string") continue;
    const wire = callIds.allocate(block[field] as string);
    if (wire === undefined) throw new AnthropicRequestError(`${block.type} block has an empty ${field}`);
    block[field] = wire;
  }
}

const DEFAULT_BODY_STALL_SEC = 90;
const DEFAULT_BODY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Normalize the claudeCode body-guard config (devlog 260716_passthrough_followups/010).
 * Policy: exactly 0 disables; finite positive values are honored (stall clamped to
 * min 1s); negative/non-finite/absent values fall back to the defaults.
 */
export function resolvePassthroughBodyGuard(config: OcxConfig, reqSignal?: AbortSignal): PassthroughBodyGuard {
  const rawSec = config.claudeCode?.bodyStallSec;
  const stallSec = rawSec === 0
    ? 0
    : typeof rawSec === "number" && Number.isFinite(rawSec) && rawSec > 0
      ? Math.max(1, rawSec)
      : DEFAULT_BODY_STALL_SEC;
  const rawBytes = config.claudeCode?.bodyMaxBytes;
  const maxBytes = rawBytes === 0
    ? 0
    : typeof rawBytes === "number" && Number.isFinite(rawBytes) && rawBytes > 0
      ? Math.floor(rawBytes)
      : DEFAULT_BODY_MAX_BYTES;
  return { stallMs: stallSec * 1000, maxBytes, ...(reqSignal ? { reqSignal } : {}) };
}

/** Per-attachment token estimate for a base64 payload: real image dimensions when the
 * header is sniffable (Anthropic prices images at ~pixels/750), else decoded bytes/512,
 * min 256 — the same shape as the Kiro usage estimator (estimateKiroImageTokens). */
function estimateBase64AttachmentTokens(data: string): number {
  const dims = sniffImageDimensions(data);
  if (dims) return Math.max(256, Math.ceil((dims.width * dims.height) / 750));
  const unpadded = data.endsWith("==") ? data.length - 2 : data.endsWith("=") ? data.length - 1 : data.length;
  return Math.max(256, Math.ceil(Math.floor((unpadded * 3) / 4) / 512));
}

/**
 * Char-based token estimate for an Anthropic-shaped request body. Base64 attachment
 * payloads (image/document blocks in message content, including blocks nested in
 * tool_result.content) are counted as a bounded per-attachment estimate instead of raw
 * characters: one 2MB screenshot is ~2.7M base64 chars, which the plain chars/token
 * divide reports as hundreds of thousands of tokens versus a real cost around 1.6k.
 * That breaks the >2x drift bound the estimator is held to (devlog 260711_claude_inbound
 * 040 §3); a live 260-message turn whose replayed thinking was 78.8% of the body breached
 * it at 3.28x, which is why the estimate is projected onto the settled route. Text and url
 * sources are left in place and counted as characters, as is
 * anything outside protocol content positions (tool_use.input, tool schemas).
 *
 * `thinking` selects which replayed thinking fields the SETTLED route serializes, so the measure
 * describes the prompt this proxy forwards rather than the one the caller typed. Omitted, the
 * whole body counts — correct for the Anthropic-native wire, where nothing is projected away.
 * See `claude-request-projection.ts` for why a routed wire must project it out.
 */
export function estimateClaudeRequestTokens(
  raw: { system?: unknown; messages?: unknown; tools?: unknown },
  modelId: string | undefined,
  thinking: ClaudeThinkingProjection = CLAUDE_NATIVE_THINKING,
): number {
  let attachmentTokens = 0;
  // Blank base64 payloads ONLY in protocol content positions: message content blocks and
  // blocks nested in tool_result.content. tool_use.input and tool schemas can legitimately
  // contain attachment-shaped JSON, and those bytes ARE serialized into function_call
  // arguments / tool definitions for routed providers, so they must keep counting as text.
  // system is text-only per the Anthropic protocol (no attachment sources), so it is
  // stringified as-is.
  const sanitizeBlock = (block: unknown): unknown => {
    if (!block || typeof block !== "object") return block;
    const b = block as Record<string, unknown>;
    if (b.type === "image" || b.type === "document") {
      const source = b.source as { type?: unknown; data?: unknown } | undefined;
      if (source && typeof source === "object" && source.type === "base64" && typeof source.data === "string") {
        attachmentTokens += estimateBase64AttachmentTokens(source.data);
        return { ...b, source: { ...(source as Record<string, unknown>), data: "" } };
      }
      return block;
    }
    if (b.type === "tool_result" && Array.isArray(b.content)) {
      return { ...b, content: (b.content as unknown[]).map(sanitizeBlock) };
    }
    return block;
  };
  const sanitizedMessages = (messages: unknown): unknown =>
    Array.isArray(messages)
      ? messages.map(message => {
          if (!message || typeof message !== "object") return message;
          const m = message as Record<string, unknown>;
          return Array.isArray(m.content) ? { ...m, content: (m.content as unknown[]).map(sanitizeBlock) } : message;
        })
      : messages;
  const parts: string[] = [];
  if (raw.system !== undefined) parts.push(typeof raw.system === "string" ? raw.system : JSON.stringify(raw.system));
  if (raw.messages !== undefined) {
    const projected = projectClaudeRequest(raw, thinking);
    parts.push(JSON.stringify(sanitizedMessages(projected.messages)));
  }
  if (raw.tools !== undefined) parts.push(JSON.stringify(raw.tools));
  return Math.max(1, estimateTokens(parts.join("\n"), modelId) + attachmentTokens);
}
