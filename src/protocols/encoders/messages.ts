/**
 * AdapterEvent -> Anthropic Messages, without the internal Responses SSE (PF-09).
 *
 * The writer reproduces `responsesSseToAnthropicSse` (src/claude/outbound.ts) for the frames the
 * bridge produced: `message_start` + `ping` on the first semantic output (never before an initial
 * error), text blocks per assistant message, thinking blocks buffered until their item closes
 * and then emitted with the genuine signature or the bounded ocxr1 fallback, redacted blocks
 * ahead of the thinking block they came with, tool_use blocks with streamed `input_json_delta`
 * (WebSearch input buffered and sanitized), the server_tool_use / web_search_tool_result pair,
 * `message_delta` + `message_stop`, and mid-stream `error` frames. Pings follow the bridge's
 * wire-silence heartbeat and the converter's 20 s keepalive, only while the client has demand.
 */
import type { AdapterEvent } from "../../types";
import {
  isTranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../../lib/translator-budget";
import { isTransientUpstreamStatus } from "../../lib/upstream-retry";
import { encodeReasoningEnvelope } from "../../responses/reasoning-envelope";
import { responsesUsage, webSearchAction } from "../../bridge/internal";
import {
  anthropicErrorBody,
  anthropicErrorResponse,
  anthropicFailedStatus,
  anthropicIncompleteOutcome,
  anthropicUsage,
  boundedReasoningIdentity,
  collectAnthropicMessage,
  isClaudeWebSearchToolName,
  messageSnapshot,
  sanitizeWebSearchInput,
  sseFrame,
  webSearchPairFromItem,
} from "../../claude/outbound";
import {
  encodeAdapterEventStream,
  type AdapterEventEncodeOptions,
  type ClientFrameSink,
  type ClientWireWriter,
} from "./adapter-events";
import type { RelayedEventObservation } from "../../usage/attempt-delivery";

type Rec = Record<string, unknown>;

/** The converter's transport keepalive interval. */
const MESSAGES_KEEPALIVE_MS = 20_000;

export interface AnthropicMessageEncodeOptions extends AdapterEventEncodeOptions {
  /** The model string the client asked for; `message_start` and the folded message carry it. */
  model: string;
  /** This proxy's prompt estimate for `message_start` when no usage arrived first (#4857). */
  inputTokenFloor?: number;
}

interface OpenBlock {
  kind: "text" | "thinking" | "tool_use";
  index: number;
  bufferWebSearchArgs?: boolean;
  argsBuf?: string;
  argsBufBytes?: number;
  webSearchArgsEmitted?: boolean;
  toolArgsEmitted?: boolean;
  callId?: string;
  reasoningPartKey?: string;
  reasoningItemKey?: string;
  thinkingBuf?: string;
  thinkingBufBytes?: number;
  reasoningSig?: string;
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

function createAnthropicMessageWriter(
  sink: ClientFrameSink,
  model: string,
  inputTokenFloor: number | undefined,
): ClientWireWriter {
  const budget = sink.budget;
  let started = false;
  let terminated = false;
  // Only a delivered terminal forbids the bounded overflow error.
  let terminalDelivered = false;
  let blockIndex = 0;
  let open: OpenBlock | null = null;
  let sawToolUse = false;
  let webSearchRequests = 0;

  const emit = (name: string, data: Rec, observation?: RelayedEventObservation) => sink.emit(sseFrame(name, data), observation);
  const releaseThinkingBuffer = (block: OpenBlock | null) => {
    if (block?.kind !== "thinking") return;
    budget.releaseRetained(block.thinkingBufBytes ?? 0, { kind: "reasoning" });
    block.thinkingBufBytes = 0;
  };
  const appendRetained = (previous: string, previousBytes: number, fragment: string, scope: { kind: "reasoning" | "tool_args"; callId?: string }) => {
    const nextBytes = appendedUtf8Bytes(previous, previousBytes, fragment);
    const reservation = budget.reserveTransient(nextBytes, scope);
    try {
      const value = previous + fragment;
      reservation.commitRetained();
      budget.releaseRetained(previousBytes, scope);
      return { value, bytes: nextBytes };
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  const ensureStarted = () => {
    if (started) return;
    started = true;
    emit("message_start", { type: "message_start", message: messageSnapshot(model, undefined, inputTokenFloor) });
    emit("ping", { type: "ping" });
  };
  const closeOpenBlock = () => {
    if (!open) return;
    if (open.kind === "tool_use" && open.bufferWebSearchArgs && !open.webSearchArgsEmitted) {
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
      // The index and every thinking frame wait for closure, so redacted blocks from the
      // same item can go first.
      open.index = blockIndex++;
      emit("content_block_start", {
        type: "content_block_start", index: open.index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      if (open.thinkingBuf) {
        emit("content_block_delta", {
          type: "content_block_delta", index: open.index,
          delta: { type: "thinking_delta", thinking: open.thinkingBuf },
        }, { semanticBytes: Buffer.byteLength(open.thinkingBuf) });
      }
      const signature = open.reasoningSig ?? encodeReasoningEnvelope({ txt: open.thinkingBuf ?? "" }, budget);
      emit("content_block_delta", {
        type: "content_block_delta", index: open.index,
        delta: { type: "signature_delta", signature },
      });
    }
    emit("content_block_stop", { type: "content_block_stop", index: open.index });
    releaseThinkingBuffer(open);
    if (open.callId) budget.closeCall(open.callId);
    open = null;
  };
  const ensureBlock = (kind: "text" | "thinking") => {
    ensureStarted();
    if (open && open.kind === kind) return;
    closeOpenBlock();
    if (kind === "thinking") {
      open = { kind, index: -1, thinkingBuf: "", thinkingBufBytes: 0 };
      return;
    }
    const index = blockIndex++;
    emit("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
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
    emit("message_stop", { type: "message_stop" }, { terminal: true });
    terminalDelivered = true;
  };
  // Transient upstream statuses become overloaded_error so Anthropic SDK clients back off.
  const fail = (status: number, message: string, upstreamDerived = false, code?: string) => {
    if (terminated && (code !== "translation_buffer_limit" || terminalDelivered)) return;
    terminated = true;
    if (code === "translation_buffer_limit") {
      releaseThinkingBuffer(open);
      if (open?.callId) budget.closeCall(open.callId);
      open = null;
      terminalDelivered = true;
      // No normal close frames are valid after overflow: one bounded typed terminal.
      sink.emitBounded(sseFrame("error", anthropicErrorBody(413, message, "request_too_large", "translation_buffer_limit")));
      return;
    }
    const type = upstreamDerived && isTransientUpstreamStatus(status) ? "overloaded_error" : undefined;
    // An initial failure is an error stream, not a partial message: no message_start first.
    if (started) closeOpenBlock();
    emit("error", anthropicErrorBody(status, message, type, code), { terminal: true });
    terminalDelivered = true;
  };

  return {
    start() { /* the bridge's lifecycle preludes carry no usage, so nothing starts here */ },
    heartbeat() {
      if (terminated || sink.desiredSize() <= 0) return;
      sink.emitKeepalive(sseFrame("ping", { type: "ping" }));
    },
    text(delta) {
      if (!delta) return;
      ensureBlock("text");
      const active = open;
      if (!active || active.kind !== "text") return;
      emit("content_block_delta", {
        type: "content_block_delta", index: active.index,
        delta: { type: "text_delta", text: delta },
      }, { semanticBytes: Buffer.byteLength(delta) });
    },
    messageDone() {
      if (open && open.kind === "text") closeOpenBlock();
    },
    reasoning(delta, itemId, channel) {
      if (!delta) return;
      const itemKey = boundedReasoningIdentity(itemId);
      if (open?.kind === "thinking" && open.reasoningItemKey !== itemKey) closeOpenBlock();
      ensureBlock("thinking");
      const active = open as OpenBlock | null;
      if (!active || active.kind !== "thinking") return;
      // The bridge writes summary deltas at summary_index 0 and raw deltas at content_index 0.
      const slot = channel === "summary" ? `s${boundedReasoningIdentity(0)}` : `c${boundedReasoningIdentity(0)}`;
      const partKey = `${itemKey}:${slot}`;
      const needsPartSeparator = active.reasoningPartKey !== undefined && active.reasoningPartKey !== partKey;
      const next = appendRetained(
        active.thinkingBuf ?? "",
        active.thinkingBufBytes ?? 0,
        `${needsPartSeparator ? "\n\n" : ""}${delta}`,
        { kind: "reasoning" },
      );
      active.thinkingBuf = next.value;
      active.thinkingBufBytes = next.bytes;
      active.reasoningItemKey = itemKey;
      active.reasoningPartKey = partKey;
    },
    reasoningDone({ itemId, signature, redacted }) {
      const red = redacted ?? [];
      const itemKey = boundedReasoningIdentity(itemId);
      // A late or unrelated item cannot reorder or sign another item's text.
      if (open?.kind === "thinking" && open.reasoningItemKey !== itemKey) closeOpenBlock();
      if (red.length > 0) {
        ensureStarted();
        if (open?.kind !== "thinking") closeOpenBlock();
      }
      for (const data of red) {
        const index = blockIndex++;
        emit("content_block_start", { type: "content_block_start", index, content_block: { type: "redacted_thinking", data } });
        emit("content_block_stop", { type: "content_block_stop", index });
      }
      if (signature && open?.kind !== "thinking") ensureBlock("thinking");
      const active = open as OpenBlock | null;
      if (active?.kind === "thinking") {
        if (signature) active.reasoningSig = signature;
        closeOpenBlock();
      }
    },
    toolStart(call) {
      // Custom and tool-search calls have no Anthropic representation; the converter skips them.
      if (call.kind !== "function") return;
      ensureStarted();
      closeOpenBlock();
      sawToolUse = true;
      const index = blockIndex++;
      emit("content_block_start", {
        type: "content_block_start", index,
        content_block: { type: "tool_use", id: call.callId, name: call.name, input: {} },
      }, { sideEffect: true });
      budget.openCall(call.callId);
      open = {
        kind: "tool_use",
        index,
        callId: call.callId,
        bufferWebSearchArgs: isClaudeWebSearchToolName(call.name),
        argsBuf: "",
        argsBufBytes: 0,
        webSearchArgsEmitted: false,
        toolArgsEmitted: false,
      };
    },
    toolArgsDelta(_itemId, delta) {
      if (!delta) return;
      if (!open || open.kind !== "tool_use") return;
      if (open.bufferWebSearchArgs) {
        const next = appendRetained(open.argsBuf ?? "", open.argsBufBytes ?? 0, delta, {
          kind: "tool_args",
          ...(open.callId ? { callId: open.callId } : {}),
        });
        open.argsBuf = next.value;
        open.argsBufBytes = next.bytes;
        return;
      }
      emit("content_block_delta", {
        type: "content_block_delta", index: open.index,
        delta: { type: "input_json_delta", partial_json: delta },
      }, { semanticBytes: Buffer.byteLength(delta) });
      open.toolArgsEmitted = true;
    },
    toolArgsDone(_itemId, args) {
      if (!open || open.kind !== "tool_use" || open.bufferWebSearchArgs || open.toolArgsEmitted) return;
      if (args.length === 0) return;
      emit("content_block_delta", {
        type: "content_block_delta", index: open.index,
        delta: { type: "input_json_delta", partial_json: args },
      }, { semanticBytes: Buffer.byteLength(args) });
      open.toolArgsEmitted = true;
    },
    toolDone(call) {
      if (call.kind !== "function" || !open || open.kind !== "tool_use") return;
      if (open.bufferWebSearchArgs && !open.webSearchArgsEmitted) {
        const rawArgs = call.arguments.length > 0 ? call.arguments : (open.argsBuf ?? "");
        let parsed: unknown = {};
        try { parsed = rawArgs.length > 0 ? JSON.parse(rawArgs) : {}; } catch { parsed = {}; }
        emit("content_block_delta", {
          type: "content_block_delta",
          index: open.index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(sanitizeWebSearchInput(parsed)) },
        });
        open.webSearchArgsEmitted = true;
      } else if (!open.bufferWebSearchArgs && !open.toolArgsEmitted && call.arguments.length > 0) {
        emit("content_block_delta", {
          type: "content_block_delta", index: open.index,
          delta: { type: "input_json_delta", partial_json: call.arguments },
        }, { semanticBytes: Buffer.byteLength(call.arguments) });
        open.toolArgsEmitted = true;
      }
      closeOpenBlock();
    },
    webSearchDone(search) {
      // Server-side search becomes the pair Claude Code parses natively. It never marks a
      // tool use, so the stop reason stays end_turn unless a real tool ran.
      ensureStarted();
      closeOpenBlock();
      const pair = webSearchPairFromItem({
        type: "web_search_call",
        id: search.itemId,
        status: search.status,
        action: webSearchAction(search.queries),
        ...(search.sources.length > 0 ? { sources: search.sources } : {}),
      });
      const toolIndex = blockIndex++;
      emit("content_block_start", {
        type: "content_block_start", index: toolIndex,
        content_block: { type: "server_tool_use", id: pair.id, name: "web_search" },
      }, { sideEffect: true });
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
    },
    terminal(terminal) {
      if (terminal.status === "completed") {
        if (terminal.endTurn === false && !sawToolUse) {
          fail(529, "upstream turn ended without a final answer", true);
          return;
        }
        finish(sawToolUse ? "tool_use" : "end_turn", responsesUsage(terminal.usage));
        return;
      }
      if (terminal.status === "incomplete") {
        const outcome = anthropicIncompleteOutcome(terminal.incomplete?.reason, terminal.incomplete?.message);
        if ("stopReason" in outcome) finish(outcome.stopReason, terminal.usageOnWire ? responsesUsage(terminal.usage) : null);
        else fail(529, outcome.failMessage, true);
        return;
      }
      const error = (terminal.error ?? {}) as unknown as Rec;
      if (error.code === "translation_buffer_limit") {
        fail(413, "upstream translation buffer exceeded the safe limit", false, "translation_buffer_limit");
        return;
      }
      const message = typeof error.message === "string" ? error.message : "upstream request failed";
      fail(anthropicFailedStatus(error, message), message, true);
    },
    overflow() {
      fail(413, "upstream translation buffer exceeded the safe limit", false, "translation_buffer_limit");
    },
    dispose() {
      releaseThinkingBuffer(open);
      if (open?.callId) budget.closeCall(open.callId);
    },
  };
}

/** Stream adapter events as Anthropic Messages SSE bytes. */
export function encodeAnthropicMessageSse(
  events: AsyncIterable<AdapterEvent>,
  options: AnthropicMessageEncodeOptions,
): ReadableStream<Uint8Array> {
  return encodeAdapterEventStream(
    events,
    sink => createAnthropicMessageWriter(sink, options.model, options.inputTokenFloor),
    { ...options, keepaliveMs: MESSAGES_KEEPALIVE_MS },
  );
}

/**
 * Fold an encoded Messages stream into the non-streaming client response, with the status
 * mapping the Messages ingress applied to its collected message: a translator overflow is 413,
 * a stream that ended in an error frame is 502, anything else unexpected a 502 api_error.
 */
export async function collectAnthropicMessageResponse(
  stream: ReadableStream<Uint8Array>,
  model: string,
  translatorBudget: TranslatorBudget,
): Promise<Response> {
  let message: Rec;
  try {
    message = await collectAnthropicMessage(stream, model, translatorBudget);
  } catch (error) {
    if (isTranslatorBudgetExceededError(error)) {
      return anthropicErrorResponse(413, error.message, "request_too_large", error.code);
    }
    return anthropicErrorResponse(502, error instanceof Error ? error.message : String(error), "api_error");
  }
  const isError = message.type === "error";
  const translatedError = isError && typeof message.error === "object"
    ? (message as { error: { code?: unknown; message?: unknown } }).error
    : undefined;
  if (translatedError?.code === "translation_buffer_limit") {
    return anthropicErrorResponse(
      413,
      typeof translatedError.message === "string"
        ? translatedError.message
        : "upstream translation buffer exceeded the safe limit",
      "request_too_large",
      "translation_buffer_limit",
    );
  }
  return new Response(JSON.stringify(message), {
    status: isError ? 502 : 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Non-streaming client: the encoded stream folded exactly as the Messages collector folds it. */
export function foldAnthropicMessage(
  events: AsyncIterable<AdapterEvent>,
  options: AnthropicMessageEncodeOptions,
): Promise<Response> {
  return collectAnthropicMessageResponse(
    encodeAnthropicMessageSse(events, options),
    options.model,
    options.translatorBudget,
  );
}
