/**
 * Retry guard for upstream fetches that die on stale pooled keep-alive sockets.
 *
 * chatgpt.com (Cloudflare) closes idle keep-alive connections server-side; Bun's fetch pool
 * reuses the half-closed socket and a request can fail before response headers arrive.
 * A pre-header rejection does not prove that the origin did not process the request.
 * Mechanically reusable bytes do not make a model POST idempotent: an ambiguous reset
 * becomes a terminal, non-replayable response unless the operation is explicitly safe.
 *
 * Deliberately narrow: timeouts, aborts, ECONNREFUSED/DNS/TLS failures, and HTTP error
 * statuses (returned as Response, never thrown) are NOT retried. The Responses transport
 * separately permits one post-header replacement only after its eager SSE preflight has
 * observed response.created and no protocol output event.
 *
 * MUST stay a leaf module: imports nothing from server.ts or adapters (kiro-retry imports
 * the shared abort helpers from here).
 */
import { clearableDeadline } from "./abort";
import { redactSecretString } from "./redact";

/**
 * Responses the origin may already be executing. RFC 9110 §9.2.2 forbids an intermediary
 * from automatically repeating a non-idempotent request; when a post-send transport (the
 * Codex WebSocket relay) settles a gateway status because the origin never acknowledged the
 * turn, the request body must not be sent again by this process — not by the transient-5xx
 * layer below, not by a pool account rotation, not by a combo hop. The status is returned
 * to the caller so the user agent can apply its own retry policy, exactly as it does on the
 * direct path. The WeakSet is the in-process marker; the structured error codes are the
 * marker that survives body re-wrapping (combo failure consumption re-parses the JSON).
 */
const nonReplayableResponses = new WeakSet<Response>();

export function markResponseNonReplayable(response: Response): void {
  nonReplayableResponses.add(response);
}

export function isNonReplayableResponse(response: Response): boolean {
  return nonReplayableResponses.has(response);
}

/**
 * The narrower marker: responses this proxy synthesized as a replay refusal.
 *
 * {@link isNonReplayableResponse} answers "must not be sent again", which the WebSocket
 * post-send verdicts share. This one answers "the upstream never said this", and that is the
 * question a quota recorder or a `Retry-After` synthesizer has to ask. Both were written for
 * a status that only ever arrived from a provider, so a synthetic 429 reads to them as a
 * credential that rate-limited us and as a wait worth honouring -- one writes a cooldown
 * against a credential that refused nothing, the other instructs the client to send the turn
 * again. A marker rather than a body check, because it has to be answerable before the body
 * is read and cannot be spoofed by an upstream that happens to echo the code.
 */
const replayRefusalResponses = new WeakSet<Response>();

export function markReplayRefusalResponse(response: Response): void {
  replayRefusalResponses.add(response);
}

export function isReplayRefusalResponse(response: Response): boolean {
  return replayRefusalResponses.has(response);
}

/** Origin never produced a response event; the turn may still be executing. */
export const UPSTREAM_NO_RESPONSE_CODE = "upstream_no_response";
/** Transport closed after the send, before any response event. */
export const UPSTREAM_CLOSED_BEFORE_RESPONSE_CODE = "upstream_closed_before_response";
/**
 * This proxy refused to replay a pre-header fetch rejection.
 *
 * Distinct from {@link UPSTREAM_CLOSED_BEFORE_RESPONSE_CODE}, which the Codex WebSocket
 * transport settles as a 502 after the create frame was already sent. Both are ambiguous,
 * but only this one is a refusal this process made before any response existed, so it
 * follows the send-budget precedent and answers 429: the Codex client is configured with
 * `retry_429: false` and `retry_5xx: true` over four attempts, so a 5xx here multiplies
 * the duplicate send the refusal exists to prevent. See
 * structure/transports/responses.md#ambiguous-connection-reset-replay-boundary.
 */
export const UPSTREAM_RESET_REPLAY_REFUSED_CODE = "upstream_reset_replay_refused";
const NON_REPLAYABLE_UPSTREAM_CODES: ReadonlySet<string> = new Set([
  UPSTREAM_NO_RESPONSE_CODE,
  UPSTREAM_CLOSED_BEFORE_RESPONSE_CODE,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
]);

