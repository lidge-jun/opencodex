import type { AdapterEvent, OcxMessagePhase, OcxUsage } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import { decodeServerSentEvents } from "../lib/sse-decoder";
import { transferCompactionCiphertextLease } from "../responses/compaction";
import { truncationReasonFor } from "../responses/truncated-stop-reason";
import { unnamedToolCallEvent } from "./openai-chat/response-events";
import { usageFromResponsesPayload } from "./openai-responses/usage";
import { zedDiagnosticUsage } from "./zed-diagnostic-usage";
import { reconcileZedArguments, zedArgumentFingerprint, ZedArgumentAuthority, zedArgumentAuthorityBytes } from "./zed-tool-arguments";
import { ZedJsonError } from "./zed-json-tokens";
import { randomUUID } from "node:crypto";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export { liftZedAdditionalTools } from "./zed-additional-tools";

interface CallState {
  key: string;
  budgetKey: string;
  callId: string;
  kind?: string;
  finalHash?: string;
  after: { event: AdapterEvent; bytes: number }[];
  name: string;
  args: string;
  pendingFull?: string;
  authoritative: boolean;
  authority?: ZedArgumentAuthority;
  authorityBytes?: number;
  argsBytes: number;
  fullBytes: number;
  lastCodeUnit: number;
  emitted: number;
  started: boolean;
  ended: boolean;
  closed: boolean;
  incomplete: boolean;
  argsDone: boolean;
  /** True only after this call's own done or completed item, not after EOF. */
  allowFull: boolean;
}

class ZedToolIdentityError extends Error {
  constructor() { super("Zed stream reused a tool call identity with conflicting data"); }
}

class ZedToolArgumentsError extends Error {
  constructor() { super("Zed stream completed a tool call with conflicting arguments"); }
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
  if (typeof details?.reason === "string" && details.reason) return truncationReasonFor(details.reason) ?? details.reason;
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
 * keeps every later delta until the older call's authoritative item end, then replays in order.
 * Argument-done confirms bytes only; item status or successful response completion closes a call.
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
  const aliases = new Map<string, CallState>();
  const callIds = new Map<string, CallState>();
  const phases = new Map<string, OcxMessagePhase>();
  const textByItem = new Map<string, string>();
  const textBytesByItem = new Map<string, number>();
  const textLastByItem = new Map<string, number>();
  const textParts = new Map<string, { text: string; bytes: number; last: number }>();
  let textPartBytes = 0;
  const identities = new Set<string>();
  let identityBytes = 0;
  const thinkingItems = new Set<string>();
  const rawReasoningItems = new Set<string>();
  let unscopedText = "";
  let unscopedTextBytes = 0;
  let unscopedLast = 0;
  let sawThinking = false;
  let sawRawReasoning = false;
  let usage: OcxUsage | undefined;
  let usageRawBytes = 0;
  let semanticBytes = 0;
  let terminal = false;
  let terminalError = false;
  let compactionEncryptedContent: string | undefined;
  let compactionEncryptedContentBytes = 0;
  let ciphertextTransferred = false;

  // Include a fixed entry allowance so arbitrarily many empty items also spend the turn cap.
  function retainIdentity(key: string): void {
    if (identities.has(key)) return;
    const bytes = 64 + Buffer.byteLength(key, "utf8");
    budget.chargeRetained(bytes, { kind: "item_ids" });
    identityBytes += bytes;
    identities.add(key);
  }

  function argumentText(state: CallState): string {
    const full = state.pendingFull;
    if (state.allowFull && typeof full === "string" && (state.authoritative || full.startsWith(state.args))) return full;
    return state.args;
  }

  function argumentWorkspace<T>(texts: string[], work: () => T): T {
    // Source copies, canonical tokens, reconciliation positions and iterative grammar stacks.
    const reservation = budget.reserveTransient(texts.reduce((size, text) => size + Buffer.byteLength(text, "utf8"), 0)
      + 12 * Math.max(0, ...texts.map(text => text.length)),
      { kind: "retained_collectors" });
    try { return work(); } finally { reservation.release(); }
  }

