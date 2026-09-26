import type { OcxProviderConfig, RequestPacingRule } from "../types";
import type { GenerationContext } from "../lib/state-store-sweeper";
import { carryReplayRefusal, isNonReplayableResponse, markResponseNonReplayable } from "../lib/upstream-retry";
import { redactSecretString } from "../lib/redact";

export const REQUEST_PACING_MAX_QUEUE_DEPTH = 256;
export const REQUEST_PACING_MAX_QUEUE_AGE_MS = 60_000;
/**
 * A leased response body that is neither read nor cancelled for this long releases its
 * lease and cancels the body: a caller that dropped a Response without touching its body
 * must not hold a concurrency slot until process restart. The first pull or cancel swaps
 * this deadline for the longer inactivity window below.
 */
export const REQUEST_PACING_UNCONSUMED_BODY_MS = 30_000;
/**
 * Once a tracked body has been pulled at least once, this much silence reclaims its lease
 * and cancels the body: a consumer that reads part of a response and then abandons it
 * without cancel() (a clone-based peek that cancels only its own tee branch) must not
 * hold a concurrency slot forever either. The window is far longer than the unconsumed
 * deadline because a live consumer waiting on a slow upstream is indistinguishable from
 * an abandoned one at this layer; providers keep SSE connections alive with keep-alives
 * well inside this window.
 */
export const REQUEST_PACING_BODY_INACTIVITY_MS = 300_000;
/**
 * Retry-After floor for a waiter refused while blocked by a concurrency cap rather than
 * by a spacing interval. Interval readiness computes to zero under a pure cap, and the
 * 1s minimum would invite clients to re-hit a saturated provider every second, which is
 * the shared-account 429 churn this feature exists to prevent.
 */
export const REQUEST_PACING_CONCURRENCY_RETRY_AFTER_SECONDS = 5;

let maxQueueDepth = REQUEST_PACING_MAX_QUEUE_DEPTH;
let maxQueueAgeMs = REQUEST_PACING_MAX_QUEUE_AGE_MS;

export type RequestPacingQueueOverloadReason = "queue_full" | "queue_expired";

export class RequestPacingQueueOverloadError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly reason: RequestPacingQueueOverloadReason,
    public readonly retryAfterSeconds: number,
  ) {
    super(reason === "queue_full"
      ? `request pacing queue for provider '${providerName}' is full`
      : `request pacing queue for provider '${providerName}' exceeded the maximum queued age`);
    this.name = "RequestPacingQueueOverloadError";
  }
}

export class RequestPacingProviderRemovedError extends Error {
  constructor(public readonly providerName: string) {
    super(`request pacing provider '${providerName}' was removed`);
    this.name = "RequestPacingProviderRemovedError";
  }
}

interface Waiter {
  modelId?: string;
  providerIntervalMs: number;
  modelIntervalMs: number;
  providerMaxConcurrent: number;
  modelMaxConcurrent: number;
  queuedAt: number;
  signal?: AbortSignal;
  resolve: (slot: ProviderRequestSlot) => void;
  reject: (reason: unknown) => void;
  abort?: () => void;
}

interface ProviderPacer {
  queue: Waiter[];
  providerNextStartAt: number;
  modelNextStartAt: Map<string, number>;
  providerInFlight: number;
  modelInFlight: Map<string, number>;
  timer?: unknown;
  lastStartedAt?: number;
  lastModelId?: string;
}

/**
 * Lease returned by waitForProviderRequestSlot. Inert unless the provider (or the
 * request model override) sets maxConcurrentRequests; then release() returns the
 * concurrency slot when the upstream request finishes, whether that is body completion,
 * body cancellation, or a send that never produced a response.
 */