export function isNonReplayableUpstreamCode(code: unknown): boolean {
  return typeof code === "string" && NON_REPLAYABLE_UPSTREAM_CODES.has(code);
}

/**
 * True for the one non-replayable code this proxy owns end to end. The status it carries is
 * a local decision, so a re-wrapping formatter must restate it rather than inherit the
 * caller's upstream-shaped status.
 */
export function isReplayRefusalCode(code: unknown): boolean {
  return code === UPSTREAM_RESET_REPLAY_REFUSED_CODE;
}

/** Client-facing status for {@link UPSTREAM_RESET_REPLAY_REFUSED_CODE}. */
export const REPLAY_REFUSED_STATUS = 429;

// 1 initial + 2 retries: the pool may hold more than one stale socket.
const RESET_RETRY_MAX_ATTEMPTS = 3;
const RESET_RETRY_BASE_DELAY_MS = 150;
const RESET_RETRY_MAX_DELAY_MS = 1_000;

// Transient-5xx status retry layer (pre-stream only; devlog/_plan/260716_claudecode_hardening/010).
/** Total sends one transient-retry helper call may make: 1 initial + 2 retries. */
export const TRANSIENT_RETRY_MAX_ATTEMPTS = 3;

/**
 * Transient sends already spent by one LOGICAL request.
 *
 * A mutable holder rather than a counter local to one call frame, because the thing that has to
 * share it spans frames: a combo parent runs a separate child turn per target, and a per-child
 * counter is what let one logical request reach upstream three times per target (#4546).
 */
export interface TransientSendBudget {
  used: number;
}

export function createTransientSendBudget(): TransientSendBudget {
  return { used: 0 };
}

/**
 * Refusal raised when a logical request has no send left (#4546, REQ-B04/B05).
 *
 * It is deliberately a distinct type rather than a generic `Error`: every call site that
 * catches a helper rejection today launders it into HTTP 502 `upstream_error`, which would
 * report a proxy-side budget decision as an upstream fault and hide the real 401/429 the
 * request already had. Callers must recognise this and return the structured local error
 * instead. It is a backstop, not the policy -- a call site that still holds a reusable
 * upstream response is supposed to check the remainder BEFORE it cancels that body.
 */
export class SendBudgetExhaustedError extends Error {
  readonly code = "request_send_budget_exhausted";
  constructor(label?: string) {
    super(label
      ? `request send budget exhausted before dispatch (${label})`
      : "request send budget exhausted before dispatch");
    this.name = "SendBudgetExhaustedError";
  }
}

/**
 * Configuration refusal for an attempts value that is not a send count.
 *
 * `undefined` means "use the policy default" and `0` means "refuse". A negative, fractional,
 * NaN or infinite value is a programming or configuration error, and silently substituting the
 * default for it is how a broken budget turns back into three free sends.
 */
export class InvalidSendBudgetError extends Error {
  constructor(value: unknown) {
    super(`invalid upstream send budget: ${String(value)}`);
    this.name = "InvalidSendBudgetError";
  }
}

function normalizeSendAttempts(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new InvalidSendBudgetError(value);
  return value;
}
const TRANSIENT_RETRY_BASE_DELAY_MS = 400;
const TRANSIENT_RETRY_MAX_DELAY_MS = 5_000;
// A failed attempt slower than this is the "slow 502" incident shape (191s observed on
// 2026-07-15): retrying it only duplicates upstream load past client timeouts — return it.
const TRANSIENT_RETRY_SLOW_ATTEMPT_MS = 15_000;

/**
 * Upstream statuses treated as transient: gateway errors and Cloudflare 52x.
 * 500 is included per the OpenAI SDK default (auto-retries >=500; Tier-2 proven in
 * devlog/260716_ocx_claude_sol_502_midstream/02). 507 was observed in the 48h ledger
 * but is deliberately excluded (storage-class, not gateway-transient).
 */
export function isTransientUpstreamStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504
    || status === 520 || status === 521 || status === 522;
}