  function fingerprint(state: CallState, text: string): string {
    return argumentWorkspace([text], () => zedArgumentFingerprint(text, state.kind === "custom_tool_call"));
  }

  /** Emit the oldest open call. Newer calls stay buffered until that call closes. */
  function* pump(preserveFailure = false): Generator<AdapterEvent> {
    while (true) {
      if (terminalError) return;
      const next = [...calls.values()].find(state => !state.ended);
      if (!next) return;
      if (next.closed && next.allowFull && !next.incomplete && next.authoritative) {
        const full = next.pendingFull ?? next.args;
        const consistent = argumentWorkspace([next.args, full], () =>
          reconcileZedArguments(next.args, full, next.kind === "custom_tool_call") !== undefined);
        if (!consistent) throw new ZedToolArgumentsError();
      }
      if (!next.name) {
        if (!next.closed) return;
        if (!preserveFailure) {
          next.ended = true;
          releaseCall(next);
          terminal = true;
          terminalError = true;
          yield unnamedToolCallEvent(usage);
          return;
        }
      }
      if (next.name && !next.started) {
        next.started = true;
        yield { type: "tool_call_start", id: next.callId, name: next.name };
      }
      const text = argumentText(next);
      if (next.name && text.length > next.emitted) {
        const delta = text.slice(next.emitted);
        next.emitted = text.length;
        yield { type: "tool_call_delta", arguments: delta };
      }
      if (!next.closed) return;
      // Failed/incomplete input is never executable or eligible for successful replay dedupe.
      // In particular, do not scan over-limit JSON again while flushing its failure.
      next.finalHash = next.allowFull && !next.incomplete ? fingerprint(next, text) : undefined;
      next.ended = true;
      if (next.name) yield { type: "tool_call_end", ...(!next.allowFull || next.incomplete ? { incomplete: true } : {}) };
      releaseCall(next);
      for (const entry of next.after) {
        budget.releaseRetained(entry.bytes, { kind: "retained_collectors" });
        semanticBytes -= entry.bytes;
        yield entry.event;
      }
      next.after = [];
    }
  }

  function* appendArgs(state: CallState, fragment: string): Generator<AdapterEvent> {
    if (!fragment || state.ended) return;
    const nextBytes = appendedUtf8Bytes(state.argsBytes, state.lastCodeUnit, fragment);
    const scope = { kind: "tool_args" as const, callId: state.budgetKey };
    const reservation = budget.reserveTransient(nextBytes, scope);
    try {
      const next = state.args + fragment;
      if (state.authoritative) {
        state.authority!.push(fragment);
        // The original string is still the delivery/authority owner while the late stream
        // catches up using an equivalent serialization. Transfer its existing lease.
        if (state.pendingFull === undefined) {
          state.pendingFull = state.args;
          state.fullBytes = state.argsBytes;
          state.argsBytes = 0;
        }
      }
      state.args = next;
    } catch (error) { reservation.release(); throw error; }
    reservation.commitRetained();
    budget.releaseRetained(state.argsBytes, scope);
    state.argsBytes = nextBytes;
    state.lastCodeUnit = fragment.charCodeAt(fragment.length - 1);
    yield* pump();
  }