export interface ProviderRequestSlot {
  /** Provider identity for operator diagnostics: names the lease holder in deadline warnings. */
  readonly providerName?: string;
  /**
   * True only when this slot holds a concurrency lease whose release must follow the
   * upstream body lifecycle. Interval-only slots stay inert so response objects keep
   * their identity through the fetch path.
   */
  readonly leased: boolean;
  /**
   * True once a tracked response body owns this lease, meaning body completion, body
   * cancellation, or the unconsumed-body deadline will release it. Turn-end cleanup must
   * then leave the release to that lifecycle instead of returning the lease early.
   */
  readonly bodyTracked: boolean;
  /**
   * True once release() has run. A turn-scoped transport uses this to stop pacing by
   * interval after the lease it relied on is gone (a send that threw, a body that
   * closed) and re-acquire with concurrency, so the cap keeps counting its follow-ups.
   */
  readonly released: boolean;
  /** Idempotent. Safe to call from body completion, cancellation, and error paths alike. */
  release(): void;
}

/** Internal: leased slots expose this to trackProviderRequestSlotBody when a body takes over the release. */
interface BodyTrackableProviderRequestSlot extends ProviderRequestSlot {
  markBodyTracked(): void;
}

const inertProviderRequestSlot: ProviderRequestSlot = { leased: false, bodyTracked: false, released: false, release() {} };

export interface RequestPacingRuntime {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  enqueueMicrotask: (callback: () => void) => void;
}

export interface ProviderRequestPacingStatus {
  provider: string;
  enabled: boolean;
  queued: number;
  nextSlotInMs: number;
  inFlight?: number;
  lastStartedAt?: number;
  lastModelId?: string;
}

const pacers = new Map<string, ProviderPacer>();
const defaultRuntime: RequestPacingRuntime = {
  now: Date.now,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  enqueueMicrotask: queueMicrotask,
};
let runtime = defaultRuntime;
let lastReconciledGeneration = 0;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function normalizedInterval(rule: RequestPacingRule | undefined): number {
  if (!rule) return 0;
  const rpmInterval = typeof rule.requestsPerMinute === "number" && rule.requestsPerMinute > 0
    ? 60_000 / rule.requestsPerMinute
    : 0;
  const fixedInterval = typeof rule.minIntervalMs === "number" && rule.minIntervalMs > 0
    ? rule.minIntervalMs
    : 0;
  return Math.max(rpmInterval, fixedInterval);
}

function normalizedMaxConcurrent(rule: RequestPacingRule | undefined): number {
  return typeof rule?.maxConcurrentRequests === "number" && rule.maxConcurrentRequests > 0
    // Floor so runtime-injected configs that bypass the integer schema cannot admit
    // one request past the configured ceiling (a 2.5 cap must not let a third start);
    // clamp sub-1 fractionals up to 1 so a positive cap never degrades into none.
    ? Math.max(1, Math.floor(rule.maxConcurrentRequests))
    : 0;
}

export function requestPacingIntervalMs(provider: OcxProviderConfig, modelId?: string): number {
  const policy = provider.requestPacing;
  if (!policy?.enabled) return 0;
  const override = modelId ? policy.models?.[modelId] : undefined;
  return Math.max(normalizedInterval(policy), normalizedInterval(override));
}

function requestPacingIntervals(provider: OcxProviderConfig, modelId?: string): {
  providerIntervalMs: number;
  modelIntervalMs: number;
  providerMaxConcurrent: number;
  modelMaxConcurrent: number;
} {
  const policy = provider.requestPacing;
  if (!policy?.enabled) {
    return { providerIntervalMs: 0, modelIntervalMs: 0, providerMaxConcurrent: 0, modelMaxConcurrent: 0 };
  }
  return {
    providerIntervalMs: normalizedInterval(policy),
    modelIntervalMs: modelId ? normalizedInterval(policy.models?.[modelId]) : 0,
    providerMaxConcurrent: normalizedMaxConcurrent(policy),
    modelMaxConcurrent: modelId ? normalizedMaxConcurrent(policy.models?.[modelId]) : 0,
  };
}

/**
 * Whether a concurrency cap applies to this provider/model, expressed as the looser of
 * the two configured bounds. Enforcement gates the provider cap and the model cap
 * independently (a model override of 1 inside a provider cap of 5 admits one), so the
 * return value is a cap-presence signal — every current caller tests it for > 0 — and
 * NOT an effective ceiling. A caller that needs the true ceiling must compute
 * min(provider, model || Infinity) itself.
 */
