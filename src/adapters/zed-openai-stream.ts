import type { AdapterEvent, OcxMessagePhase, OcxUsage } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import { decodeServerSentEvents } from "../lib/sse-decoder";
import { transferCompactionCiphertextLease } from "../responses/compaction";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toolKey(tool: Record<string, unknown>): string | undefined {
  if (typeof tool.type !== "string" || !tool.type) return undefined;
  const name = typeof tool.name === "string" ? tool.name : "";
  return tool.type + "\0" + name;
}

/**
 * Zed's OpenAI Responses schema accepts message and call items, not Codex's private
 * additional_tools wrapper. Drop every wrapper. Promote only wrappers at or after the
 * replayed prefix: earlier ones are history, not the current turn's tool catalog.
 * A non-array tools field is left untouched so a malformed catalog is not replaced
 * by a partial promotion.
 */
export function liftZedAdditionalTools(providerRequest: Record<string, unknown>, replayPrefixLength: number): void {
  if (!Array.isArray(providerRequest.input)) return;
  if (providerRequest.tools !== undefined && !Array.isArray(providerRequest.tools)) return;

  const currentTurnStart = Number.isFinite(replayPrefixLength)
    ? Math.min(providerRequest.input.length, Math.max(0, Math.trunc(replayPrefixLength)))
    : 0;
  const input: unknown[] = [];
  const promoted: unknown[] = [];
  let changed = false;
  for (const [index, item] of providerRequest.input.entries()) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
      changed = true;
      if (index >= currentTurnStart) promoted.push(...item.tools);
      continue;
    }
    input.push(item);
  }
  if (!changed) return;

  const seen = new Set<string>();
  const tools: unknown[] = [];
  const existing = Array.isArray(providerRequest.tools) ? providerRequest.tools : [];
  for (const tool of [...existing, ...promoted]) {
    if (!isRecord(tool)) {
      tools.push(tool);
      continue;
    }
    const key = toolKey(tool);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    tools.push(tool);
  }
  providerRequest.input = input;
  providerRequest.tools = tools;
}

interface CallState {
  key: string;
  callId: string;
  name: string;
  args: string;
  pendingFull?: string;
  argsBytes: number;
  fullBytes: number;
  lastCodeUnit: number;
  emitted: number;
  started: boolean;
  ended: boolean;
  closed: boolean;
  /** True only after this call's own done or completed item, not after EOF. */
  allowFull: boolean;
}

/** UTF-8 bytes a fragment adds to an existing string, without re-measuring the whole buffer. */
function appendedUtf8Bytes(previousBytes: number, lastCodeUnit: number, fragment: string): number {
  if (!fragment) return previousBytes;
  const first = fragment.charCodeAt(0);
  const joinsPair = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
  return previousBytes + Buffer.byteLength(fragment, "utf8") - (joinsPair ? 2 : 0);
}

function phaseOf(item: Record<string, unknown>): OcxMessagePhase | undefined {
  return item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
}

function messageText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "output_text" && typeof part.text === "string")
    .map(part => String(part.text))
    .join("");
}

function usageFromResponse(response: unknown): OcxUsage | undefined {
  if (!isRecord(response) || !isRecord(response.usage)) return undefined;
  const usage = response.usage;
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(typeof inputDetails?.cached_tokens === "number"
      ? { cachedInputTokens: inputDetails.cached_tokens, cacheReadInputTokens: inputDetails.cached_tokens }
      : {}),
    ...(typeof outputDetails?.reasoning_tokens === "number"
      ? { reasoningOutputTokens: outputDetails.reasoning_tokens }
      : {}),
  };
}

function failureMessage(payload: Record<string, unknown>): string {
  const source = isRecord(payload.response) ? payload.response : payload;
  const err = source.error ?? payload.error;
  if (typeof err === "string" && err) return err;
  if (isRecord(err) && typeof err.message === "string" && err.message) return err.message;
  if (typeof source.message === "string" && source.message) return source.message;
  return "Zed OpenAI request failed";
}