  function rememberFull(state: CallState, full: unknown, authoritative = false): void {
    // A closed call's buffers were already released; charging again would outlive their owner.
    if (typeof full !== "string" || (!authoritative && full.length === 0)) return;
    if (state.ended) {
      if (state.finalHash && state.finalHash !== fingerprint(state, full)) throw new ZedToolIdentityError();
      return;
    }
    if (!authoritative && state.allowFull) return;
    // Completed input remains authoritative even when another call blocks all emission.
    if (authoritative) {
      const snapshot = full;
      const confirmed = state.pendingFull ?? state.args;
      if (state.authoritative) {
        if (fingerprint(state, confirmed) !== fingerprint(state, snapshot)) throw new ZedToolArgumentsError();
        full = confirmed;
      } else full = argumentWorkspace([state.args, snapshot], () => {
        const custom = state.kind === "custom_tool_call";
        const received = reconcileZedArguments(state.args, snapshot, custom);
        if (received === undefined) return;
        return reconcileZedArguments(argumentText(state).slice(0, state.emitted), received, custom);
      });
      if (typeof full !== "string") throw new ZedToolArgumentsError();
      if (!state.authoritative) {
        const custom = state.kind === "custom_tool_call";
        const bytes = zedArgumentAuthorityBytes(full, custom);
        const reservation = budget.reserveTransient(bytes, { kind: "retained_collectors" });
        try { state.authority = new ZedArgumentAuthority(full, custom, state.args); }
        catch (error) { reservation.release(); throw error; }
        reservation.commitRetained();
        state.authorityBytes = bytes;
      }
      state.authoritative = true;
    }
    if (full === state.pendingFull) return;
    if (full === state.args) {
      budget.releaseRetained(state.fullBytes, { kind: "tool_args", callId: state.budgetKey });
      state.pendingFull = undefined;
      state.fullBytes = 0;
      return;
    }
    const nextBytes = Buffer.byteLength(full, "utf8");
    const scope = { kind: "tool_args" as const, callId: state.budgetKey };
    const reservation = budget.reserveTransient(nextBytes, scope);
    state.pendingFull = full;
    reservation.commitRetained();
    budget.releaseRetained(state.fullBytes, scope);
    state.fullBytes = nextBytes;
  }