export function requestPacingMaxConcurrentRequests(provider: OcxProviderConfig, modelId?: string): number {
  const limits = requestPacingIntervals(provider, modelId);
  return Math.max(limits.providerMaxConcurrent, limits.modelMaxConcurrent);
}

function waiterReadyAt(state: ProviderPacer, modelId: string | undefined): number {
  return Math.max(
    state.providerNextStartAt,
    modelId ? (state.modelNextStartAt.get(modelId) ?? 0) : 0,
  );
}

function pacingRetryAfterSeconds(
  state: ProviderPacer,
  modelId: string | undefined,
  now: number,
  concurrencyCapped = false,
): number {
  const intervalSeconds = Math.max(1, Math.ceil(Math.max(0, waiterReadyAt(state, modelId) - now) / 1000));
  // A waiter blocked by an in-flight lease has no interval to report: when the wait ends
  // in refusal, the honest answer is that the cap is saturated, not "retry every second".
  return concurrencyCapped
    ? Math.max(intervalSeconds, REQUEST_PACING_CONCURRENCY_RETRY_AFTER_SECONDS)
    : intervalSeconds;
}

function makeProviderRequestSlot(
  providerName: string,
  state: ProviderPacer,
  waiter: Waiter,
): BodyTrackableProviderRequestSlot {
  let released = false;
  let bodyTracked = false;
  const leased = waiter.providerMaxConcurrent > 0 || waiter.modelMaxConcurrent > 0;
  const slot: BodyTrackableProviderRequestSlot = {
    providerName,
    leased,
    get bodyTracked() {
      return bodyTracked;
    },
    get released() {
      return released;
    },
    markBodyTracked() {
      bodyTracked = true;
    },
    release() {
      if (released) return;
      released = true;
      waiter.signal?.removeEventListener("abort", releaseOnAbort);
      if (waiter.providerMaxConcurrent > 0 && state.providerInFlight > 0) state.providerInFlight -= 1;
      if (waiter.modelId && waiter.modelMaxConcurrent > 0) {
        const current = state.modelInFlight.get(waiter.modelId) ?? 0;
        if (current <= 1) state.modelInFlight.delete(waiter.modelId);
        else state.modelInFlight.set(waiter.modelId, current - 1);
      }
      runtime.enqueueMicrotask(() => {
        // A pending wake-up timer makes runQueue defer to it, but the lease that just
        // returned may admit a waiter the timer was never scheduled for, so take over.
        if (state.timer) {
          runtime.clearTimer(state.timer);
          state.timer = undefined;
        }
        runQueue(providerName, state);
      });
    },
  };
  const releaseOnAbort = (): void => slot.release();
  waiter.signal?.addEventListener("abort", releaseOnAbort, { once: true });
  if (waiter.signal?.aborted) slot.release();
  return slot;
}

function rejectExpiredWaiters(providerName: string, state: ProviderPacer, now: number): void {
  for (let index = state.queue.length - 1; index >= 0; index -= 1) {
    const waiter = state.queue[index]!;
    if (now - waiter.queuedAt < maxQueueAgeMs) continue;
    state.queue.splice(index, 1);
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    waiter.reject(new RequestPacingQueueOverloadError(
      providerName,
      "queue_expired",
      pacingRetryAfterSeconds(
        state,
        waiter.modelId,
        now,
        waiter.providerMaxConcurrent > 0 || waiter.modelMaxConcurrent > 0,
      ),
    ));
  }
}

function removeProviderPacer(providerName: string, state: ProviderPacer): void {
  if (state.timer) runtime.clearTimer(state.timer);
  state.timer = undefined;
  pacers.delete(providerName);
  const waiters = state.queue.splice(0);
  const error = new RequestPacingProviderRemovedError(providerName);
  for (const waiter of waiters) {
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    waiter.reject(error);
  }
}