function incompleteReason(payload: Record<string, unknown>): string {
  const source = isRecord(payload.response) ? payload.response : payload;
  const details = isRecord(source.incomplete_details) ? source.incomplete_details : undefined;
  if (typeof details?.reason === "string" && details.reason) return details.reason;
  return failureMessage(payload);
}

/**
 * Translate Zed's OpenAI Responses SSE into adapter events.
 *
 * The shared Responses passthrough parser only keeps message text, because its other caller
 * is compaction. Using it here drops function and custom calls, and Codex then stores the
 * first sentence as final_answer and ends the turn. A later synthetic response.completed
 * with empty output (Zed's stream-ended frame) must not wipe usage taken from the real
 * completion, and completed output must not repeat text or calls that already streamed.
 * Adapter tool deltas are unkeyed, so only the oldest open call is emitted. A newer call
 * keeps every later delta until the older call's own terminal event, then replays in order.
 * EOF and response.incomplete flush arguments that already arrived; they do not copy a full
 * arguments field that never came from that call's done or completed item. A compaction
 * ciphertext is carried on done, with the same retained lease as the Responses parser.
 */
export async function* translateZedOpenAiStream(
  body: ReadableStream<Uint8Array> | null,
  budget: TranslatorBudget,
): AsyncGenerator<AdapterEvent> {
  if (!body) {
    yield { type: "error", message: "Zed OpenAI response had no body" };
    return;
  }

  const calls = new Map<string, CallState>();
  const phases = new Map<string, OcxMessagePhase>();
  const textByItem = new Map<string, string>();
  const textBytesByItem = new Map<string, number>();
  let unscopedText = "";
  let unscopedTextBytes = 0;
  let sawThinking = false;
  let sawRawReasoning = false;
  let usage: OcxUsage | undefined;
  let terminal = false;
  let compactionEncryptedContent: string | undefined;
  let compactionEncryptedContentBytes = 0;
  let ciphertextTransferred = false;

  function argumentText(state: CallState): string {
    const full = state.pendingFull;
    if (state.allowFull && typeof full === "string" && full.startsWith(state.args)) return full;
    return state.args;
  }

  /** Emit the oldest open call. Newer calls stay buffered until that call closes. */
  function* pump(): Generator<AdapterEvent> {
    while (true) {
      const next = [...calls.values()].find(state => !state.ended);
      if (!next) return;
      if (!next.name) {
        if (!next.closed) return;
        next.ended = true;
        releaseCall(next);
        continue;
      }
      if (!next.started) {
        next.started = true;
        yield { type: "tool_call_start", id: next.callId, name: next.name };
      }
      const text = argumentText(next);
      if (text.length > next.emitted) {
        const delta = text.slice(next.emitted);
        next.emitted = text.length;
        yield { type: "tool_call_delta", arguments: delta };
      }
      if (!next.closed) return;
      next.ended = true;
      yield { type: "tool_call_end" };
      releaseCall(next);
    }
  }

  function* appendArgs(state: CallState, fragment: string): Generator<AdapterEvent> {
    if (!fragment || state.ended) return;
    const nextBytes = appendedUtf8Bytes(state.argsBytes, state.lastCodeUnit, fragment);
    budget.chargeRetained(nextBytes - state.argsBytes, { kind: "tool_args", callId: state.key });
    state.args += fragment;
    state.argsBytes = nextBytes;
    state.lastCodeUnit = fragment.charCodeAt(fragment.length - 1);
    yield* pump();
  }

  function rememberFull(state: CallState, full: unknown): void {
    // A closed call's buffers were already released; charging again would outlive their owner.
    if (state.ended || typeof full !== "string" || full.length === 0 || full === state.pendingFull) return;
    const nextBytes = Buffer.byteLength(full, "utf8");
    if (nextBytes > state.fullBytes) {
      budget.chargeRetained(nextBytes - state.fullBytes, { kind: "tool_args", callId: state.key });
    } else if (nextBytes < state.fullBytes) {
      budget.releaseRetained(state.fullBytes - nextBytes, { kind: "tool_args", callId: state.key });
    }
    state.pendingFull = full;
    state.fullBytes = nextBytes;
  }

  /**
   * A finished call's buffers are dead. Closing the budget call releases exactly the bytes this
   * call still holds, including the part already emitted, so a turn cannot keep growing.
   */
  function releaseCall(state: CallState): void {
    budget.closeCall(state.key);
    state.args = "";
    state.argsBytes = 0;
    state.pendingFull = undefined;
    state.fullBytes = 0;
    state.emitted = 0;
    state.lastCodeUnit = 0;
  }

  /**
   * Release everything this generator still holds. A cancelled consumer or a thrown read never
   * reaches the flush path, so the buffers must not outlive the request.
   */
  function releaseStreamBuffers(): void {
    for (const state of calls.values()) budget.closeCall(state.key);
    calls.clear();
    for (const bytes of textBytesByItem.values()) {
      budget.releaseRetained(bytes, { kind: "retained_collectors" });
    }
    textBytesByItem.clear();
    textByItem.clear();
    budget.releaseRetained(unscopedTextBytes, { kind: "retained_collectors" });
    unscopedTextBytes = 0;
    unscopedText = "";
  }

  function* closeCall(state: CallState, allowFull: boolean): Generator<AdapterEvent> {
    if (state.ended) return;
    state.closed = true;
    if (allowFull) state.allowFull = true;
    yield* pump();
  }

  function* flushUnclosed(allowFull: boolean): Generator<AdapterEvent> {
    for (const state of calls.values()) {
      if (state.ended || state.closed) continue;
      state.closed = true;
      if (allowFull) state.allowFull = true;
    }
    yield* pump();
  }

  function retainCompaction(response: unknown): void {
    if (!isRecord(response) || !Array.isArray(response.output)) return;
    const compaction = response.output.find(item =>
      isRecord(item) && item.type === "compaction" && typeof item.encrypted_content === "string");
    if (!isRecord(compaction) || typeof compaction.encrypted_content !== "string") return;
    const next = compaction.encrypted_content;
    if (next === compactionEncryptedContent) return;
    const nextBytes = Buffer.byteLength(next, "utf8");
    const reservation = budget.reserveTransient(nextBytes, { kind: "retained_collectors" });
    compactionEncryptedContent = next;
    reservation.commitRetained();
    budget.releaseRetained(compactionEncryptedContentBytes, { kind: "retained_collectors" });
    compactionEncryptedContentBytes = nextBytes;
  }

  function ensureCall(key: string, callId: string, name: string): CallState {
    let state = calls.get(key);
    if (!state) {
      state = {
        // A delta names only the item. Keep the call id the added item already carried instead of
        // replacing it with the item id, which would mislabel a deferred start.
        key,
        callId: callId || key,
        name,
        args: "",
        argsBytes: 0,
        fullBytes: 0,
        lastCodeUnit: 0,
        emitted: 0,
        started: false,
        ended: false,
        closed: false,
        allowFull: false,
      };
      calls.set(key, state);
      budget.openCall(state.key);
      return state;
    }
    if (callId) state.callId = callId;
    if (name) state.name = name;
    return state;
  }

  /**
   * Text is kept only to suppress a completed replay. Every replacement is charged to the
   * request budget and the superseded bytes released, so a long turn cannot accumulate text
   * outside the per-turn ceiling.
   */
  function noteText(itemId: string | undefined, text: string): void {
    const nextBytes = Buffer.byteLength(text, "utf8");
    if (itemId) {
      const previousBytes = textBytesByItem.get(itemId) ?? 0;
      if (nextBytes > previousBytes) budget.chargeRetained(nextBytes - previousBytes, { kind: "retained_collectors" });
      else if (nextBytes < previousBytes) budget.releaseRetained(previousBytes - nextBytes, { kind: "retained_collectors" });
      textByItem.set(itemId, text);
      textBytesByItem.set(itemId, nextBytes);
      return;
    }
    if (nextBytes > unscopedTextBytes) budget.chargeRetained(nextBytes - unscopedTextBytes, { kind: "retained_collectors" });
    else if (nextBytes < unscopedTextBytes) budget.releaseRetained(unscopedTextBytes - nextBytes, { kind: "retained_collectors" });
    unscopedText = text;
    unscopedTextBytes = nextBytes;
  }

  function* emitNewText(text: string, phase?: OcxMessagePhase, itemId?: string): Generator<AdapterEvent> {
    if (!text) return;
    // A completed response repeats every message. Deltas from different messages must not
    // be concatenated before that comparison, or the earlier message matches neither the
    // whole string nor its prefix and is appended a second time.
    let previous = itemId !== undefined && textByItem.has(itemId) ? textByItem.get(itemId) ?? "" : "";
    if (!previous && unscopedText) {
      if (text === unscopedText || text.startsWith(unscopedText)) {
        previous = unscopedText;
        noteText(undefined, "");
      } else if (unscopedText.startsWith(text)) {
        noteText(undefined, unscopedText.slice(text.length));
        noteText(itemId, text);
        return;
      }
    }
    if (!previous) {
      noteText(itemId, text);
      yield { type: "text_delta", text, ...(phase ? { phase } : {}) };
      return;
    }
    if (text === previous || previous.endsWith(text)) {
      noteText(itemId, previous);
      return;
    }
    if (text.startsWith(previous)) {
      const tail = text.slice(previous.length);
      noteText(itemId, text);
      if (tail) yield { type: "text_delta", text: tail, ...(phase ? { phase } : {}) };
      return;
    }
    noteText(itemId, previous + text);
    yield { type: "text_delta", text, ...(phase ? { phase } : {}) };
  }

  /** Streamed deltas accumulate per item; the charge follows the accumulated size. */
  function appendText(itemId: string | undefined, delta: string): void {
    if (itemId) noteText(itemId, (textByItem.get(itemId) ?? "") + delta);
    else noteText(undefined, unscopedText + delta);
  }

  function* observeToolItem(item: Record<string, unknown>, done: boolean): Generator<AdapterEvent> {
    if (item.type !== "function_call" && item.type !== "custom_tool_call") return;
    const key = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : undefined;
    if (!key) return;
    const callId = typeof item.call_id === "string" ? item.call_id : key;
    const name = typeof item.name === "string" ? item.name : "";
    const state = ensureCall(key, callId, name);
    rememberFull(state, item.type === "custom_tool_call" ? item.input : item.arguments);
    if (done) yield* closeCall(state, true);
    else yield* pump();
  }

  function* emitReasoningItem(item: Record<string, unknown>): Generator<AdapterEvent> {
    if (!sawThinking && Array.isArray(item.summary)) {
      const text = item.summary
        .filter((part): part is Record<string, unknown> => isRecord(part) && typeof part.text === "string")
        .map(part => String(part.text))
        .join("");
      if (text) {
        sawThinking = true;
        yield { type: "thinking_delta", thinking: text };
      }
    }
    if (!sawRawReasoning && Array.isArray(item.content)) {
      const text = item.content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "reasoning_text" && typeof part.text === "string")
        .map(part => String(part.text))
        .join("");
      if (text) {
        sawRawReasoning = true;
        yield { type: "reasoning_raw_delta", text };
      }
    }
  }

  function* consumeItem(item: Record<string, unknown>, done: boolean): Generator<AdapterEvent> {
    if (item.type === "message") {
      const phase = phaseOf(item);
      if (typeof item.id === "string" && phase) phases.set(item.id, phase);
      if (done) yield* emitNewText(messageText(item), phase, typeof item.id === "string" ? item.id : undefined);
      return;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      yield* observeToolItem(item, done);
      return;
    }
    if (done && item.type === "reasoning") yield* emitReasoningItem(item);
  }

  function* onPayload(payload: Record<string, unknown>): Generator<AdapterEvent> {
    if (payload.type === "error" || payload.type === "response.failed") {
      terminal = true;
      yield { type: "error", message: failureMessage(payload) };
      return;
    }
    if (payload.type === "response.incomplete") {
      terminal = true;
      yield* flushUnclosed(false);
      const response = isRecord(payload.response) ? payload.response : undefined;
      const nextUsage = usageFromResponse(response) ?? usage;
      if (nextUsage) usage = nextUsage;
      yield { type: "incomplete", reason: incompleteReason(payload), ...(usage ? { usage } : {}) };
      return;
    }
    if (payload.type === "response.output_item.added" || payload.type === "response.output_item.done") {
      if (isRecord(payload.item)) yield* consumeItem(payload.item, payload.type === "response.output_item.done");
      return;
    }
    if (payload.type === "response.output_text.delta" && typeof payload.delta === "string" && payload.delta) {
      const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
      const phase = itemId ? phases.get(itemId) : undefined;
      appendText(itemId, payload.delta);
      yield { type: "text_delta", text: payload.delta, ...(phase ? { phase } : {}) };
      return;
    }
    if (payload.type === "response.reasoning_summary_text.delta" && typeof payload.delta === "string" && payload.delta) {
      sawThinking = true;
      yield { type: "thinking_delta", thinking: payload.delta };
      return;
    }
    if (payload.type === "response.reasoning_text.delta" && typeof payload.delta === "string" && payload.delta) {
      sawRawReasoning = true;
      yield { type: "reasoning_raw_delta", text: payload.delta };
      return;
    }
    if (
      (payload.type === "response.function_call_arguments.delta" || payload.type === "response.custom_tool_call_input.delta")
      && typeof payload.delta === "string"
    ) {
      const key = typeof payload.item_id === "string" ? payload.item_id : undefined;
      if (!key) return;
      yield* appendArgs(ensureCall(key, "", ""), payload.delta);
      return;
    }
    if (payload.type === "response.function_call_arguments.done" || payload.type === "response.custom_tool_call_input.done") {
      const key = typeof payload.item_id === "string" ? payload.item_id : undefined;
      if (!key) return;
      const state = ensureCall(key, "", "");
      rememberFull(state, payload.type === "response.custom_tool_call_input.done" ? payload.input : payload.arguments);
      yield* closeCall(state, true);
      return;
    }
    if (payload.type === "response.completed") {
      const response = isRecord(payload.response) ? payload.response : undefined;
      retainCompaction(response);
      if (response && Array.isArray(response.output)) {
        for (const item of response.output) {
          if (isRecord(item)) yield* consumeItem(item, true);
        }
      }
      const nextUsage = usageFromResponse(response);
      if (nextUsage) usage = nextUsage;
    }
  }

  try {
    for await (const event of decodeServerSentEvents(body, { translatorBudget: budget })) {
      let payload: unknown;
      try { payload = JSON.parse(event.data); } catch { continue; }
      if (!isRecord(payload)) continue;
      yield* onPayload(payload);
      if (terminal) return;
    }

    yield* flushUnclosed(false);
    const done: AdapterEvent = {
      type: "done",
      ...(usage ? { usage } : {}),
      ...(compactionEncryptedContent ? { compactionEncryptedContent } : {}),
    };
    transferCompactionCiphertextLease(done, budget, compactionEncryptedContentBytes);
    ciphertextTransferred = true;
    yield done;
  } finally {
    if (!ciphertextTransferred) budget.releaseRetained(compactionEncryptedContentBytes, { kind: "retained_collectors" });
    releaseStreamBuffers();
  }
}