export interface RetryBackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  headers?: Headers;
  /**
   * Treat a provider's `Retry-After` as the earliest legal send rather than something the
   * local maximum may shorten. Opt-in per caller so the change lands on the transient path
   * first instead of silently lengthening every adapter's backoff.
   */
  retryAfterIsLowerBound?: boolean;
  /**
   * The wait deadline a caller applies to an honoured `Retry-After`. The delay itself is
   * never shortened: an instruction longer than the deadline is a reason to END with the
   * upstream answer, not to send early. Kept for callers that still pass it.
   */
  retryAfterCeilingMs?: number;
}

/** One minute, matching the same-target 429 ceiling the key-failover path already uses. */
export const RETRY_AFTER_CEILING_MS = 60_000;

export function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Best-effort, bounded cancellation of a response body before a retry backoff.
 *
 * The 429 paths release the unread body before waiting so sockets do not accumulate under a
 * rate-limit storm, but a never-settling `cancel()` promise must not be able to block the
 * abort-aware backoff (client cancel, `maxIntervalMs`, or the cumulative header deadline).
 * Cancellation is started and its rejection observed; the await is bounded by `timeoutMs`
 * and the abort signal. This mirrors the rotation-path guarantee (release is initiated, not
 * awaited forever) while preserving the resource-release intent of the same-target paths.
 */
export async function releaseResponseBodyBestEffort(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal | undefined,
  timeoutMs = 1_000,
): Promise<void> {
  if (!body) return;
  if (signal?.aborted) {
    void body.cancel().catch(() => {});
    return;
  }
  const cancel = body.cancel().catch(() => {});
  if (!signal) {
    await Promise.race([cancel, new Promise<void>(resolve => setTimeout(resolve, timeoutMs))]);
    return;
  }
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    /**
     * Abort hook: clear the bounded-body release timer and settle the promise so a
     * never-settling cancel() can never block the abort-aware backoff.
     */
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    void cancel.then(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Abort-aware sleep that yields an adapter `heartbeat` at least every `heartbeatIntervalMs`.
 * The Responses bridge treats a returned iterator event as upstream liveness and aborts turns
 * that stay silent past the stall budget (default 300s), while a retryOn429 wait may legally
 * reach 600s — so deliberate waits must keep the watchdog fed or a long backoff is killed
 * mid-turn. The final chunk always yields once, which doubles as the post-wait liveness beat.
 */
export async function* sleepWithHeartbeats(
  ms: number,
  signal?: AbortSignal,
  heartbeatIntervalMs = 10_000,
): AsyncGenerator<{ type: "heartbeat" }> {
  if (ms <= 0) return;
  // Guard against a non-positive interval: a zero/negative step would spin the loop forever
  // while sleepWithAbort early-returns without ever observing the abort signal. NaN must be
  // normalized too: Math.max(1, NaN) is NaN, which would abort the wait after one beat.
  const stepMs = Number.isNaN(heartbeatIntervalMs) ? 1 : Math.max(1, heartbeatIntervalMs);
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, stepMs);
    await sleepWithAbort(chunk, signal);
    remaining -= chunk;
    yield { type: "heartbeat" };
  }
}

export interface SameTarget429WaitOptions {
  body: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
  delayMs: number;
  /**
   * When set, the wait yields adapter heartbeats so bridge stall watchdogs stay fed.
   * Omit for pre-stream recovery paths that have no stall watchdog.
   */
  heartbeatIntervalMs?: number;
}

/**
 * Shared pre-replay prep for opt-in same-target 429 waits:
 * release the unread 429 body, then sleep (optionally with heartbeats).
 * Callers still own attempt budgeting, abort re-checks, and the replay itself.
 */
export async function* prepareSameTarget429Wait(
  options: SameTarget429WaitOptions,
): AsyncGenerator<{ type: "heartbeat" }> {
  await releaseResponseBodyBestEffort(options.body, options.signal);
  if (options.heartbeatIntervalMs === undefined) {
    await sleepWithAbort(options.delayMs, options.signal);
    return;
  }
  yield* sleepWithHeartbeats(options.delayMs, options.signal, options.heartbeatIntervalMs);
}

export function isConnectionResetError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Aborts and timeouts are caller decisions / honest failures — never retryable.
  if (err.name === "AbortError" || err.name === "TimeoutError") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ECONNRESET" || code === "EPIPE") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("socket connection was closed unexpectedly")
    || msg.includes("connection reset by peer");
}

function retryAfterDelayMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

