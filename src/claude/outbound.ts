/**
 * Claude Code outbound: internal /v1/responses output -> Anthropic Messages API shapes.
 *
 * Wire contract pinned in devlog/260711_claude_inbound/003_evidence.md (all Tier 2):
 *  - SSE order: message_start -> (content_block_start -> deltas -> content_block_stop)*
 *    -> message_delta -> message_stop; any number of `ping`.
 *  - thinking blocks get thinking_delta(s) then ONE synthetic signature_delta just
 *    before content_block_stop (CCR precedent: Claude Code does not verify signatures).
 *  - message_delta.usage is cumulative; message_start embeds a full message snapshot.
 *  - errors: {type:"error", error:{type,message}}; may arrive mid-stream after HTTP 200.
 */
import { createHash } from "node:crypto";
import { isTransientUpstreamStatus } from "../lib/upstream-retry";
import {
  isTranslatorBudgetExceededError,
  TRANSLATOR_MAX_TURN_BYTES,
  TranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import { sseFieldOffset, sseFieldValue } from "../lib/sse-decoder";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function reasoningIdentityDigest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Fixed-size identity that preserves protocol boundaries without retaining upstream strings. */
function boundedReasoningIdentity(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return `n${value}`;
    if (Number.isFinite(value)) return `d${value}`;
    return Number.isNaN(value) ? "dnan" : value > 0 ? "dinf" : "d-inf";
  }
  if (typeof value === "string") {
    return `s${reasoningIdentityDigest(value)}`;
  }
  if (value === null) return "z";
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (Array.isArray(value)) return `a${reasoningIdentityDigest(JSON.stringify(value) ?? "[]")}`;
  // Preserve the prior String(record) category semantics without serializing untrusted trees.
  return typeof value === "object" ? "o" : "u";
}

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** HTTP status -> Anthropic error taxonomy (010 amendment #4; full official table per devlog 100). */
export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return "invalid_request_error";
    case 401: return "authentication_error";
    case 402: return "billing_error";
    case 403: return "permission_error";
    case 404: return "not_found_error";
    case 409: return "conflict_error";
    case 413: return "request_too_large";
    case 429: return "rate_limit_error";
    case 504: return "timeout_error";
    case 529: return "overloaded_error";
    default: return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

export function anthropicErrorBody(status: number, message: string, type?: string, code?: string): Rec {
  return { type: "error", error: { type: type ?? anthropicErrorType(status), message, ...(code ? { code } : {}) } };
}

export function anthropicErrorResponse(status: number, message: string, type?: string, code?: string): Response {
  return new Response(JSON.stringify(anthropicErrorBody(status, message, type, code)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Responses usage -> Anthropic usage. Responses `input_tokens` is INCLUSIVE of cache
 * read+write (types.ts convention); Anthropic `input_tokens` excludes both, so
 * subtract the full cache detail (devlog 070 — subtracting reads only inflated the
 * non-cached input Claude Code displays by the write share).
 */
export function anthropicUsage(usage: unknown, webSearchRequests = 0): Rec {
  const u = isRec(usage) ? usage : {};
  const details = isRec(u.input_tokens_details) ? u.input_tokens_details : {};
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
  const cacheWrite = typeof details.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  return {
    input_tokens: Math.max(0, input - cached - cacheWrite),
    output_tokens: output,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
    // Only successful searches are billed/counted (Anthropic contract; Claude Code cost accounting).
    ...(webSearchRequests > 0 ? { server_tool_use: { web_search_requests: webSearchRequests } } : {}),
  };
}

function sseFrame(name: string, data: Rec): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function appendedUtf8Bytes(previous: string, previousBytes: number, fragment: string): number {
  let nextBytes = previousBytes + Buffer.byteLength(fragment);
  const previousLast = previous.charCodeAt(previous.length - 1);
  const fragmentFirst = fragment.charCodeAt(0);
  if (previousLast >= 0xd800 && previousLast <= 0xdbff
    && fragmentFirst >= 0xdc00 && fragmentFirst <= 0xdfff) {
    nextBytes -= 2;
  }
  return nextBytes;
}

/**
 * Claude Code / Anthropic WebSearch domain filters are optional and mutually exclusive.
 * Empty arrays are rejected ("ambiguous"); both fields together are rejected. Routed models
 * often emit both shapes — sanitize before Claude Code sees the tool_use / server_tool_use
 * input (issue #381).
 */
export function isClaudeWebSearchToolName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === "WebSearch" || /^web_search/i.test(trimmed);
}

function normalizeWebSearchDomainList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map(entry => entry.trim());
  return domains.length > 0 ? domains : undefined;
}

/** Strip empty domain filters; if both remain, keep `allowed_domains` and drop `blocked_domains`. */
export function sanitizeWebSearchInput(input: unknown): Rec {
  const src: Rec = isRec(input) ? { ...input } : {};
  const allowed = normalizeWebSearchDomainList(src.allowed_domains);
  const blocked = normalizeWebSearchDomainList(src.blocked_domains);
  delete src.allowed_domains;
  delete src.blocked_domains;
  if (allowed && blocked) {
    // Prefer allow-list (restrict-to) when a routed model sets both non-empty fields.
    src.allowed_domains = allowed;
  } else if (allowed) {
    src.allowed_domains = allowed;
  } else if (blocked) {
    src.blocked_domains = blocked;
  }
  return src;
}

/**
 * Map a Responses `web_search_call` item to its Anthropic pair: the server_tool_use
 * input (query/queries) and the web_search_tool_result content (hits, or the error
 * object when the search failed). Shared by the SSE and JSON translation paths.
 */
function webSearchPairFromItem(item: Rec): { id: string; input: Rec; resultContent: unknown; completed: boolean } {
  const action = isRec(item.action) ? item.action : {};
  const queries = Array.isArray(action.queries)
    ? action.queries.filter((q): q is string => typeof q === "string" && q.length > 0)
    : [];
  const query = typeof action.query === "string" ? action.query : "";
  const input = sanitizeWebSearchInput(
    queries.length > 1 ? { queries } : { query: queries[0] ?? query },
  );
  const completed = item.status !== "failed";
  let resultContent: unknown;
  if (completed) {
    const hits: Rec[] = [];
    if (Array.isArray(item.sources)) {
      for (const s of item.sources) {
        if (isRec(s) && typeof s.url === "string" && s.url.length > 0) {
          hits.push({ type: "web_search_result", title: typeof s.title === "string" ? s.title : "", url: s.url });
        }
      }
    }
    resultContent = hits;
  } else {
    resultContent = { type: "web_search_tool_result_error", error_code: "unavailable" };
  }
  const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `srvtoolu_${uuid()}`;
  return { id, input, resultContent, completed };
}

function messageSnapshot(model: string): Rec {
  return {
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content: [],
    model,
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

interface OpenBlock {
  kind: "text" | "thinking" | "tool_use";
  index: number;
  /** Responses item_id (tool calls) so output_item.done can match. */
  itemId?: string;
  /** Buffer WebSearch args and emit one sanitized input_json_delta on close (#381). */
  bufferWebSearchArgs?: boolean;
  argsBuf?: string;
  argsBufBytes?: number;
  webSearchArgsEmitted?: boolean;
  callId?: string;
  /** Last fixed-size reasoning identity (item + summary/content index) seen by this block. */
  reasoningPartKey?: string;
}

/** Streaming: Responses SSE bytes -> Anthropic Messages SSE bytes. */
export function responsesSseToAnthropicSse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  opts: { pingIntervalMs?: number; translatorBudget: TranslatorBudget },
): ReadableStream<Uint8Array> {
  const translatorBudget = opts.translatorBudget;
  const pingIntervalMs = opts?.pingIntervalMs ?? 20_000;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let bufferBytes = 0;
  let started = false;
  let terminated = false;
  let cancelled = false;
  let blockIndex = 0;
  let open: OpenBlock | null = null;
  let sawToolUse = false;
  let webSearchRequests = 0;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const utf8SliceBytes = (value: string, start: number, end: number): number => {
    let bytes = 0;
    for (let index = start; index < end; index++) {
      const codePoint = value.codePointAt(index)!;
      if (codePoint <= 0x7f) bytes += 1;
      else if (codePoint <= 0x7ff) bytes += 2;
      else if (codePoint <= 0xffff) bytes += 3;
      else { bytes += 4; index += 1; }
    }
    return bytes;
  };
  const queuedLiveFrameBytes: number[] = [];
  const releaseDeliveredFrame = () => {
    const bytes = queuedLiveFrameBytes.shift();
    if (bytes !== undefined) translatorBudget.releaseRetained(bytes, { kind: "live_transient" });
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (name: string, data: Rec) => {
        const frame = encoder.encode(sseFrame(name, data));
        const reservation = translatorBudget.reserveTransient(frame.byteLength, { kind: "live_transient" });
        controller.enqueue(frame);
        reservation.commitRetained();
        queuedLiveFrameBytes.push(frame.byteLength);
      };
      const ensureStarted = () => {
        if (started) return;
        started = true;
        emit("message_start", { type: "message_start", message: messageSnapshot(model) });
        emit("ping", { type: "ping" });
      };
      // Once a semantic Anthropic message has started, keepalive pings protect remote
      // deployments behind LB/NAT idle timeouts. Transport-only Responses prelude frames
      // must not manufacture a message before a possible initial error.
      if (pingIntervalMs > 0) {
        pingTimer = setInterval(() => {
          if (terminated || !started) return;
          try {
            emit("ping", { type: "ping" });
          } catch { /* controller torn down; the read loop is ending anyway */ }
        }, pingIntervalMs);
      }
      const closeOpenBlock = () => {
        if (!open) return;
        if (open.kind === "tool_use" && open.bufferWebSearchArgs && !open.webSearchArgsEmitted) {
          // Emit sanitized args even if output_item.done never supplied a full arguments field
          // (finish/fail paths, or deltas-only streams).
          let parsed: unknown = {};
          const rawArgs = open.argsBuf ?? "";
          try { parsed = rawArgs.length > 0 ? JSON.parse(rawArgs) : {}; } catch { parsed = {}; }
          emit("content_block_delta", {
            type: "content_block_delta",
            index: open.index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(sanitizeWebSearchInput(parsed)) },
          });
          open.webSearchArgsEmitted = true;
        }
        if (open.kind === "thinking") {
          // Synthetic signature: Claude Code accepts it (003 E6); inbound drops replays anyway.
          emit("content_block_delta", {
            type: "content_block_delta", index: open.index,
            delta: { type: "signature_delta", signature: `ocx${Date.now()}` },
          });
        }
        emit("content_block_stop", { type: "content_block_stop", index: open.index });
        if (open.callId) translatorBudget.closeCall(open.callId);
        open = null;
      };
      const ensureBlock = (kind: "text" | "thinking") => {
        ensureStarted();
        if (open && open.kind === kind) return;
        closeOpenBlock();
        const index = blockIndex++;
        const contentBlock: Rec = kind === "text"
          ? { type: "text", text: "" }
          : { type: "thinking", thinking: "", signature: "" };
        emit("content_block_start", { type: "content_block_start", index, content_block: contentBlock });
        open = { kind, index };
      };
      const finish = (stopReason: string, usage: unknown) => {
        if (terminated) return;
        terminated = true;
        ensureStarted();
        closeOpenBlock();
        emit("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: anthropicUsage(usage, webSearchRequests),
        });
        emit("message_stop", { type: "message_stop" });
      };
      // upstreamDerived: transient upstream statuses become overloaded_error so the
      // Anthropic-SDK client retries with backoff; proxy-internal exceptions stay
      // api_error — a deterministic ocx bug must not be masked as retryable
      // (devlog/_plan/260716_claudecode_hardening/020). On win32 mid-stream socket
      // resets reach the reader catch (no failed-tail relay) and stay api_error —
      // same as today, deliberate residual.
      const fail = (status: number, message: string, upstreamDerived = false, code?: string) => {
        if (terminated) return;
        terminated = true;
        if (code === "translation_buffer_limit") {
          if (open?.callId) translatorBudget.closeCall(open.callId);
          open = null;
          // No normal close frames are valid after overflow. Emit exactly one bounded
          // typed terminal without consulting the exhausted budget.
          controller.enqueue(encoder.encode(sseFrame("error", anthropicErrorBody(
            413,
            message,
            "request_too_large",
            "translation_buffer_limit",
          ))));
          return;
        }
        const type = upstreamDerived && isTransientUpstreamStatus(status) ? "overloaded_error" : undefined;
        if (!started) {
          // An initial upstream failure is an Anthropic error stream, not a partial message.
          // Do not manufacture message_start/ping before the terminal error.
          emit("error", anthropicErrorBody(status, message, type, code));
          return;
        }
        closeOpenBlock();
        emit("error", anthropicErrorBody(status, message, type, code));
      };

      const handleFrame = (eventName: string, data: Rec) => {
        switch (eventName) {
          case "response.created":
            // Transport prelude only. Start Anthropic framing on semantic output or completion.
            break;
          case "response.heartbeat":
            if (started) emit("ping", { type: "ping" });
            break;
          case "response.output_text.delta": {
            if (typeof data.delta !== "string" || data.delta.length === 0) break;
            ensureBlock("text");
            emit("content_block_delta", {
              type: "content_block_delta", index: open!.index,
              delta: { type: "text_delta", text: data.delta },
            });
            break;
          }
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": {
            if (typeof data.delta !== "string" || data.delta.length === 0) break;
            ensureBlock("thinking");
            // The JSON path joins reasoning summary/content parts with "\n\n"
            // (responsesJsonToAnthropicMessage); mirror that at part and item boundaries
            // so multi-part summaries do not glue into one run-on paragraph. Frames
            // without part indices produce a constant key and never get a separator.
            const slot = eventName === "response.reasoning_summary_text.delta"
              ? `s${boundedReasoningIdentity(data.summary_index)}`
              : `c${boundedReasoningIdentity(data.content_index)}`;
            // Upstream string metadata can be arbitrarily large. Hash strings into fixed-size
            // components while retaining item and part equality, rather than dropping item_id and
            // accidentally joining distinct malformed reasoning items.
            const partKey = `${boundedReasoningIdentity(data.item_id)}:${slot}`;
            if (open!.reasoningPartKey !== undefined && open!.reasoningPartKey !== partKey) {
              emit("content_block_delta", {
                type: "content_block_delta", index: open!.index,
                delta: { type: "thinking_delta", thinking: "\n\n" },
              });
            }
            open!.reasoningPartKey = partKey;
            emit("content_block_delta", {
              type: "content_block_delta", index: open!.index,
              delta: { type: "thinking_delta", thinking: data.delta },
            });
            break;
          }
          case "response.output_item.added": {
            const item = isRec(data.item) ? data.item : null;
            if (!item || item.type !== "function_call") break;
            ensureStarted();
            closeOpenBlock();
            sawToolUse = true;
            const index = blockIndex++;
            const name = typeof item.name === "string" ? item.name : "";
            const bufferWebSearchArgs = isClaudeWebSearchToolName(name);
            const callId = typeof item.call_id === "string" ? item.call_id : `toolu_${uuid()}`;
            emit("content_block_start", {
              type: "content_block_start", index,
              content_block: {
                type: "tool_use",
                id: callId,
                name,
                input: {},
              },
            });
            translatorBudget.openCall(callId);
            open = {
              kind: "tool_use",
              index,
              callId,
              itemId: typeof item.id === "string" ? item.id : undefined,
              bufferWebSearchArgs,
              argsBuf: "",
              argsBufBytes: 0,
              webSearchArgsEmitted: false,
            };
            break;
          }
          case "response.function_call_arguments.delta": {
            if (typeof data.delta !== "string" || data.delta.length === 0) break;
            if (!open || open.kind !== "tool_use") break;
            if (open.bufferWebSearchArgs) {
              const previous = open.argsBuf ?? "";
              const previousBytes = open.argsBufBytes ?? 0;
              const nextBytes = appendedUtf8Bytes(previous, previousBytes, data.delta);
              const scope = {
                kind: "tool_args",
                ...(open.callId ? { callId: open.callId } : {}),
              } as const;
              const reservation = translatorBudget.reserveTransient(nextBytes, scope);
              try {
                open.argsBuf = previous + data.delta;
                open.argsBufBytes = nextBytes;
                reservation.commitRetained();
                translatorBudget.releaseRetained(previousBytes, scope);
              } catch (error) {
                reservation.release();
                throw error;
              }
              break;
            }
            emit("content_block_delta", {
              type: "content_block_delta", index: open.index,
              delta: { type: "input_json_delta", partial_json: data.delta },
            });
            break;
          }
          case "response.output_item.done": {
            const item = isRec(data.item) ? data.item : null;
            if (!item) break;
            // Server-side web search (native passthrough or sidecar bridge): translate the
            // finished call into the Anthropic pair Claude Code natively parses —
            // server_tool_use (query via input_json_delta) + web_search_tool_result.
            // Never marks sawToolUse (stop_reason stays end_turn unless a real tool ran).
            if (item.type === "web_search_call") {
              ensureStarted();
              closeOpenBlock();
              const pair = webSearchPairFromItem(item);
              const toolIndex = blockIndex++;
              emit("content_block_start", {
                type: "content_block_start", index: toolIndex,
                content_block: { type: "server_tool_use", id: pair.id, name: "web_search" },
              });
              emit("content_block_delta", {
                type: "content_block_delta", index: toolIndex,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(pair.input) },
              });
              emit("content_block_stop", { type: "content_block_stop", index: toolIndex });
              const resultIndex = blockIndex++;
              emit("content_block_start", {
                type: "content_block_start", index: resultIndex,
                content_block: { type: "web_search_tool_result", tool_use_id: pair.id, content: pair.resultContent },
              });
              emit("content_block_stop", { type: "content_block_stop", index: resultIndex });
              if (pair.completed) webSearchRequests++;
              break;
            }
            if (!open) break;
            // Close the matching open block (message/reasoning items close implicitly on
            // the next block; function_call items must close here so tool input parses).
            if (open.kind === "tool_use" && item.type === "function_call") {
              if (open.bufferWebSearchArgs && !open.webSearchArgsEmitted) {
                const rawArgs = typeof item.arguments === "string" && item.arguments.length > 0
                  ? item.arguments
                  : (open.argsBuf ?? "");
                let parsed: unknown = {};
                try { parsed = rawArgs.length > 0 ? JSON.parse(rawArgs) : {}; } catch { parsed = {}; }
                emit("content_block_delta", {
                  type: "content_block_delta",
                  index: open.index,
                  delta: { type: "input_json_delta", partial_json: JSON.stringify(sanitizeWebSearchInput(parsed)) },
                });
                open.webSearchArgsEmitted = true;
              }
              closeOpenBlock();
            }
            else if (open.kind === "text" && item.type === "message") closeOpenBlock();
            else if (open.kind === "thinking" && item.type === "reasoning") closeOpenBlock();
            break;
          }
          case "response.completed": {
            const response = isRec(data.response) ? data.response : {};
            if (response.end_turn === false && !sawToolUse) {
              fail(529, "upstream turn ended without a final answer", true);
              break;
            }
            finish(sawToolUse ? "tool_use" : "end_turn", response.usage);
            break;
          }
          case "response.incomplete": {
            const response = isRec(data.response) ? data.response : {};
            const details = isRec(response.incomplete_details) ? response.incomplete_details : {};
            if (details.reason === "max_output_tokens") {
              finish("max_tokens", response.usage);
            } else if (details.reason === "content_filter") {
              finish("refusal", response.usage);
            } else {
              const message = typeof details.message === "string" && details.message.trim()
                ? details.message
                : `upstream response was incomplete${typeof details.reason === "string" ? ` (${details.reason})` : ""}`;
              fail(529, message, true);
            }
            break;
          }
          case "response.failed": {
            const response = isRec(data.response) ? data.response : {};
            const error = isRec(response.error) ? response.error : {};
            const message = typeof error.message === "string" ? error.message : "upstream request failed";
            const code = typeof error.code === "string" ? error.code : undefined;
            if (code === "translation_buffer_limit") {
              throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_TURN_BYTES);
            }
            const status = code === "translation_buffer_limit"
              ? 413
              : typeof error.status === "number" ? error.status : 500;
            // status-absent response.failed (relaySseWithFailedTail synthetic tail) defaults
            // to 500, which is in the transient set — the mid-stream reset shape maps to
            // overloaded_error by design.
            fail(
              status,
              message,
              true,
            );
            break;
          }
          default:
            break; // web_search_call / custom_tool_call / content_part frames: ignored v1
        }
      };

      reader = upstream.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const decodedReservation = translatorBudget.reserveTransient(value.byteLength, { kind: "live_transient" });
            let decodedCommitted = false;
            try {
              const fragment = decoder.decode(value, { stream: true });
              decodedReservation.commitRetained();
              decodedCommitted = true;
              const nextBufferBytes = appendedUtf8Bytes(buffer, bufferBytes, fragment);
              const appendReservation = translatorBudget.reserveTransient(nextBufferBytes, { kind: "live_transient" });
              try {
                buffer += fragment;
                appendReservation.commitRetained();
                translatorBudget.releaseRetained(bufferBytes, { kind: "live_transient" });
                bufferBytes = nextBufferBytes;
              } catch (error) {
                appendReservation.release();
                throw error;
              }
              let sep: number;
              while ((sep = buffer.indexOf("\n\n")) !== -1) {
                const rawFrameBytes = utf8SliceBytes(buffer, 0, sep);
                const residualBytes = bufferBytes - rawFrameBytes - 2;
                const rawReservation = translatorBudget.reserveTransient(rawFrameBytes, { kind: "live_transient" });
                let residualReservation: ReturnType<TranslatorBudget["reserveTransient"]> | undefined;
                try {
                  residualReservation = translatorBudget.reserveTransient(residualBytes, { kind: "live_transient" });
                  const rawFrame = buffer.slice(0, sep);
                  const residual = buffer.slice(sep + 2);
                  rawReservation.commitRetained();
                  residualReservation.commitRetained();
                  residualReservation = undefined;
                  buffer = residual;
                  translatorBudget.releaseRetained(bufferBytes, { kind: "live_transient" });
                  bufferBytes = residualBytes;
                  try {
                    let eventName = "";
                    let dataLine = "";
                    let dataLineBytes = 0;
                    try {
                      let lineStart = 0;
                      while (lineStart <= rawFrame.length) {
                        const newline = rawFrame.indexOf("\n", lineStart);
                        const lineEnd = newline === -1 ? rawFrame.length : newline;
                        // The space after the colon is optional in text/event-stream (#1170);
                        // compute the value offset the same way sseFieldValue does, without
                        // slicing the line first — the byte accounting below is keyed to
                        // offsets into rawFrame.
                        const eventOffset = sseFieldOffset(rawFrame, lineStart, lineEnd, "event");
                        const dataOffset = sseFieldOffset(rawFrame, lineStart, lineEnd, "data");
                        if (eventOffset !== -1) {
                          eventName = rawFrame.slice(eventOffset, lineEnd).trim();
                        } else if (dataOffset !== -1) {
                          const fragmentStart = dataOffset;
                          const fragmentBytes = utf8SliceBytes(rawFrame, fragmentStart, lineEnd);
                          const fragmentReservation = translatorBudget.reserveTransient(fragmentBytes, { kind: "live_transient" });
                          let fragmentCommitted = false;
                          try {
                            const fragment = rawFrame.slice(fragmentStart, lineEnd);
                            fragmentReservation.commitRetained();
                            fragmentCommitted = true;
                            const nextDataLineBytes = appendedUtf8Bytes(dataLine, dataLineBytes, fragment);
                            const dataReservation = translatorBudget.reserveTransient(nextDataLineBytes, { kind: "live_transient" });
                            try {
                              dataLine += fragment;
                              dataReservation.commitRetained();
                              translatorBudget.releaseRetained(dataLineBytes, { kind: "live_transient" });
                              dataLineBytes = nextDataLineBytes;
                            } catch (error) {
                              dataReservation.release();
                              throw error;
                            }
                          } finally {
                            if (fragmentCommitted) {
                              translatorBudget.releaseRetained(fragmentBytes, { kind: "live_transient" });
                            } else fragmentReservation.release();
                          }
                        }
                        if (newline === -1) break;
                        lineStart = newline + 1;
                      }
                      if (!dataLine) continue;
                      let data: unknown;
                      try { data = JSON.parse(dataLine); } catch { continue; }
                      if (!isRec(data)) continue;
                      // Responses-compatible gateways may omit the optional SSE event field
                      // while retaining the event name in the JSON payload's required type.
                      const resolvedEventName = eventName || (typeof data.type === "string" ? data.type : "");
                      if (!resolvedEventName || terminated) continue;
                      handleFrame(resolvedEventName, data);
                    } finally {
                      translatorBudget.releaseRetained(dataLineBytes, { kind: "live_transient" });
                    }
                  } finally {
                    translatorBudget.releaseRetained(rawFrameBytes, { kind: "live_transient" });
                  }
                } catch (error) {
                  rawReservation.release();
                  residualReservation?.release();
                  throw error;
                }
              }
            } finally {
              if (decodedCommitted) translatorBudget.releaseRetained(value.byteLength, { kind: "live_transient" });
              else decodedReservation.release();
            }
          }
          // EOF without a terminal frame is a TRUNCATION, not success (devlog 100:
          // gateways that close such streams politely hand Claude Code an empty/partial
          // turn with no retryable error — CLIProxyAPI#2189 failure pattern). Fail closed
          // with a mid-stream Anthropic error event so the client can retry.
          if (!cancelled) fail(502, "upstream stream ended before a terminal frame (truncated response)", true);
        } catch (err) {
          if (isTranslatorBudgetExceededError(err)) {
            try { await reader.cancel(err); } catch { /* already closed */ }
            fail(413, "upstream translation buffer exceeded the safe limit", false, "translation_buffer_limit");
          } else fail(500, err instanceof Error ? err.message : String(err));
        } finally {
          translatorBudget.releaseRetained(bufferBytes, { kind: "live_transient" });
          if (pingTimer !== undefined) clearInterval(pingTimer);
          reader.releaseLock();
          if (!cancelled) controller.close();
        }
      })();
    },
    pull() {
      releaseDeliveredFrame();
    },
    cancel(reason) {
      cancelled = true;
      while (queuedLiveFrameBytes.length > 0) releaseDeliveredFrame();
      if (open?.callId) translatorBudget.closeCall(open.callId);
      if (pingTimer !== undefined) clearInterval(pingTimer);
      return reader?.cancel(reason);
    },
  });
}

