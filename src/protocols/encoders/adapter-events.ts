/**
 * AdapterEvent -> client wire, without the internal Responses SSE (PF-09).
 *
 * The routed Chat and Messages paths used to re-encode adapter events as Responses SSE
 * (`bridgeToResponsesSSE`) and then parse that SSE again into the client's wire
 * (`responsesSseToChatCompletionsSse`, `responsesSseToAnthropicSse`). This driver walks the
 * adapter events with the bridge's own item state machine and, where the bridge would emit a
 * Responses frame a client converter reacts to, calls the matching `ClientWireWriter` method
 * instead. The writers in `chat.ts` and `messages.ts` then apply the converters' mapping, so the
 * client-visible frames stay what they were.
 *
 * What is ported from `src/bridge/sse.ts`, and must stay in step with it:
 * - item boundaries: which event closes the open message, reasoning item, tool call or search,
 *   the signature-update grouping, hidden-thinking and redacted envelopes, the Kiro blob;
 * - tool naming (declared-name normalization, namespace mapping, freeform and tool-search
 *   classification), argument streaming gated on `toolCallArgumentsCouldBeJson`, the integral
 *   float repair on the completed arguments and the malformed-arguments failure;
 * - terminals: completed, truncated `done`, incomplete, error, adapter EOF, the stall watchdog,
 *   translator-budget overflow and the proxy-error catch, each with the bridge's usage and
 *   durability rules;
 * - the wire-silence heartbeat and stall ticks, pull-based stepping (one event's frames per
 *   pull) and cancellation, which stops the upstream exactly once.
 *
 * Not ported, because no Chat or Messages client observes it: Responses item ids and sequence
 * numbers, message phases, url_citation annotations, freeform input rewriting and remote
 * compaction (the server never encodes a compaction turn directly). Declared-tool enforcement is
 * off on both wires (#4735), so it is not applied here either. Replay-cache side effects and the
 * completed-response effects belong to the caller, which folds the same events with
 * `buildResponseJSON` at the terminal through `beforeTerminal`.
 */
import type { AdapterEvent, OcxMessagePhase, OcxProviderContinuationState, OcxUsage } from "../../types";
import { normalizeDeclaredToolName } from "../../types";
import { coerceIntegerToolArguments } from "../../lib/tool-argument-integers";
import { classifyError, isCyberPolicyCode, type OcxErrorPayload } from "../../lib/errors";
import { redactSecretString } from "../../lib/redact";
import { isTranslatorBudgetExceededError, type TranslatorBudget } from "../../lib/translator-budget";
import { createCitationMarkerFilter, type CitationMarkerFilter } from "../../responses/citation-markers";
import { isTruncatedStopReason, truncationReasonFor } from "../../responses/truncated-stop-reason";
import { safeWebSearchSources } from "../../web-search/sources";
import { resolveStallTimeoutSec } from "../../stall-timeout";
import type { RelayedEventObservation } from "../../usage/attempt-delivery";
import {
  adapterFailureFromEvent,
  toolCallArgumentsCouldBeJson,
  toolCallArgumentsUsable,
  uuid,
} from "../../bridge/internal";

export type ClientToolKind = "function" | "custom" | "tool_search";

export interface ClientToolCall {
  itemId: string;
  callId: string;
  /** Request-visible name: declared-name normalized, namespace mapping applied. */
  name: string;
  kind: ClientToolKind;
}

export interface ClientWebSearch {
  itemId: string;
  status: "completed" | "failed";
  queries: string[];
  sources: { url: string; title?: string }[];
}

/**
 * How the turn ended, in the shape the bridge's terminal Responses frame had. The caller builds
 * its request-log view from it; the writers map it to the client's finish/stop reason.
 */