export function retryBackoffDelayMs(attempt: number, opts: RetryBackoffOptions): number {
  const retryAfter = opts.headers ? retryAfterDelayMs(opts.headers) : undefined;
  const exp = Math.min(opts.baseDelayMs * (2 ** attempt), opts.maxDelayMs);
  const jittered = Math.floor(exp * (0.8 + Math.random() * 0.4));
  if (retryAfter === undefined) return jittered;
  if (opts.retryAfterIsLowerBound !== true) {
    // Historical behaviour, still the default for every caller that has not opted in.
    return Math.min(retryAfter, opts.maxDelayMs);
  }
  // A provider that names a wait is stating when it will serve again; sending earlier is a
  // request we already know will be refused, and refusing it twice is the retry storm the
  // header exists to prevent. The local maximum bounds our OWN exponential backoff and has no
  // business shortening someone else's instruction, so the instruction is returned in full.
  // Whether the request can afford to wait that long is the caller's deadline decision --
  // fetchWithTransientRetry ends with the upstream answer rather than retrying early.
  return Math.max(retryAfter, jittered);
}

export function cancelResponseBodyBestEffort(res: Response): void {
  try {
    const cancellation = res.body?.cancel();
    if (cancellation) void cancellation.catch(() => {});
  } catch {
    // Cancellation is cleanup only; retries must not wait for or fail because of it.
  }
}

export async function fetchWithAttemptDeadline(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  preferIdentityEncoding = false,
  executor: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  const attemptTimeout = clearableDeadline(timeoutMs, abortSignal);
  const headers = new Headers(init.headers);
  if (preferIdentityEncoding && !headers.has("accept-encoding")) {
    headers.set("accept-encoding", "identity");
  }
  try {
    return await executor(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: attemptTimeout.signal,
    });
  } finally {
    // Only the header timer is cleared. The composed signal still contains the parent, so a
    // caller abort after headers continue to cancel consumption of the returned response body.
    attemptTimeout.clear();
  }
}

export interface ResetRetryOptions {
  /**
   * Opt in only when repeating this operation cannot duplicate upstream effects.
   * This permits reset retries, not extra sends: attempts and onSendsConsumed still
   * bound and count every physical send. A string body is not replay-safety proof.
   */
  replaySafe?: boolean;
  abortSignal?: AbortSignal;
  /** Short host/path label for the retry warn log (no secrets/query strings). */
  label?: string;
  /** Total upstream sends allowed, including the first one. Not a per-layer retry count. */
  attempts?: number;
  /**
   * Reports how many upstream sends this call actually consumed, so a caller that spans
   * several legs of one request (initial send, then a 429/account-recovery refetch) can
   * keep them on ONE budget instead of handing each leg a fresh one.
   *
   * It lives on the RESET options, not on the transient ones, because every leg that falls
   * back to reset-only retry -- the non-policy adapter initial send, and every
   * `rebuildAndRefetch` recovery kind whose provider has no transient policy -- was not merely
   * uncounted but UNCOUNTABLE: the callback existed on a type those call sites never reach.
   */
  onSendsConsumed?: (sends: number) => void;
}

export interface TransientRetryOptions extends ResetRetryOptions {
  /** Test seam: per-attempt slow budget override (defaults to TRANSIENT_RETRY_SLOW_ATTEMPT_MS). */
  slowAttemptMs?: number;
  /**
   * How long this caller can wait on an honoured `Retry-After`, defaulting to
   * {@link RETRY_AFTER_CEILING_MS}. It is a deadline, never a clamp: an instruction inside it
   * is slept in full, and an instruction past it ends the call with the upstream answer and
   * its `Retry-After` intact rather than sending early at a provider that already said it
   * would refuse. A caller with a shorter budget than a minute says so and is not parked past
   * it; a caller that can genuinely wait longer says so and is not cut short.
   */
  retryAfterCeilingMs?: number;
}

export type UpstreamSendRecovery = "connection-reset" | "transient-5xx";
type ReplayableFetch = (recovery?: UpstreamSendRecovery) => Promise<Response>;