function runQueue(providerName: string, state: ProviderPacer): void {
  if (state.queue.length === 0) {
    if (state.timer) runtime.clearTimer(state.timer);
    state.timer = undefined;
    return;
  }
  if (state.timer) return;
  const now = runtime.now();
  for (const [modelId, readyAt] of state.modelNextStartAt) {
    if (readyAt <= now) state.modelNextStartAt.delete(modelId);
  }
  rejectExpiredWaiters(providerName, state, now);
  if (state.queue.length === 0) return;

  const providerReadyAt = Math.max(now, state.providerNextStartAt);
  const waiterIndex = state.queue.findIndex(waiter => {
    if (waiter.providerMaxConcurrent > 0 && state.providerInFlight >= waiter.providerMaxConcurrent) return false;
    if (waiter.modelId && waiter.modelMaxConcurrent > 0
      && (state.modelInFlight.get(waiter.modelId) ?? 0) >= waiter.modelMaxConcurrent) return false;
    const modelReadyAt = waiter.modelId ? (state.modelNextStartAt.get(waiter.modelId) ?? 0) : 0;
    return Math.max(providerReadyAt, modelReadyAt) <= now;
  });
  if (waiterIndex < 0) {
    let earliestAt = Number.POSITIVE_INFINITY;
    for (const waiter of state.queue) {
      const modelReadyAt = waiter.modelId ? (state.modelNextStartAt.get(waiter.modelId) ?? 0) : 0;
      const readyAt = Math.max(providerReadyAt, modelReadyAt);
      const expiresAt = waiter.queuedAt + maxQueueAgeMs;
      // A waiter whose start time already passed is blocked on an in-flight lease; its release
      // re-runs this queue through a microtask, so the timer only needs its expiry backstop.
      // Scheduling for its readyAt (in the past) would spin the timer on every empty pass.
      earliestAt = Math.min(earliestAt, readyAt <= now ? Number.POSITIVE_INFINITY : readyAt, expiresAt);
    }
    // Unreachable for a non-empty queue: rejectExpiredWaiters above removed every waiter
    // whose expiresAt passed, so each remaining one contributes a finite value. Kept as a
    // belt-and-braces backstop rather than a case future readers should hunt for.
    if (!Number.isFinite(earliestAt)) return;
    const delayMs = Math.max(0, earliestAt - now);
    state.timer = runtime.setTimer(() => {
      state.timer = undefined;
      runQueue(providerName, state);
    }, delayMs);
    return;
  }
  const waiter = state.queue[waiterIndex]!;
  state.queue.splice(waiterIndex, 1);
  if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
  const startedAt = runtime.now();
  state.lastStartedAt = startedAt;
  state.lastModelId = waiter.modelId;
  state.providerNextStartAt = startedAt + waiter.providerIntervalMs;
  if (waiter.modelId && waiter.modelIntervalMs > 0) {
    state.modelNextStartAt.set(waiter.modelId, startedAt + waiter.modelIntervalMs);
  }
  if (waiter.providerMaxConcurrent > 0) state.providerInFlight += 1;
  if (waiter.modelId && waiter.modelMaxConcurrent > 0) {
    state.modelInFlight.set(waiter.modelId, (state.modelInFlight.get(waiter.modelId) ?? 0) + 1);
  }
  waiter.resolve(makeProviderRequestSlot(providerName, state, waiter));
  runtime.enqueueMicrotask(() => runQueue(providerName, state));
}