  /**
   * A finished call's buffers are dead. Closing the budget call releases exactly the bytes this
   * call still holds, including the part already emitted, so a turn cannot keep growing.
   */
  function releaseCall(state: CallState): void {
    budget.closeCall(state.budgetKey);
    budget.releaseRetained(state.authorityBytes ?? 0, { kind: "retained_collectors" });
    state.authority = undefined;
    state.authorityBytes = 0;
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
    for (const state of calls.values()) releaseCall(state);
    calls.clear();
    aliases.clear();
    callIds.clear();
    budget.releaseRetained(semanticBytes + usageRawBytes, { kind: "retained_collectors" });
    semanticBytes = usageRawBytes = 0;
    budget.releaseRetained(identityBytes, { kind: "item_ids" });
    identityBytes = 0;
    identities.clear();
    phases.clear();
    thinkingItems.clear();
    rawReasoningItems.clear();
    for (const bytes of textBytesByItem.values()) {
      budget.releaseRetained(bytes, { kind: "retained_collectors" });
    }
    textBytesByItem.clear();
    textLastByItem.clear();
    textByItem.clear();
    textParts.clear();
    budget.releaseRetained(textPartBytes, { kind: "retained_collectors" });
    textPartBytes = 0;
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

  function* flushUnclosed(allowFull: boolean, preserveFailure = false): Generator<AdapterEvent> {
    for (const state of calls.values()) {
      if (state.ended) continue;
      state.closed = true;
      if (!allowFull) state.incomplete = true;
      if (allowFull) state.allowFull = true;
    }
    yield* pump(preserveFailure);
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

  function ensureCall(key: string, callId: string, name: string, kind?: string): CallState {
    const byItem = aliases.get(key);
    const byCall = callId ? callIds.get(callId) : undefined;
    if (byItem && byCall && byItem !== byCall) throw new ZedToolIdentityError();
    let state = byItem ?? byCall;
    if (!state) {
      retainIdentity(`call:${key}`);
      state = {
        // A delta names only the item. Keep the call id the added item already carried instead of
        // replacing it with the item id, which would mislabel a deferred start.
        key,
        budgetKey: `zed:${randomUUID()}`,
        callId: callId || key,
        kind,
        after: [],
        name,
        args: "",
        authoritative: false,
        argsBytes: 0,
        fullBytes: 0,
        lastCodeUnit: 0,
        emitted: 0,
        started: false,
        ended: false,
        closed: false,
        incomplete: false,
        argsDone: false,
        allowFull: false,
      };
      calls.set(key, state);
      budget.openCall(state.budgetKey);
    }
    if ((name && state.name && name !== state.name) || (kind && state.kind && kind !== state.kind)
      || (callId && state.started && callId !== state.callId)) throw new ZedToolIdentityError();
    retainIdentity(`call-alias:${key}`);
    aliases.set(key, state);
    // Metadata stays alive for replay deduplication even after argument buffers close.
    if (callId) retainIdentity(`call-id:${callId}`);
    if (name) retainIdentity(`call-name:${name}`);
    if (callId) { state.callId = callId; callIds.set(callId, state); }
    if (name) state.name = name;
    if (kind) state.kind = kind;
    return state;
  }

  function* semantic(event: AdapterEvent): Generator<AdapterEvent> {
    const active = [...calls.values()].find(state => state.started && !state.ended);
    if (!active) { yield event; return; }
    const bytes = 64 + Buffer.byteLength(JSON.stringify(event), "utf8");
    budget.chargeRetained(bytes, { kind: "retained_collectors" });
    semanticBytes += bytes;
    active.after.push({ event, bytes });
    yield { type: "heartbeat" };
  }

  function retainUsage(response: unknown, diagnostic = false): void {
    if (diagnostic && usage) {
      const { rawUsage: _raw, ...counters } = usage;
      usage = counters;
      budget.releaseRetained(usageRawBytes, { kind: "retained_collectors" });
      usageRawBytes = 0;
    }
    const next = usageFromResponsesPayload(diagnostic && isRecord(response)
      ? { usage: zedDiagnosticUsage(response.usage) } : response);
    if (!next) return;
    const bytes = next.rawUsage ? Buffer.byteLength(JSON.stringify(next.rawUsage), "utf8") : 0;
    const reservation = budget.reserveTransient(bytes, { kind: "retained_collectors" });
    usage = next;
    reservation.commitRetained();
    budget.releaseRetained(usageRawBytes, { kind: "retained_collectors" });
    usageRawBytes = bytes;
  }

  /**
   * Text is kept only to suppress a completed replay. Every replacement is charged to the
   * request budget and the superseded bytes released, so a long turn cannot accumulate text
   * outside the per-turn ceiling.
   */
  function noteText(itemId: string | undefined, text: string, nextBytes = Buffer.byteLength(text, "utf8"), last = text.charCodeAt(text.length - 1)): void {
    if (itemId) {
      retainIdentity(`text:${itemId}`);
      const previousBytes = textBytesByItem.get(itemId) ?? 0;
      const reservation = budget.reserveTransient(nextBytes, { kind: "retained_collectors" });
      textByItem.set(itemId, text);
      textBytesByItem.set(itemId, nextBytes);
      textLastByItem.set(itemId, last);
      reservation.commitRetained();
      budget.releaseRetained(previousBytes, { kind: "retained_collectors" });
      return;
    }
    const reservation = budget.reserveTransient(nextBytes, { kind: "retained_collectors" });
    unscopedText = text;
    reservation.commitRetained();
    budget.releaseRetained(unscopedTextBytes, { kind: "retained_collectors" });
    unscopedTextBytes = nextBytes;
    unscopedLast = last;
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
      yield* semantic({ type: "text_delta", text, ...(phase ? { phase } : {}) });
      return;
    }
    if (text === previous || previous.endsWith(text)) {
      noteText(itemId, previous);
      return;
    }
    if (text.startsWith(previous)) {
      const tail = text.slice(previous.length);
      noteText(itemId, text);
      if (tail) yield* semantic({ type: "text_delta", text: tail, ...(phase ? { phase } : {}) });
      return;
    }
    noteText(itemId, previous + text);
    yield* semantic({ type: "text_delta", text, ...(phase ? { phase } : {}) });
  }

  /** Streamed deltas accumulate per item; the charge follows the accumulated size. */
  function appendText(itemId: string | undefined, delta: string): void {
    const previous = itemId ? textByItem.get(itemId) ?? "" : unscopedText;
    const bytes = itemId ? textBytesByItem.get(itemId) ?? 0 : unscopedTextBytes;
    const last = itemId ? textLastByItem.get(itemId) ?? 0 : unscopedLast;
    noteText(itemId, previous + delta, appendedUtf8Bytes(bytes, last, delta), delta.charCodeAt(delta.length - 1));
  }

  function textPartKey(payload: Record<string, unknown>): string | undefined {
    return typeof payload.item_id === "string"
      ? JSON.stringify([payload.item_id, payload.content_index ?? 0]) : undefined;
  }

  function rememberTextPart(key: string, text: string, bytes: number, last: number): void {
    retainIdentity(`text-part:${key}`);
    const oldBytes = textParts.get(key)?.bytes ?? 0;
    const reservation = budget.reserveTransient(bytes, { kind: "retained_collectors" });
    textParts.set(key, { text, bytes, last });
    reservation.commitRetained();
    budget.releaseRetained(oldBytes, { kind: "retained_collectors" });
    textPartBytes += bytes - oldBytes;
  }

  function* observeToolItem(item: Record<string, unknown>, done: boolean): Generator<AdapterEvent> {
    if (item.type !== "function_call" && item.type !== "custom_tool_call") return;
    const key = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : undefined;
    if (!key) return;
    const callId = typeof item.call_id === "string" ? item.call_id : key;
    const name = typeof item.name === "string" ? item.name : "";
    const state = ensureCall(key, callId, name, item.type);
    if (item.status === "incomplete") state.incomplete = true;
    rememberFull(state, item.type === "custom_tool_call" ? item.input : item.arguments, done);
    if (done) yield* closeCall(state, true);
    else yield* pump();
  }

  function* emitReasoningItem(item: Record<string, unknown>): Generator<AdapterEvent> {
    const key = typeof item.id === "string" ? item.id : "";
    retainIdentity(`reasoning:${key}`);
    if (!(key ? thinkingItems.has(key) : sawThinking) && Array.isArray(item.summary)) {
      const text = item.summary
        .filter((part): part is Record<string, unknown> => isRecord(part) && typeof part.text === "string")
        .map(part => String(part.text))
        .join("");
      if (text) {
        sawThinking = true;
        thinkingItems.add(key);
        yield* semantic({ type: "thinking_delta", thinking: text });
      }
    }
    if (!(key ? rawReasoningItems.has(key) : sawRawReasoning) && Array.isArray(item.content)) {
      const text = item.content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "reasoning_text" && typeof part.text === "string")
        .map(part => String(part.text))
        .join("");
      if (text) {
        sawRawReasoning = true;
        rawReasoningItems.add(key);
        yield* semantic({ type: "reasoning_raw_delta", text });
      }
    }
  }