/**
 * Rejection thrown by the upstream retry helpers when the terminal attempt
 * rejects after earlier attempts already produced credential-visible evidence:
 * transient 5xx responses, or a connection reset after the request was read.
 *
 * That evidence proves the host and credential path were reached, so the
 * failure must stay account-attributed even though the terminal promise looks
 * like a transport rejection (issue #914 review: mixed 5xx/reset -> rejection
 * must not be downgraded to the account-neutral pre-connection class). The
 * original rejection is preserved as `cause` so its code and message stay
 * inspectable. Extracted from PR #966 (Yuxin-Qiao) with attribution.
 */
export class UpstreamRetryEvidenceError extends Error {
  constructor(
    public readonly transientStatuses: readonly number[],
    cause: unknown,
    /** True when a connection-reset retry already reached the origin. */
    public readonly resetSeen = false,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const kinds: string[] = [];
    if (transientStatuses.length > 0) kinds.push("transient 5xx response(s)");
    if (resetSeen) kinds.push("a credential-visible connection reset");
    super(
      kinds.length > 0
        ? `upstream fetch failed after ${kinds.join(" and ")}: ${detail}`
        : `upstream fetch failed: ${detail}`,
      { cause },
    );
    this.name = "UpstreamRetryEvidenceError";
  }
}

/**
 * Opt out of Bun's keep-alive pool after a connection-reset retry.
 *
 * Prefer the Bun fetch extension `keepalive: false` (transport-level) over
 * relying on the hop-by-hop `Connection: close` header alone — Bun has ignored
 * that header in past releases (oven-sh/bun#20492), so a header-only retry can
 * still reuse the same half-closed pooled socket. Still set Connection: close
 * as a belt-and-suspenders signal for intermediaries that honor it.
 */
export function applyUpstreamRecoveryInit<T extends RequestInit>(
  init: T,
  recovery?: UpstreamSendRecovery,
): T & { headers: Headers } {
  const headers = new Headers(init.headers);
  if (recovery !== "connection-reset") {
    return { ...init, headers };
  }
  headers.set("connection", "close");
  return { ...init, headers, keepalive: false };
}

/**
 * Run `doFetch` within one send budget. Connection-reset-shaped rejections are
 * terminal by default; only an explicitly replay-safe operation receives reset retries
 * with jittered backoff. HTTP responses retain the caller's existing retry policy.
 */
export async function fetchWithResetRetry(
  doFetch: ReplayableFetch,
  opts: ResetRetryOptions = {},
  firstRecovery?: UpstreamSendRecovery,
): Promise<Response> {
  const attempts = normalizeSendAttempts(opts.attempts, RESET_RETRY_MAX_ATTEMPTS);
  // Zero is zero. The old Math.max(1, ...) floor meant an exhausted budget still bought one
  // more send on every recovery leg, which is most of what made a bounded per-layer retry
  // compose into an unbounded per-request count.
  if (attempts === 0) throw new SendBudgetExhaustedError(opts.label);
  let lastError: unknown;
  let sawReset = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.abortSignal?.aborted) throw abortError(opts.abortSignal);
    // Reported before the await, one physical send at a time: a send that rejects has still
    // been made, and this helper leaves through four exits (return, reset give-up, non-reset
    // rethrow, abort), so a per-send report is the only shape that is correct on all of them.
    opts.onSendsConsumed?.(1);
    try {
      return await doFetch(attempt === 0 ? firstRecovery : "connection-reset");
    } catch (err) {
      if (opts.abortSignal?.aborted) throw err;
      if (!isConnectionResetError(err)) {
        // A reset that already reached the origin is credential-visible
        // evidence: keep it attached so the terminal rejection cannot be
        // downgraded to the pre-connection neutral class (#914 review).
        if (sawReset) throw new UpstreamRetryEvidenceError([], err, true);
        throw err;
      }
      if (opts.replaySafe !== true) {
        // Return evidence instead of throwing a generic transport error: outer catches
        // otherwise turn it into a replayable 502 and a combo/account recovery resends it.
        // The WeakSet protects in-process recovery; the code survives JSON re-wrapping.
        // Never expose the raw exception, which can contain credentials or request data.
        const response = new Response(JSON.stringify({ error: {
          type: "upstream_error",
          code: UPSTREAM_RESET_REPLAY_REFUSED_CODE,
          message: "The upstream connection closed before a response was received. The request may already have been processed; automatic replay was stopped.",
        } }), { status: REPLAY_REFUSED_STATUS, headers: { "content-type": "application/json" } });
        markResponseNonReplayable(response);
        markReplayRefusalResponse(response);
        return response;
      }
      if (attempt === attempts - 1) throw err;
      sawReset = true;
      lastError = err;
      console.warn(
        `[upstream-retry] connection reset${opts.label ? ` (${opts.label})` : ""} — retrying (${attempt + 2}/${attempts})`,
      );
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: RESET_RETRY_BASE_DELAY_MS,
        maxDelayMs: RESET_RETRY_MAX_DELAY_MS,
      }), opts.abortSignal);
    }
  }
  throw lastError ?? new Error("upstream fetch failed");
}