export async function waitForProviderRequestSlot(
  providerName: string,
  provider: OcxProviderConfig,
  modelId?: string,
  signal?: AbortSignal,
  options?: { concurrency?: boolean },
): Promise<ProviderRequestSlot> {
  const intervals = requestPacingIntervals(provider, modelId);
  // A turn-scoped transport sends several physical requests per logical turn (Cursor
  // HTTP/1.1 RunSSE plus BidiAppends). One lease covers the turn; follow-up sends pace
  // by interval only, or a follow-up would queue behind the lease its own turn holds.
  const concurrency = options?.concurrency !== false;
  const waiterIntervals = concurrency ? intervals : {
    providerIntervalMs: intervals.providerIntervalMs,
    modelIntervalMs: intervals.modelIntervalMs,
    providerMaxConcurrent: 0,
    modelMaxConcurrent: 0,
  };
  const paced = Math.max(intervals.providerIntervalMs, intervals.modelIntervalMs) > 0
    || waiterIntervals.providerMaxConcurrent > 0
    || waiterIntervals.modelMaxConcurrent > 0;
  if (!paced) return inertProviderRequestSlot;
  if (signal?.aborted) throw abortReason(signal);

  const state = pacers.get(providerName) ?? {
    queue: [], providerNextStartAt: 0, modelNextStartAt: new Map<string, number>(),
    providerInFlight: 0, modelInFlight: new Map<string, number>(),
  };
  pacers.set(providerName, state);

  // Give already-eligible or expired waiters a chance to leave before applying the
  // admission bound to the newest request. This preserves FIFO-ish fairness while
  // keeping the retained queue strictly bounded under burst load.
  if (state.timer) {
    runtime.clearTimer(state.timer);
    state.timer = undefined;
  }
  runQueue(providerName, state);
  if (state.queue.length >= maxQueueDepth) {
    throw new RequestPacingQueueOverloadError(
      providerName,
      "queue_full",
      pacingRetryAfterSeconds(
        state,
        modelId,
        runtime.now(),
        waiterIntervals.providerMaxConcurrent > 0 || waiterIntervals.modelMaxConcurrent > 0,
      ),
    );
  }

  return await new Promise<ProviderRequestSlot>((resolve, reject) => {
    const waiter: Waiter = {
      modelId,
      ...waiterIntervals,
      queuedAt: runtime.now(),
      signal,
      resolve,
      reject,
    };
    waiter.abort = () => {
      const index = state.queue.indexOf(waiter);
      if (index >= 0) state.queue.splice(index, 1);
      if (state.timer) {
        runtime.clearTimer(state.timer);
        state.timer = undefined;
      }
      reject(abortReason(signal!));
      runQueue(providerName, state);
    };
    signal?.addEventListener("abort", waiter.abort, { once: true });
    state.queue.push(waiter);
    // Abort may race between the eager check above and listener registration.
    if (signal?.aborted) {
      waiter.abort();
      return;
    }
    if (state.timer) {
      runtime.clearTimer(state.timer);
      state.timer = undefined;
    }
    runQueue(providerName, state);
  });
}

/**
 * Tie a pacing slot lease to an upstream response body: the lease is released when the
 * body completes, errors, or is cancelled by the consumer. A null body (204/304/HEAD)
 * means the exchange is already finished, so the lease returns immediately. A body that
 * is neither read nor cancelled for REQUEST_PACING_UNCONSUMED_BODY_MS releases its lease
 * and cancels the body, so a dropped Response cannot hold a slot forever. The returned
 * Response preserves status, statusText, headers, and the identity-based replay markers.
 */