/** Non-streaming: /v1/responses JSON -> Anthropic message JSON. */
export function responsesJsonToAnthropicMessage(json: unknown, model: string): Rec {
  const body = isRec(json) ? json : {};
  const output = Array.isArray(body.output) ? body.output : [];
  const content: Rec[] = [];
  let sawToolUse = false;
  let webSearchRequests = 0;

  for (const raw of output) {
    if (!isRec(raw)) continue;
    switch (raw.type) {
      case "message": {
        if (!Array.isArray(raw.content)) break;
        for (const part of raw.content) {
          if (isRec(part) && part.type === "output_text" && typeof part.text === "string" && part.text.length > 0) {
            content.push({ type: "text", text: part.text });
          }
        }
        break;
      }
      case "reasoning": {
        const parts: string[] = [];
        if (Array.isArray(raw.summary)) {
          for (const s of raw.summary) {
            if (isRec(s) && typeof s.text === "string" && s.text.length > 0) parts.push(s.text);
          }
        }
        if (Array.isArray(raw.content)) {
          for (const s of raw.content) {
            if (isRec(s) && typeof s.text === "string" && s.text.length > 0) parts.push(s.text);
          }
        }
        if (parts.length > 0) {
          content.push({ type: "thinking", thinking: parts.join("\n\n"), signature: `ocx${Date.now()}` });
        }
        break;
      }
      case "function_call": {
        sawToolUse = true;
        let input: unknown = {};
        if (typeof raw.arguments === "string" && raw.arguments.length > 0) {
          try { input = JSON.parse(raw.arguments); } catch { input = {}; }
        }
        const name = typeof raw.name === "string" ? raw.name : "";
        content.push({
          type: "tool_use",
          id: typeof raw.call_id === "string" ? raw.call_id : `toolu_${uuid()}`,
          name,
          input: isClaudeWebSearchToolName(name) ? sanitizeWebSearchInput(input) : input,
        });
        break;
      }
      case "web_search_call": {
        // Server-side search: emit the Anthropic pair. Does NOT set sawToolUse.
        const pair = webSearchPairFromItem(raw);
        content.push({ type: "server_tool_use", id: pair.id, name: "web_search", input: pair.input });
        content.push({ type: "web_search_tool_result", tool_use_id: pair.id, content: pair.resultContent });
        if (pair.completed) webSearchRequests++;
        break;
      }
      default:
        break;
    }
  }

  const details = isRec(body.incomplete_details) ? body.incomplete_details : {};
  if (body.status === "incomplete"
    && details.reason !== "max_output_tokens"
    && details.reason !== "content_filter") {
    const message = typeof details.message === "string" && details.message.trim()
      ? details.message
      : `upstream response was incomplete${typeof details.reason === "string" ? ` (${details.reason})` : ""}`;
    return anthropicErrorBody(529, message, "overloaded_error");
  }
  if (body.status === "completed" && body.end_turn === false && !sawToolUse) {
    return anthropicErrorBody(529, "upstream turn ended without a final answer", "overloaded_error");
  }
  const stopReason = body.status === "incomplete" && details.reason === "max_output_tokens"
    ? "max_tokens"
    : body.status === "incomplete" && details.reason === "content_filter"
      ? "refusal"
    : sawToolUse ? "tool_use" : "end_turn";

  return {
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: anthropicUsage(body.usage, webSearchRequests),
  };
}

