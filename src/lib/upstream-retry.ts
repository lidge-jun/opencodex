/**
 * Retry guard for upstream fetches that die on stale pooled keep-alive sockets.
 *
 * chatgpt.com (Cloudflare) closes idle keep-alive connections server-side; Bun's fetch pool
 * reuses the half-closed socket and the request write fails with ECONNRESET before any
 * response bytes arrive. Retrying on a fresh connection is safe for our replayable
 * (string-body) upstream requests, because fetch() rejects only before response headers —
 * a caught error here means no response was ever received.
 *
 * Deliberately narrow: timeouts, aborts, ECONNREFUSED/DNS/TLS failures, and HTTP error
 * statuses (returned as Response, never thrown) are NOT retried. Mid-stream SSE resets are
 * out of scope — the response has already resolved by then.
 *
 * MUST stay a leaf module: imports nothing from server.ts or adapters (kiro-retry imports
 * the shared abort helpers from here).
 */
import { clearableDeadline } from "./abort";

// 1 initial + 2 retries: the pool may hold more than one stale socket.
const RESET_RETRY_MAX_ATTEMPTS = 3;
const RESET_RETRY_BASE_DELAY_MS = 150;
const RESET_RETRY_MAX_DELAY_MS = 1_000;

// Transient-5xx status retry layer (pre-stream only; devlog/_plan/260716_claudecode_hardening/010).
const TRANSIENT_RETRY_MAX_ATTEMPTS = 3; // 1 initial + 2 retries
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
}

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
  if (retryAfter !== undefined) return Math.min(retryAfter, opts.maxDelayMs);
  const exp = Math.min(opts.baseDelayMs * (2 ** attempt), opts.maxDelayMs);
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
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
      signal: attemptTimeout.signal,
    });
  } finally {
    // Only the header timer is cleared. The composed signal still contains the parent, so a
    // caller abort after headers continue to cancel consumption of the returned response body.
    attemptTimeout.clear();
  }
}

export interface ResetRetryOptions {
  abortSignal?: AbortSignal;
  /** Short host/path label for the retry warn log (no secrets/query strings). */
  label?: string;
  /** Total upstream sends allowed, including the first one. Not a per-layer retry count. */
  attempts?: number;
}

export interface TransientRetryOptions extends ResetRetryOptions {
  /** Test seam: per-attempt slow budget override (defaults to TRANSIENT_RETRY_SLOW_ATTEMPT_MS). */
  slowAttemptMs?: number;
  /**
   * Reports how many upstream sends this call actually consumed, so a caller that spans
   * several legs of one request (initial send, then a 429/account-recovery refetch) can
   * keep them on ONE budget instead of handing each leg a fresh one.
   */
  onSendsConsumed?: (sends: number) => void;
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
 * Run `doFetch`, retrying only connection-reset-shaped rejections (see
 * isConnectionResetError) with jittered backoff. The caller's thunk must be replay-safe
 * (string body); every retry is logged so persistent resets stay visible.
 */
export async function fetchWithResetRetry(
  doFetch: ReplayableFetch,
  opts: ResetRetryOptions = {},
  firstRecovery?: UpstreamSendRecovery,
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? RESET_RETRY_MAX_ATTEMPTS);
  let lastError: unknown;
  let sawReset = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.abortSignal?.aborted) throw abortError(opts.abortSignal);
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
 * fetchWithResetRetry plus a transient-5xx status retry layer, PRE-STREAM only: a
 * returned Response has by definition not been relayed to the client yet, so replaying
 * the (string-body) request is safe. The failed attempt's body is cancelled before the
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
  const budget = Math.max(1, opts.attempts ?? TRANSIENT_RETRY_MAX_ATTEMPTS);
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
  // Floor of 1 keeps the inner call legal once the budget is spent; the loop condition, not a
  // zero-attempt inner call, is what actually stops the retries.
  const remaining = () => Math.max(1, budget - sent);
  // Reported in `finally` rather than at each exit: this function returns from five places
  // and throws from one, and a caller sharing the budget across request legs must be told the
  // real count on every one of them.
  try {
  let attemptStart = Date.now();
  let res = await fetchWithResetRetry(countedFetch, { ...opts, attempts: remaining() });
  for (let attempt = 0; sent < budget; attempt++) {
    if (res.ok || !isTransientUpstreamStatus(res.status)) return res;
    // Checked before cancelResponseBodyBestEffort so an already-aborted caller never receives
    // a response whose body we just cancelled.
    if (opts.abortSignal?.aborted) return res;
    if (Date.now() - attemptStart > slowAttemptMs) return res;
    console.warn(
      `[upstream-retry] transient ${res.status}${opts.label ? ` (${opts.label})` : ""} — retrying (${sent + 1}/${budget})`,
    );
    const delay = retryBackoffDelayMs(attempt, {
      baseDelayMs: TRANSIENT_RETRY_BASE_DELAY_MS,
      maxDelayMs: TRANSIENT_RETRY_MAX_DELAY_MS,
      headers: res.headers,
    });
    cancelResponseBodyBestEffort(res);
    // Throws on abort (see sleepWithAbort): the rejection propagates, and the body we just
    // cancelled belonged to a response we were discarding anyway.
    await sleepWithAbort(delay, opts.abortSignal);
    attemptStart = Date.now();
    transientStatuses.push(res.status);
    try {
      res = await fetchWithResetRetry(countedFetch, { ...opts, attempts: remaining() }, "transient-5xx");
    } catch (err) {
      // Keep the prior 5xx evidence attached: the origin already responded, so
      // this rejection is not pre-connection and must not classify as neutral.
      throw new UpstreamRetryEvidenceError(transientStatuses, err);
    }
  }
  // Budget exhausted: the last response is returned with its body intact.
  return res;
  } finally {
    opts.onSendsConsumed?.(sent);
  }
}