export interface EncodedTerminal {
  status: "completed" | "incomplete" | "failed";
  usage?: OcxUsage;
  /** Whether the bridged terminal carried a usage object (`usage: null` otherwise). */
  usageOnWire: boolean;
  endTurn?: boolean;
  incomplete?: { reason: string; message?: string; retryable?: boolean };
  error?: OcxErrorPayload;
  retryable?: boolean;
  /** Translator-budget overflow: one bounded error frame and nothing else. */
  overflow?: true;
  /** A `done` event: the bridge handed this response to `onCompletedResponse`. */
  completedResponse: boolean;
  providerState?: OcxProviderContinuationState;
  /** Whether the bridge reported `usage` through `onUsage` for this terminal. */
  reportUsage: boolean;
  /** Whether the bridge awaited thought-signature durability before this terminal. */
  durable: boolean;
}

/** Frame output owned by the driver: budget reservation, delivery release and relay counts. */
export interface ClientFrameSink {
  readonly budget: TranslatorBudget;
  emit(text: string, observation?: RelayedEventObservation): void;
  /** Admit every frame before exposing any of them. */
  emitBatch(frames: { text: string; observation?: RelayedEventObservation }[]): void;
  /** A fixed, bounded frame that must reach the client even when the budget is exhausted. */
  emitBounded(text: string): void;
  /** A transport keepalive; it does not count as wire activity. */
  emitKeepalive(text: string): void;
  desiredSize(): number;
}

/** One method per Responses frame a Chat or Messages converter reacts to. */
export interface ClientWireWriter {
  start(): void;
  /** Wire silence while awaiting upstream (the bridge's heartbeat frame). */
  heartbeat(): void;
  text(delta: string): void;
  messageDone(): void;
  reasoning(delta: string, itemId: string, channel: "summary" | "raw"): void;
  reasoningDone(item: { itemId: string; signature?: string; redacted?: string[] }): void;
  toolStart(call: ClientToolCall): void;
  toolArgsDelta(itemId: string, delta: string): void;
  toolArgsDone(itemId: string, args: string): void;
  toolDone(call: ClientToolCall & { arguments: string; status: "completed" | "incomplete" }): void;
  webSearchDone(search: ClientWebSearch): void;
  terminal(terminal: EncodedTerminal): void;
  overflow(): void;
  /** Client cancellation: release anything the writer still holds. */
  dispose(): void;
}

export interface ClientEncodeHooks {
  /** First non-empty text or reasoning delta (TTFT), as the bridge reports it. */
  onFirstOutput?(): void;
  /** Before the terminal frames: the caller's fold, durability barrier and effects. */
  beforeTerminal?(terminal: EncodedTerminal): void | Promise<void>;
  /** After the terminal frames were admitted; called at most once. */
  afterTerminal?(terminal: EncodedTerminal): void;
  /** The bridge's `onCancel`: at the terminal and on client cancel, at most once. */
  stopUpstream?(): void;
  onClientCancel?(): void;
  onRelayed?(observation: RelayedEventObservation): void;
}

export interface AdapterEventEncodeOptions {
  translatorBudget: TranslatorBudget;
  hideThinkingSummary?: boolean;
  toolNsMap?: ReadonlyMap<string, { namespace: string; name: string; freeform?: true }>;
  declaredToolNames?: ReadonlySet<string>;
  toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>>;
  freeformToolNames?: ReadonlySet<string>;
  toolSearchToolNames?: ReadonlySet<string>;
  stallTimeoutSec?: number;
  /** Wire-silence heartbeat and stall tick; the bridge's 2 s default. */
  heartbeatMs?: number;
  hooks?: ClientEncodeHooks;
  /** Test seam for the beat and keepalive timers. */
  timers?: {
    setInterval: (handler: () => void, ms: number) => unknown;
    clearInterval: (id: unknown) => void;
  };
}

type OpenToolCall = ClientToolCall & { args: string; argsBytes: number; namespace?: string };