  function* consumeItem(item: Record<string, unknown>, done: boolean): Generator<AdapterEvent> {
    if (item.type === "message") {
      const phase = phaseOf(item);
      if (typeof item.id === "string") retainIdentity(`message:${item.id}`);
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
    if (payload.type === "error" || payload.type === "response.failed" || (payload.error !== undefined && payload.error !== null)) {
      terminal = true;
      retainUsage(payload.response ?? payload, true);
      yield* flushUnclosed(false, true);
      yield { type: "error", message: failureMessage(payload), ...(usage ? { usage } : {}) };
      return;
    }
    if (payload.type === "response.incomplete") {
      terminal = true;
      retainUsage(payload.response, true);
      yield* flushUnclosed(false);
      if (terminalError) return;
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
      const partKey = textPartKey(payload);
      if (partKey) {
        const previous = textParts.get(partKey);
        rememberTextPart(partKey, (previous?.text ?? "") + payload.delta,
          appendedUtf8Bytes(previous?.bytes ?? 0, previous?.last ?? 0, payload.delta), payload.delta.charCodeAt(payload.delta.length - 1));
      }
      appendText(itemId, payload.delta);
      yield* semantic({ type: "text_delta", text: payload.delta, ...(phase ? { phase } : {}) });
      return;
    }
    if (payload.type === "response.output_text.done" && typeof payload.text === "string") {
      const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
      const key = textPartKey(payload);
      if (key) {
        const previous = textParts.get(key)?.text ?? "";
        const delta = payload.text.startsWith(previous) ? payload.text.slice(previous.length) : "";
        rememberTextPart(key, payload.text, Buffer.byteLength(payload.text, "utf8"), payload.text.charCodeAt(payload.text.length - 1));
        if (delta) {
          appendText(itemId, delta);
          const phase = itemId ? phases.get(itemId) : undefined;
          yield* semantic({ type: "text_delta", text: delta, ...(phase ? { phase } : {}) });
        }
        return;
      }
      yield* emitNewText(payload.text, itemId ? phases.get(itemId) : undefined, itemId);
      return;
    }
    if (payload.type === "response.reasoning_summary_text.delta" && typeof payload.delta === "string" && payload.delta) {
      sawThinking = true;
      if (typeof payload.item_id === "string") {
        retainIdentity(`reasoning:${payload.item_id}`);
        thinkingItems.add(payload.item_id);
      }
      yield* semantic({ type: "thinking_delta", thinking: payload.delta });
      return;
    }
    if (payload.type === "response.reasoning_text.delta" && typeof payload.delta === "string" && payload.delta) {
      sawRawReasoning = true;
      if (typeof payload.item_id === "string") {
        retainIdentity(`reasoning:${payload.item_id}`);
        rawReasoningItems.add(payload.item_id);
      }
      yield* semantic({ type: "reasoning_raw_delta", text: payload.delta });
      return;
    }
    if (
      (payload.type === "response.function_call_arguments.delta" || payload.type === "response.custom_tool_call_input.delta")
      && typeof payload.delta === "string"
    ) {
      const key = typeof payload.item_id === "string" ? payload.item_id : undefined;
      if (!key) return;
      const state = ensureCall(key, "", "", payload.type === "response.custom_tool_call_input.delta" ? "custom_tool_call" : "function_call");
      yield* appendArgs(state, payload.delta);
      if (!state.started && !state.ended && payload.delta) yield { type: "heartbeat" };
      return;
    }
    if (payload.type === "response.function_call_arguments.done" || payload.type === "response.custom_tool_call_input.done") {
      const key = typeof payload.item_id === "string" ? payload.item_id : undefined;
      if (!key) return;
      const state = ensureCall(key, "", "", payload.type === "response.custom_tool_call_input.done" ? "custom_tool_call" : "function_call");
      rememberFull(state, payload.type === "response.custom_tool_call_input.done" ? payload.input : payload.arguments, true);
      state.argsDone = true;
      state.allowFull = true;
      yield* pump();
      return;
    }
    if (payload.type === "response.completed") {
      const response = isRecord(payload.response) ? payload.response : undefined;
      retainUsage(response);
      retainCompaction(response);
      if (response && Array.isArray(response.output)) {
        for (const item of response.output) {
          if (isRecord(item)) yield* consumeItem(item, true);
          if (terminalError) return;
        }
      }
      // Arguments.done confirms bytes, not executable item completion. Wait for the item's
      // status or the successful response terminal before dispatching its end marker.
      for (const state of calls.values()) {
        if (state.argsDone && !state.closed) yield* closeCall(state, true);
        if (terminalError) return;
      }
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

    const unfinished = [...calls.values()].some(state => !state.closed || state.incomplete);
    yield* flushUnclosed(false);
    if (terminal) return;
    if (unfinished) {
      yield { type: "incomplete", reason: "adapter_eof", ...(usage ? { usage } : {}) };
      return;
    }
    const done: AdapterEvent = {
      type: "done",
      ...(usage ? { usage } : {}),
      ...(compactionEncryptedContent ? { compactionEncryptedContent } : {}),
    };
    transferCompactionCiphertextLease(done, budget, compactionEncryptedContentBytes);
    ciphertextTransferred = true;
    yield done;
  } catch (error) {
    if (!(error instanceof ZedToolIdentityError) && !(error instanceof ZedToolArgumentsError) && !(error instanceof ZedJsonError)) throw error;
    retainUsage(undefined, true);
    yield* flushUnclosed(false, true);
    yield { type: "error", message: error.message, ...(usage ? { usage } : {}) };
  } finally {
    if (!ciphertextTransferred) budget.releaseRetained(compactionEncryptedContentBytes, { kind: "retained_collectors" });
    releaseStreamBuffers();
  }
}