/**
 * fetchWithResetRetry plus the caller-selected transient-5xx policy, PRE-STREAM only.
 * A received HTTP error follows that policy; an ambiguous reset's non-replayable
 * verdict always stops it. The failed attempt's body is cancelled before the
 * retry; every returned response (ok, non-transient, aborted, slow, exhausted) keeps
 * its body intact. Honors Retry-After via retryBackoffDelayMs.
 *
 * A failed attempt slower than the slow budget is returned as-is (slow-502 shape);
 * `opts.attempts` is ONE total-send budget covering this layer and the inner reset layer
 * together, so it bounds the real number of upstream requests rather than multiplying.
 */
export async function fetchWithTransientRetry(
  doFetch: ReplayableFetch,
  opts: TransientRetryOptions = {},
): Promise<Response> {
  const budget = normalizeSendAttempts(opts.attempts, TRANSIENT_RETRY_MAX_ATTEMPTS);
  const slowAttemptMs = opts.slowAttemptMs ?? TRANSIENT_RETRY_SLOW_ATTEMPT_MS;
  const transientStatuses: number[] = [];
  // `attempts` is ONE total-send budget shared with the inner reset layer, not a per-layer
  // count. Forwarding it into every `fetchWithResetRetry` made the two multiply: with
  // `attempts: 3` the outer loop ran 3 transient rounds and each round independently retried
  // 3 connection resets, so a single call could emit 9 upstream sends — and 10 could emit 100.
  // That was harmless only because no caller passed `attempts`; the provider-level
  // `transientRetryOn5xx` policy is the first one that does, and multiplying load against an
  // already-failing provider is worse than not retrying at all.
  let sent = 0;
  const countedFetch: ReplayableFetch = (recovery) => {
    // Incremented BEFORE the await so a rejected send still consumes budget; counting only
    // successes would let a reset storm loop without bound.
    sent += 1;
    return doFetch(recovery);
  };
  // No floor. A spent budget hands the inner helper 0, which refuses rather than buying one
  // more send -- the loop condition alone was never enough, because every later recovery leg
  // called this helper again and the floor funded each of them.
  const remaining = () => Math.max(0, budget - sent);
  // The inner reset layer now has its own `onSendsConsumed`, and these are the same physical
  // sends `countedFetch` already counts. Forwarding the reporter down the `remaining()` path
  // would report each of them twice, which is how a four-send cap becomes a two-send cap. One
  // send is counted once, by the outermost layer that owns the budget.
  const innerResetOptions = (): ResetRetryOptions => ({
    ...opts,
    attempts: remaining(),
    onSendsConsumed: undefined,
  });
  // Reported in `finally` rather than at each exit: this function returns from five places
  // and throws from one, and a caller sharing the budget across request legs must be told the
  // real count on every one of them.
  try {
  if (budget === 0) throw new SendBudgetExhaustedError(opts.label);
  let attemptStart = Date.now();
  let res = await fetchWithResetRetry(countedFetch, innerResetOptions());
  for (let attempt = 0; sent < budget; attempt++) {
    // A non-replayable gateway status was settled after the request body had already left
    // for the origin; retrying it here is the automatic resend the marker exists to forbid.
    if (res.ok || !isTransientUpstreamStatus(res.status) || isNonReplayableResponse(res)) return res;
    // Checked before cancelResponseBodyBestEffort so an already-aborted caller never receives
    // a response whose body we just cancelled.
    if (opts.abortSignal?.aborted) return res;
    if (Date.now() - attemptStart > slowAttemptMs) return res;
    const instructedDelay = retryAfterDelayMs(res.headers);
    // The deadline is the CALLER'S, not this module's default. Reading the constant directly
    // broke it in both directions: a caller with a 30s budget slept the full 45s an upstream
    // asked for, and a caller that could genuinely wait 120s was handed the error back for a
    // 90s instruction it was willing to honour.
    const waitDeadlineMs = opts.retryAfterCeilingMs ?? RETRY_AFTER_CEILING_MS;
    if (instructedDelay !== undefined && instructedDelay > waitDeadlineMs) {
      // Honouring the stated wait would park this request past the deadline it can commit
      // to, and sleeping only up to the deadline is a send the provider already said it will
      // refuse. End here instead: the caller receives the upstream answer with its
      // Retry-After intact and applies its own policy, exactly as on the direct path.
      return res;
    }
    console.warn(
      `[upstream-retry] transient ${res.status}${opts.label ? ` (${opts.label})` : ""} — retrying (${sent + 1}/${budget})`,
    );
    const delay = retryBackoffDelayMs(attempt, {
      baseDelayMs: TRANSIENT_RETRY_BASE_DELAY_MS,
      maxDelayMs: TRANSIENT_RETRY_MAX_DELAY_MS,
      headers: res.headers,
      retryAfterIsLowerBound: true,
    });
    cancelResponseBodyBestEffort(res);
    // Throws on abort (see sleepWithAbort): the rejection propagates, and the body we just
    // cancelled belonged to a response we were discarding anyway.
    await sleepWithAbort(delay, opts.abortSignal);
    attemptStart = Date.now();
    transientStatuses.push(res.status);
    try {
      res = await fetchWithResetRetry(countedFetch, innerResetOptions(), "transient-5xx");
    } catch (err) {
      // Keep the prior 5xx evidence attached: the origin already responded, so
      // this rejection is not pre-connection and must not classify as neutral.
      // A budget refusal is not upstream evidence of anything and must stay recognisable.
      if (err instanceof SendBudgetExhaustedError) throw err;
      throw new UpstreamRetryEvidenceError(transientStatuses, err);
    }
  }
  // Budget exhausted: the last response is returned with its body intact.
  return res;
  } finally {
    opts.onSendsConsumed?.(sent);
  }
}