/**
 * Fold an Anthropic SSE stream (our own emission vocabulary) into a message JSON.
 * Used for non-streaming client requests: the internal replay always streams
 * (routed adapters do not support non-stream turns), so the translated stream is
 * aggregated here instead of translating a JSON body.
 */
export async function collectAnthropicMessage(
  stream: ReadableStream<Uint8Array>,
  model: string,
  translatorBudget: TranslatorBudget,
): Promise<Rec> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  const content: Rec[] = [];
  let openBlock: Rec | null = null;
  let toolJson = "";
  let stopReason: string | null = "end_turn";
  let usage: Rec = anthropicUsage(undefined);
  let error: Rec | null = null;
  const replaceRetained = (previous: string, next: string, kind: "live_transient" | "retained_collectors") => {
    const reservation = translatorBudget.reserveTransient(Buffer.byteLength(next), { kind });
    reservation.commitRetained();
    translatorBudget.releaseRetained(Buffer.byteLength(previous), { kind });
    return next;
  };

  const closeBlock = () => {
    if (!openBlock) return;
    // server_tool_use streams its query via input_json_delta exactly like tool_use (audit F3).
    if (openBlock.type === "tool_use" || openBlock.type === "server_tool_use") {
      try { openBlock.input = toolJson.length > 0 ? JSON.parse(toolJson) : {}; } catch { openBlock.input = {}; }
    }
    translatorBudget.chargeRetained(Buffer.byteLength(JSON.stringify(openBlock)), { kind: "retained_collectors" });
    content.push(openBlock);
    openBlock = null;
    toolJson = "";
  };

  const handle = (name: string, data: Rec) => {
    switch (name) {
      case "content_block_start":
        closeBlock();
        if (isRec(data.content_block)) openBlock = { ...data.content_block };
        break;
      case "content_block_delta": {
        const delta = isRec(data.delta) ? data.delta : {};
        if (!openBlock) break;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          const previous = typeof openBlock.text === "string" ? openBlock.text : "";
          openBlock.text = replaceRetained(previous, previous + delta.text, "retained_collectors");
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          const previous = typeof openBlock.thinking === "string" ? openBlock.thinking : "";
          openBlock.thinking = replaceRetained(previous, previous + delta.thinking, "retained_collectors");
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          openBlock.signature = delta.signature;
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          toolJson = replaceRetained(toolJson, toolJson + delta.partial_json, "retained_collectors");
        }
        break;
      }
      case "content_block_stop":
        closeBlock();
        break;
      case "message_delta": {
        const delta = isRec(data.delta) ? data.delta : {};
        if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        if (isRec(data.usage)) usage = data.usage;
        break;
      }
      case "error":
        error = data;
        break;
      default:
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = replaceRetained(buffer, buffer + decoder.decode(value, { stream: true }), "live_transient");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = replaceRetained(buffer, buffer.slice(sep + 2), "live_transient");
        let eventName = "";
        let dataLine = "";
        for (const line of rawFrame.split("\n")) {
          const eventValue = sseFieldValue(line, "event");
          if (eventValue !== null) { eventName = eventValue.trim(); continue; }
          const dataValue = sseFieldValue(line, "data");
          if (dataValue !== null) dataLine += dataValue;
        }
        if (!eventName || !dataLine) continue;
        let data: unknown;
        try { data = JSON.parse(dataLine); } catch { continue; }
        if (isRec(data)) handle(eventName, data);
      }
    }
  } finally {
    reader.releaseLock();
  }
  closeBlock();

  if (error) return error;
  return {
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}