export function trackProviderRequestSlotBody(
  slot: ProviderRequestSlot | undefined,
  response: Response,
): Response {
  // An unleased slot has nothing to return on body close, and rewrapping the Response
  // would break identity-based markers (the eager WS relay registry is a WeakSet).
  if (!slot?.leased) return response;
  // Slots built outside waitForProviderRequestSlot (test doubles) satisfy only the public
  // ProviderRequestSlot shape; their bodies still own the release through the wrapper below.
  (slot as Partial<BodyTrackableProviderRequestSlot>).markBodyTracked?.();
  if (!response.body) {
    slot.release();
    return response;
  }
  const source = response.body;
  let released = false;
  // Set when a deadline callback cancelled the source: the truncation must surface as a
  // stream error on the next pull, never as a clean EOF a relay would treat as success.
  let expired = false;
  let expiryTimer: unknown;
  let expiryKind: "unconsumed" | "inactive" = "unconsumed";
  const clearExpiryTimer = (): void => {
    if (expiryTimer === undefined) return;
    runtime.clearTimer(expiryTimer);
    expiryTimer = undefined;
  };
  const release = (): void => {
    if (released) return;
    released = true;
    clearExpiryTimer();
    slot.release();
  };
  const armExpiryTimer = (delayMs: number, kind: "unconsumed" | "inactive"): void => {
    clearExpiryTimer();
    expiryKind = kind;
    expiryTimer = runtime.setTimer(() => {
      expiryTimer = undefined;
      if (released) return;
      expired = true;
      release();
      // Cancel through the reader when one exists: after the first pull the source is
      // locked to it, and cancelling a locked stream rejects without releasing the
      // socket — the exact upstream leak this deadline exists to prevent.
      void (reader ?? source).cancel().catch(() => {});
      const who = slot.providerName === undefined ? "" : ` for provider ${JSON.stringify(redactSecretString(slot.providerName))}`;
      console.warn(
        expiryKind === "inactive"
          ? `[opencodex] requestPacing${who} released a concurrency lease after `
            + REQUEST_PACING_BODY_INACTIVITY_MS
            + "ms of response body inactivity; the body was cancelled."
          : `[opencodex] requestPacing${who} released a concurrency lease after `
            + REQUEST_PACING_UNCONSUMED_BODY_MS
            + "ms because the provider response body was neither read nor cancelled; the body was cancelled.",
      );
    }, delayMs);
  };
  armExpiryTimer(REQUEST_PACING_UNCONSUMED_BODY_MS, "unconsumed");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const tracked = new ReadableStream<Uint8Array>({
    pull: async controller => {
      // A pull proves a consumer is attached, not that it will keep reading: re-arm a
      // longer inactivity deadline instead of disarming. A body read once and then
      // abandoned (a clone-based peek that cancels only its own tee branch) must still
      // return its lease, while a live stream keeps pushing the deadline back per pull.
      if (!released) armExpiryTimer(REQUEST_PACING_BODY_INACTIVITY_MS, "inactive");
      try {
        // Inside the try: a source another reader already locked makes getReader()
        // throw, and with the deadline disarmed above that failure must release the
        // lease here instead of stranding it for the process lifetime.
        reader ??= source.getReader();
        const { done, value } = await reader.read();
        // A consumer cancel while this read was pending resolves it (done or a late chunk);
        // touching the cancelled controller would throw from the pull algorithm.
        if (cancelled) return;
        if (expired) {
          // The deadline cancelled the source mid-stream; report the truncation as an
          // error instead of letting the cancelled read's done flag close the stream.
          controller.error(new Error(
            "[opencodex] requestPacing cancelled the response body after its lease deadline",
          ));
          return;
        }
        if (done) {
          controller.close();
          release();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (cancelled) return;
        release();
        controller.error(error);
      }
    },
    cancel: reason => {
      cancelled = true;
      clearExpiryTimer();
      release();
      return (reader ?? source).cancel(reason);
    },
  }, {
    // A default-count stream pulls once at construction with no reader attached, which
    // would mark the body consumed and disarm the deadline before any real consumer
    // arrives. Zero capacity keeps pull consumer-driven: the first read arms nothing
    // until a reader actually asks for bytes.
    highWaterMark: 0,
  });
  let wrapped: Response;
  try {
    wrapped = new Response(tracked, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    // A non-conforming status (a proxy passing a raw 6xx through) or a body on a
    // null-body status throws here after markBodyTracked, and boundary cleanup skips
    // body-tracked slots: return the lease now instead of waiting out the deadline.
    // The abandoned rewrap never locked the source (no pull ran), so hand back the
    // ORIGINAL response with its body intact: rethrowing would make the google-http,
    // command-code and mimo retry ladders replay a request whose response did arrive.
    release();
    return response;
  }
  // Retry helpers mark the response they return from, and recovery decisions key on these
  // identity markers; the rewrap must not make a non-replayable response look replayable.
  if (isNonReplayableResponse(response)) markResponseNonReplayable(wrapped);
  return carryReplayRefusal(response, wrapped);
}

/**
 * Return a lease at a turn or attempt boundary: a lease a tracked response body now owns
 * is left to that body's lifecycle, and any other unconsumed lease is released. Idempotent,
 * and a no-op for interval-only slots, so every boundary can call it unconditionally.
 */
export function releaseProviderRequestSlot(slot: ProviderRequestSlot | undefined): void {
  if (!slot || slot.bodyTracked) return;
  slot.release();
}

/** Transfer a physical send's lease to its response body, or release it on failure. */
export async function sendTrackingRequestSlot(
  slot: ProviderRequestSlot | undefined,
  send: () => Promise<Response>,
): Promise<Response> {
  try {
    return trackProviderRequestSlotBody(slot, await send());
  } catch (error) {
    slot?.release();
    throw error;
  }
}

/**
 * Acquire one pacing lease and return it at the boundary. The send callback runs with
 * the lease; this helper releases it unless a tracked response body has taken ownership.
 * A send that throws (an abort, a send-budget refusal, a build failure) or returns
 * without ever dispatching through the executor would otherwise strand the lease for
 * the process lifetime, and a dispatched send's tracked body keeps its own release.
 * Centralized so every dispatch boundary shares one copy of the acquire/release pairing
 * and a future edit cannot fork the lease lifecycle.
 */
export async function withProviderRequestSlot<T>(
  providerName: string,
  provider: OcxProviderConfig,
  modelId: string | undefined,
  signal: AbortSignal | undefined,
  send: (pacingSlot: ProviderRequestSlot) => Promise<T>,
): Promise<T> {
  const pacingSlot = await waitForProviderRequestSlot(providerName, provider, modelId, signal);
  try {
    return await send(pacingSlot);
  } finally {
    releaseProviderRequestSlot(pacingSlot);
  }
}

export function providerRequestPacingStatus(
  providerName: string,
  provider: OcxProviderConfig,
  now = runtime.now(),
): ProviderRequestPacingStatus {
  const state = pacers.get(providerName);
  let nextSlotAt = state?.providerNextStartAt ?? 0;
  if (state && state.queue.length > 0) {
    let earliestQueuedSlotAt = Number.POSITIVE_INFINITY;
    for (const waiter of state.queue) {
      earliestQueuedSlotAt = Math.min(earliestQueuedSlotAt, waiterReadyAt(state, waiter.modelId));
    }
    if (Number.isFinite(earliestQueuedSlotAt)) nextSlotAt = earliestQueuedSlotAt;
  }
  const providerConcurrencyCap = requestPacingMaxConcurrentRequests(provider);
  // Gate on enabled so the status surface agrees with enforcement: a disabled requestPacing
  // block must not report in-flight leases alongside enabled: false.
  const anyConcurrencyCap = provider.requestPacing?.enabled === true && (providerConcurrencyCap > 0
    || Object.values(provider.requestPacing?.models ?? {}).some(rule => normalizedMaxConcurrent(rule) > 0));
  return {
    provider: providerName,
    enabled: provider.requestPacing?.enabled === true,
    queued: state?.queue.length ?? 0,
    nextSlotInMs: Math.max(0, Math.ceil(nextSlotAt - now)),
    // A provider cap counts every paced send in providerInFlight; model-only caps keep
    // providerInFlight at zero, so report the per-model sum for those providers instead.
    ...(anyConcurrencyCap ? {
      inFlight: providerConcurrencyCap > 0
        ? state?.providerInFlight ?? 0
        : [...(state?.modelInFlight.values() ?? [])].reduce((sum, count) => sum + count, 0),
    } : {}),
    ...(state?.lastStartedAt !== undefined ? { lastStartedAt: state.lastStartedAt } : {}),
    ...(state?.lastModelId ? { lastModelId: state.lastModelId } : {}),
  };
}

export function setProviderRequestPacingLimitsForTest(limits: {
  maxQueueDepth?: number;
  maxQueueAgeMs?: number;
}): void {
  if (limits.maxQueueDepth !== undefined) maxQueueDepth = limits.maxQueueDepth;
  if (limits.maxQueueAgeMs !== undefined) maxQueueAgeMs = limits.maxQueueAgeMs;
}

export function setProviderRequestPacingRuntimeForTest(nextRuntime: RequestPacingRuntime): void {
  runtime = nextRuntime;
}

export function reconcileProviderRequestPacing(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const [providerName, state] of pacers) {
    if (context.providerNames.has(providerName)) continue;
    removeProviderPacer(providerName, state);
    removed += 1;
  }
  lastReconciledGeneration = context.generation;
  return removed;
}

export function resetProviderRequestPacingForTest(): void {
  for (const state of pacers.values()) if (state.timer) runtime.clearTimer(state.timer);
  pacers.clear();
  maxQueueDepth = REQUEST_PACING_MAX_QUEUE_DEPTH;
  maxQueueAgeMs = REQUEST_PACING_MAX_QUEUE_AGE_MS;
  runtime = defaultRuntime;
  lastReconciledGeneration = 0;
}