export type ProtocolSafeRefetch = (
  recovery?: UpstreamSendRecovery,
  signal?: AbortSignal,
) => Promise<Response>;

export interface ProtocolSafeRefetchOptions extends ResetRetryOptions {
  /** The replacement must match the response contract already selected for the client. */
  acceptResponse?: (response: Response) => boolean;
}

/**
 * Attempt one caller-authorized replacement after protocol inspection proved that no output
 * event was observed. The caller owns that proof and the physical-send budget.
 */
export async function refetchAfterProtocolSafeReset(
  doFetch: ProtocolSafeRefetch,
  err: unknown,
  opts: ProtocolSafeRefetchOptions = {},
): Promise<Response | null> {
  if (!isConnectionResetError(err) || opts.abortSignal?.aborted || opts.attempts === 0) return null;
  const label = opts.label
    ? " (" + redactSecretString(opts.label).replace(/[\r\n\u0000-\u001f\u007f]/g, "").slice(0, 128) + ")"
    : "";
  let replacement: Response;
  try {
    replacement = await doFetch("connection-reset", opts.abortSignal);
  } catch {
    console.warn("[upstream-retry] protocol-safe refetch failed" + label + "; preserving original stream error");
    return null;
  }
  const body = replacement.body;
  let accepted = !opts.abortSignal?.aborted && replacement.ok && body !== null
    && !replacement.bodyUsed && !body.locked && !isNonReplayableResponse(replacement);
  try { if (accepted && opts.acceptResponse) accepted = opts.acceptResponse(replacement); }
  catch { accepted = false; }
  if (!accepted || opts.abortSignal?.aborted || body?.locked) {
    try { void body?.cancel().catch(() => {}); } catch { /* already locked or closed */ }
    console.warn("[upstream-retry] protocol-safe refetch rejected" + label + "; preserving original stream error");
    return null;
  }
  console.warn("[upstream-retry] pre-output Responses reset" + label + "; using one replacement stream");
  return replacement;
}