/** Drive `events` through `writer` as a pull-based byte stream. */
export function encodeAdapterEventStream(
  events: AsyncIterable<AdapterEvent>,
  createWriter: (sink: ClientFrameSink) => ClientWireWriter,
  options: AdapterEventEncodeOptions & { keepaliveMs?: number },
): ReadableStream<Uint8Array> {
  const budget = options.translatorBudget;
  const hooks = options.hooks ?? {};
  const heartbeatMs = options.heartbeatMs ?? 2_000;
  const setTimer = options.timers?.setInterval ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const clearTimer = options.timers?.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  const maxStallTicks = Math.ceil((resolveStallTimeoutSec(options.stallTimeoutSec) * 1000) / heartbeatMs);
  const textEncoder = new TextEncoder();

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let clientCancelled = false;
  let terminated = false;
  let terminalSettled = false;
  let stepping = false;
  let gated = false;
  let emittedFrames = 0;
  let upstreamActivity = false;
  let wireActivity = false;
  let stallTicks = 0;
  let beat: unknown;
  let keepalive: unknown;
  const queuedFrameBytes: number[] = [];

  const relayed = (observation?: RelayedEventObservation) => {
    try { hooks.onRelayed?.(observation ?? {}); } catch { /* counters never break the stream */ }
  };
  const enqueueCharged = (text: string, observation?: RelayedEventObservation, activity = true): void => {
    if (closed) return;
    const frame = textEncoder.encode(text);
    const reservation = budget.reserveTransient(frame.byteLength, { kind: "live_transient" });
    try {
      controller.enqueue(frame);
    } catch {
      reservation.release();
      closed = true;
      return;
    }
    reservation.commitRetained();
    queuedFrameBytes.push(frame.byteLength);
    emittedFrames++;
    if (activity) wireActivity = true;
    relayed(observation);
  };
  const sink: ClientFrameSink = {
    budget,
    emit: (text, observation) => enqueueCharged(text, observation),
    emitBatch: frames => {
      if (closed) return;
      const staged: { frame: Uint8Array; reservation: ReturnType<TranslatorBudget["reserveTransient"]>; observation?: RelayedEventObservation }[] = [];
      try {
        for (const { text, observation } of frames) {
          const frame = textEncoder.encode(text);
          staged.push({ frame, reservation: budget.reserveTransient(frame.byteLength, { kind: "live_transient" }), ...(observation ? { observation } : {}) });
        }
      } catch (error) {
        for (const entry of staged) entry.reservation.release();
        throw error;
      }
      for (const entry of staged) {
        if (closed) { entry.reservation.release(); continue; }
        try {
          controller.enqueue(entry.frame);
        } catch {
          entry.reservation.release();
          closed = true;
          continue;
        }
        entry.reservation.commitRetained();
        queuedFrameBytes.push(entry.frame.byteLength);
        emittedFrames++;
        relayed(entry.observation);
      }
      wireActivity = true;
    },
    emitBounded: text => {
      if (closed) return;
      try {
        controller.enqueue(textEncoder.encode(text));
        emittedFrames++;
        relayed({ terminal: true });
      } catch {
        closed = true;
      }
    },
    emitKeepalive: text => enqueueCharged(text, undefined, false),
    desiredSize: () => controller.desiredSize ?? 0,
  };
  const writer = createWriter(sink);

  const releaseDeliveredFrame = () => {
    const bytes = queuedFrameBytes.shift();
    if (bytes !== undefined) budget.releaseRetained(bytes, { kind: "live_transient" });
  };
  const stopTimers = () => {
    if (beat !== undefined) clearTimer(beat);
    if (keepalive !== undefined) clearTimer(keepalive);
    beat = undefined;
    keepalive = undefined;
  };
  const closeController = () => {
    if (closed) return;
    closed = true;
    try { controller.close(); } catch { /* already closed */ }
  };

  // Iterator ownership, as in the bridge: a return() before the first next() never enters the
  // generator, so its finally blocks could not cancel a prepared upstream body.
  const it = events[Symbol.asyncIterator]();
  let iteratorStarted = false;
  let iteratorReturned = false;
  let upstreamDone = false;
  const returnIterator = () => {
    if (iteratorReturned) return;
    iteratorReturned = true;
    const finishReturn = () => {
      try { void it.return?.()?.catch(() => {}); } catch { /* best-effort cleanup */ }
    };
    if (!iteratorStarted) {
      iteratorStarted = true;
      try { void it.next().then(finishReturn, () => {}).catch(() => {}); } catch { /* best-effort */ }
      return;
    }
    finishReturn();
  };
  let upstreamStopped = false;
  const stopUpstreamOnce = () => {
    if (upstreamStopped) return;
    upstreamStopped = true;
    try { hooks.stopUpstream?.(); } catch { /* cancellation must not strand the client stream */ }
    returnIterator();
  };
  const settleTerminal = (terminal: EncodedTerminal) => {
    if (terminalSettled || clientCancelled) return;
    terminalSettled = true;
    try { hooks.afterTerminal?.(terminal); } catch { /* terminal bookkeeping never breaks the stream */ }
  };
  /** Terminal paths the bridge runs synchronously (stall, overflow): never awaited. */
  const runBeforeTerminalSync = (terminal: EncodedTerminal) => {
    try { void Promise.resolve(hooks.beforeTerminal?.(terminal)).catch(() => {}); } catch { /* best-effort */ }
  };

  let firstOutputReported = false;
  const reportFirstOutput = (event: AdapterEvent) => {
    if (firstOutputReported) return;
    const nonEmpty = event.type === "text_delta" ? event.text.length > 0
      : event.type === "thinking_delta" ? event.thinking.length > 0
      : event.type === "reasoning_raw_delta" ? event.text.length > 0
      : false;
    if (!nonEmpty) return;
    firstOutputReported = true;
    try { hooks.onFirstOutput?.(); } catch { /* metrics must not break the stream */ }
  };

  // Item state, ported from bridgeToResponsesSSE.
  let currentMsg: { phase?: OcxMessagePhase; citationFilter: CitationMarkerFilter } | null = null;
  let currentReasoning: { itemId: string } | null = null;
  let currentRawReasoning: { itemId: string } | null = null;
  let pendingSignature: string | undefined;
  let pendingRedacted: string[] = [];
  let hiddenRawBytes = 0;
  let pendingKiroRedacted: string | undefined;
  let currentToolCall: OpenToolCall | null = null;
  let currentWebSearch: { itemId: string; eventId: string } | null = null;

  const takeReasoningEnvelope = (): { signature?: string; redacted?: string[] } | undefined => {
    if (!pendingSignature && pendingRedacted.length === 0) return undefined;
    const envelope = {
      ...(pendingSignature ? { signature: pendingSignature } : {}),
      ...(pendingRedacted.length > 0 ? { redacted: pendingRedacted } : {}),
    };
    pendingSignature = undefined;
    pendingRedacted = [];
    return envelope;
  };
  const closeCurrentMessage = () => {
    if (!currentMsg) return;
    // A citation span can straddle a delta boundary; the filter releases its held tail here.
    const trailing = currentMsg.citationFilter.flush();
    if (trailing) writer.text(trailing);
    writer.messageDone();
    currentMsg = null;
  };
  const closeCurrentReasoning = () => {
    if (!currentReasoning) return;
    const envelope = takeReasoningEnvelope();
    writer.reasoningDone({ itemId: currentReasoning.itemId, ...envelope });
    currentReasoning = null;
  };
  const closeCurrentRawReasoning = () => {
    if (!currentRawReasoning) return;
    writer.reasoningDone({ itemId: currentRawReasoning.itemId });
    currentRawReasoning = null;
  };
  // hideThinkingSummary: a signed or redacted block still round-trips as an envelope-only item.
  const flushHiddenReasoningEnvelope = () => {
    const envelope = takeReasoningEnvelope();
    if (!envelope) return;
    writer.reasoningDone({ itemId: `rs_${uuid()}`, ...envelope });
  };
  const flushHiddenRawReasoning = () => {
    if (hiddenRawBytes === 0) return;
    hiddenRawBytes = 0;
    writer.reasoningDone({ itemId: `rs_${uuid()}` });
  };
  // Kiro's blob lands after every item `done` closed, never on arrival (see the bridge).
  const flushKiroRedactedReasoning = () => {
    if (!pendingKiroRedacted) return;
    pendingKiroRedacted = undefined;
    writer.reasoningDone({ itemId: `rs_${uuid()}` });
  };
  const closeCurrentToolCall = () => {
    if (!currentToolCall) return;
    const call = currentToolCall;
    // Empty input serializes as "{}"; integral floats are repaired against the schema (#1611).
    const argsStr = coerceIntegerToolArguments(
      call.args || "{}",
      options.toolParameterSchemas?.get(call.name),
      call.namespace === undefined ? call.name : undefined,
    );
    if (call.kind === "function") writer.toolArgsDone(call.itemId, argsStr);
    writer.toolDone({
      itemId: call.itemId, callId: call.callId, name: call.name, kind: call.kind,
      arguments: call.kind === "function" ? argsStr : call.args,
      status: "completed",
    });
    budget.closeCall(call.callId);
    currentToolCall = null;
  };
  // Failed/incomplete terminal with an open call: no arguments-done frame, status incomplete.
  const failCurrentToolCall = () => {
    if (!currentToolCall) return;
    const call = currentToolCall;
    writer.toolDone({
      itemId: call.itemId, callId: call.callId, name: call.name, kind: call.kind,
      arguments: call.args || "{}",
      status: "incomplete",
    });
    budget.closeCall(call.callId);
    currentToolCall = null;
  };
  const closeCurrentWebSearch = (status: "completed" | "failed", queries: string[], sources?: { url: string; title?: string }[]) => {
    if (!currentWebSearch) return;
    writer.webSearchDone({ itemId: currentWebSearch.itemId, status, queries, sources: sources ?? [] });
    currentWebSearch = null;
  };
  const appendToolArgs = (call: OpenToolCall, fragment: string) => {
    const nextBytes = call.argsBytes + Buffer.byteLength(fragment);
    const scope = { kind: "tool_args" as const, ...(call.callId ? { callId: call.callId } : {}) };
    const reservation = budget.reserveTransient(nextBytes, scope);
    try {
      const value = call.args + fragment;
      reservation.commitRetained();
      budget.releaseRetained(call.argsBytes, scope);
      call.args = value;
      call.argsBytes = nextBytes;
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  const closeOpenItemsForTermination = (closeMessage: boolean) => {
    if (closeMessage) {
      if (currentMsg) closeCurrentMessage();
      if (currentReasoning) closeCurrentReasoning();
      if (currentRawReasoning) closeCurrentRawReasoning();
    }
    flushHiddenRawReasoning();
    if (currentToolCall) failCurrentToolCall();
    if (currentWebSearch) closeCurrentWebSearch("failed", []);
  };

  let handlingOverflow = false;
  const terminateForOverflow = () => {
    if (handlingOverflow || terminated || clientCancelled || closed) return;
    handlingOverflow = true;
    if (currentToolCall) {
      budget.closeCall(currentToolCall.callId);
      currentToolCall = null;
    }
    currentWebSearch = null;
    const terminal: EncodedTerminal = {
      status: "failed",
      error: adapterFailureFromEvent({
        type: "error",
        status: 502,
        errorType: "upstream_error",
        code: "translation_buffer_limit",
        message: "upstream translation buffer exceeded the safe limit",
      }).error,
      usageOnWire: false,
      overflow: true,
      completedResponse: false,
      reportUsage: false,
      durable: false,
    };
    runBeforeTerminalSync(terminal);
    try { writer.overflow(); } catch { /* the bounded frame is best-effort once the client is gone */ }
    settleTerminal(terminal);
    terminated = true;
    stopUpstreamOnce();
    stopTimers();
    closeController();
    gated = true;
    stepping = false;
  };
  /** The bridge's attemptTerminationCleanup: false when an overflow already ended the stream. */
  const cleanupForTermination = (action: () => void): boolean => {
    try {
      action();
      return !terminated && !closed;
    } catch (error) {
      if (!isTranslatorBudgetExceededError(error)) throw error;
      terminateForOverflow();
      return false;
    }
  };
  const deliverTerminal = async (terminal: EncodedTerminal): Promise<void> => {
    await hooks.beforeTerminal?.(terminal);
    writer.terminal(terminal);
    settleTerminal(terminal);
  };
  /** Terminal delivery outside the step try: an overflow while writing it ends the stream. */
  const deliverTerminalGuarded = async (terminal: EncodedTerminal): Promise<boolean> => {
    try {
      await deliverTerminal(terminal);
      return true;
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) terminateForOverflow();
      return false;
    }
  };

  const stall = () => {
    if (!cleanupForTermination(() => closeOpenItemsForTermination(true))) return;
    // Synchronous, like the bridge's beat callback: no durability barrier on this kill path.
    const terminal: EncodedTerminal = {
      status: "incomplete",
      incomplete: { reason: "upstream_stall_timeout" },
      usageOnWire: false,
      completedResponse: false,
      reportUsage: false,
      durable: false,
    };
    runBeforeTerminalSync(terminal);
    try {
      writer.terminal(terminal);
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) terminateForOverflow();
      return;
    }
    settleTerminal(terminal);
    stopUpstreamOnce();
    terminated = true;
    stopTimers();
    closeController();
  };

  const step = async (): Promise<void> => {
    if (stepping || closed) return;
    stepping = true;
    gated = false;
    const emittedAtStart = emittedFrames;
    try {
      while (!terminated && !closed && emittedFrames === emittedAtStart) {
        iteratorStarted = true;
        const next = await it.next();
        // A cancel during the await must not process or charge a late event.
        if (closed || clientCancelled) {
          gated = true;
          stepping = false;
          return;
        }
        if (next.done) { upstreamDone = true; break; }
        const event = next.value;
        let terminal: EncodedTerminal | undefined;
        upstreamActivity = true;
        stallTicks = 0;
        if (event.type !== "heartbeat" && event.type !== "thinking_signature" && event.type !== "kiro_redacted_reasoning") {
          wireActivity = true;
        }
        reportFirstOutput(event);
        // A signature update belongs to the current thinking block; the next semantic event
        // closes that block (or flushes the hidden envelope).
        if (pendingSignature !== undefined && event.type !== "thinking_signature" && event.type !== "heartbeat") {
          if (currentReasoning) closeCurrentReasoning();
          else flushHiddenReasoningEnvelope();
        }
        switch (event.type) {
          case "assistant_boundary": {
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) closeCurrentToolCall();
            flushHiddenReasoningEnvelope();
            break;
          }
          case "text_delta": {
            if (currentReasoning) closeCurrentReasoning();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) closeCurrentToolCall();
            // Only an explicit phase change starts a new message.
            if (currentMsg && event.phase !== undefined && currentMsg.phase !== event.phase) closeCurrentMessage();
            if (!currentMsg) {
              currentMsg = { citationFilter: createCitationMarkerFilter(), ...(event.phase ? { phase: event.phase } : {}) };
            }
            const visible = currentMsg.citationFilter.push(event.text);
            if (visible) writer.text(visible);
            break;
          }
          case "thinking_delta": {
            if (options.hideThinkingSummary) {
              flushHiddenRawReasoning();
              break;
            }
            if (currentMsg) closeCurrentMessage();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) closeCurrentToolCall();
            if (!currentReasoning) currentReasoning = { itemId: `rs_${uuid()}` };
            writer.reasoning(event.thinking, currentReasoning.itemId, "summary");
            break;
          }
          case "thinking_signature": {
            pendingSignature = event.signature;
            break;
          }
          case "redacted_thinking": {
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) closeCurrentToolCall();
            pendingRedacted.push(event.data);
            // A redacted block is complete on arrival.
            flushHiddenReasoningEnvelope();
            break;
          }
          case "kiro_redacted_reasoning": {
            pendingKiroRedacted = event.data;
            break;
          }
          case "reasoning_raw_delta": {
            if (options.hideThinkingSummary) {
              hiddenRawBytes += Buffer.byteLength(event.text);
              break;
            }
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentToolCall) closeCurrentToolCall();
            if (!currentRawReasoning) currentRawReasoning = { itemId: `rs_${uuid()}` };
            writer.reasoning(event.text, currentRawReasoning.itemId, "raw");
            break;
          }
          case "tool_call_start": {
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) closeCurrentToolCall();
            const effectiveName = normalizeDeclaredToolName(event.name, options.declaredToolNames);
            const mapped = options.toolNsMap?.get(effectiveName);
            const name = mapped?.name ?? effectiveName;
            const toolSearch = options.toolSearchToolNames?.has(name) ?? false;
            const freeform = !toolSearch && (mapped
              ? mapped.freeform === true
              : (options.freeformToolNames?.has(name) ?? false));
            const kind: ClientToolKind = toolSearch ? "tool_search" : freeform ? "custom" : "function";
            const itemId = `${toolSearch ? "tsc" : freeform ? "ctc" : "fc"}_${uuid()}`;
            const call: ClientToolCall = { itemId, callId: event.id, name, kind };
            writer.toolStart(call);
            currentToolCall = { ...call, args: "", argsBytes: 0, ...(mapped ? { namespace: mapped.namespace } : {}) };
            budget.openCall(event.id);
            break;
          }
          case "tool_call_delta": {
            if (!currentToolCall) break;
            appendToolArgs(currentToolCall, event.arguments);
            // Hold fragments whose buffer can never parse as JSON (#765).
            if (currentToolCall.kind === "function" && toolCallArgumentsCouldBeJson(currentToolCall.args)) {
              writer.toolArgsDelta(currentToolCall.itemId, event.arguments);
            }
            break;
          }
          case "tool_call_end": {
            // Streamed fragments cannot be repaired: unusable arguments fail the turn.
            if (currentToolCall && currentToolCall.kind === "function" && !toolCallArgumentsUsable(currentToolCall.args)) {
              failCurrentToolCall();
              terminal = {
                status: "failed",
                error: classifyError(502, "upstream_error", "upstream stream produced malformed tool call arguments"),
                usageOnWire: false,
                completedResponse: false,
                reportUsage: false,
                durable: false,
              };
              break;
            }
            closeCurrentToolCall();
            break;
          }
          case "web_search_call_begin": {
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) closeCurrentToolCall();
            if (currentWebSearch) closeCurrentWebSearch("completed", []);
            currentWebSearch = { itemId: `ws_${uuid()}`, eventId: event.id };
            break;
          }
          case "web_search_call_end": {
            if (!currentWebSearch || currentWebSearch.eventId !== event.id) {
              if (currentWebSearch) closeCurrentWebSearch("completed", []);
              currentWebSearch = { itemId: `ws_${uuid()}`, eventId: event.id };
            }
            closeCurrentWebSearch(event.status ?? "completed", event.queries, safeWebSearchSources(event.sources));
            break;
          }
          case "done": {
            const truncated = isTruncatedStopReason(event.stopReason);
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) {
              if (truncated) failCurrentToolCall();
              else closeCurrentToolCall();
            }
            if (currentWebSearch) closeCurrentWebSearch(truncated ? "failed" : "completed", []);
            flushHiddenReasoningEnvelope();
            flushKiroRedactedReasoning();
            const truncation = truncationReasonFor(event.stopReason);
            terminal = {
              status: truncation ? "incomplete" : "completed",
              ...(truncation ? { incomplete: { reason: truncation } } : {}),
              ...(event.usage ? { usage: event.usage } : {}),
              usageOnWire: true,
              ...(event.endTurn !== undefined ? { endTurn: event.endTurn } : {}),
              completedResponse: true,
              ...(event.providerState ? { providerState: event.providerState } : {}),
              reportUsage: true,
              durable: true,
            };
            break;
          }
          case "incomplete": {
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) failCurrentToolCall();
            if (currentWebSearch) closeCurrentWebSearch("failed", []);
            flushHiddenReasoningEnvelope();
            terminal = {
              status: "incomplete",
              incomplete: {
                reason: event.reason,
                ...(event.message ? { message: event.message } : {}),
                ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
              },
              ...(event.usage ? { usage: event.usage } : {}),
              usageOnWire: true,
              ...(event.endTurn !== undefined ? { endTurn: event.endTurn } : {}),
              completedResponse: false,
              reportUsage: true,
              durable: true,
            };
            break;
          }
          case "error": {
            if (event.code === "translation_buffer_limit") {
              terminateForOverflow();
              return;
            }
            if (currentMsg) closeCurrentMessage();
            if (currentReasoning) closeCurrentReasoning();
            if (currentRawReasoning) closeCurrentRawReasoning();
            flushHiddenRawReasoning();
            if (currentToolCall) failCurrentToolCall();
            if (currentWebSearch) closeCurrentWebSearch("failed", []);
            const failure = adapterFailureFromEvent(event);
            const retryable = isCyberPolicyCode(failure.error.code) ? false : event.retryable;
            terminal = {
              status: "failed",
              error: failure.error,
              ...(event.usage ? { usage: event.usage } : {}),
              usageOnWire: event.usage !== undefined,
              ...(retryable !== undefined ? { retryable } : {}),
              completedResponse: false,
              reportUsage: event.usage !== undefined,
              durable: true,
            };
            break;
          }
          default:
            break;
        }
        if (terminal) {
          await deliverTerminal(terminal);
          stopUpstreamOnce();
          terminated = true;
          break;
        }
      }
    } catch (err) {
      if (isTranslatorBudgetExceededError(err)) {
        terminateForOverflow();
        return;
      }
      if (!terminated && !closed) {
        if (!cleanupForTermination(() => closeOpenItemsForTermination(false))) return;
        const failure = classifyError(500, "proxy_error", redactSecretString(err instanceof Error ? err.message : String(err)));
        const terminal: EncodedTerminal = {
          status: "failed",
          error: failure,
          usageOnWire: false,
          ...(isCyberPolicyCode(failure.code) ? { retryable: false } : {}),
          completedResponse: false,
          reportUsage: false,
          durable: false,
        };
        try {
          if (!await deliverTerminalGuarded(terminal)) return;
        } catch { /* a failing hook on the failure path must not throw into the pull */ }
        stopUpstreamOnce();
        terminated = true;
      }
    }

    if (!terminated && !upstreamDone) {
      gated = true;
      stepping = false;
      return;
    }
    stopTimers();
    if (!terminated && !closed) {
      // The adapter generator ended without a terminal: a truncated stream, never a success.
      if (!cleanupForTermination(() => closeOpenItemsForTermination(true))) return;
      const terminal: EncodedTerminal = {
        status: "incomplete",
        incomplete: { reason: "adapter_eof" },
        usageOnWire: true,
        completedResponse: false,
        reportUsage: true,
        durable: true,
      };
      try {
        if (!await deliverTerminalGuarded(terminal)) return;
      } catch { /* see the catch path above */ }
      terminated = true;
    }
    closeController();
    gated = true;
    stepping = false;
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      try {
        writer.start();
      } catch (error) {
        if (isTranslatorBudgetExceededError(error)) terminateForOverflow();
        else throw error;
      }
      // Default HWM=1: one event's frames fill the queue, then stepping pauses until demand.
      gated = true;
      beat = setTimer(() => {
        if (closed || gated) return;
        if (upstreamActivity) {
          upstreamActivity = false;
          stallTicks = 0;
        } else if (++stallTicks >= maxStallTicks) {
          stall();
          return;
        }
        // Wire silence is independent of invisible upstream heartbeats.
        if (wireActivity) {
          wireActivity = false;
          return;
        }
        try { writer.heartbeat(); } catch { /* a keepalive never fails the stream */ }
      }, heartbeatMs);
      if (options.keepaliveMs !== undefined && options.keepaliveMs > 0) {
        keepalive = setTimer(() => {
          if (terminated || closed) return;
          try { writer.heartbeat(); } catch { /* the read loop is ending anyway */ }
        }, options.keepaliveMs);
      }
    },
    pull() {
      releaseDeliveredFrame();
      return step();
    },
    cancel() {
      // The client disconnected: stop emitting and stop the upstream turn (RC2).
      clientCancelled = true;
      closed = true;
      stopTimers();
      stopUpstreamOnce();
      while (queuedFrameBytes.length > 0) releaseDeliveredFrame();
      if (currentToolCall) {
        budget.closeCall(currentToolCall.callId);
        currentToolCall = null;
      }
      try { writer.dispose(); } catch { /* best-effort release */ }
      try { hooks.onClientCancel?.(); } catch { /* bookkeeping never throws into cancel */ }
    },
  });
}
