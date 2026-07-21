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
): Promise<Response> {
  const attemptTimeout = clearableDeadline(timeoutMs, abortSignal);
  const headers = new Headers(init.headers);
  if (preferIdentityEncoding && !headers.has("accept-encoding")) {
    headers.set("accept-encoding", "identity");
  }
  try {
    return await fetch(url, {
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
  attempts?: number;
}

export interface TransientRetryOptions extends ResetRetryOptions {
  /** Test seam: per-attempt slow budget override (defaults to TRANSIENT_RETRY_SLOW_ATTEMPT_MS). */
  slowAttemptMs?: number;
}

export type UpstreamSendRecovery = "connection-reset" | "transient-5xx";
type ReplayableFetch = (recovery?: UpstreamSendRecovery) => Promise<Response>;

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
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.abortSignal?.aborted) throw abortError(opts.abortSignal);
    try {
      return await doFetch(attempt === 0 ? firstRecovery : "connection-reset");
    } catch (err) {
      if (opts.abortSignal?.aborted || !isConnectionResetError(err) || attempt === attempts - 1) throw err;
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
 * note `opts.attempts` is shared with the inner reset layer (no caller passes it today).
 */
export async function fetchWithTransientRetry(
  doFetch: ReplayableFetch,
  opts: TransientRetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? TRANSIENT_RETRY_MAX_ATTEMPTS);
  const slowAttemptMs = opts.slowAttemptMs ?? TRANSIENT_RETRY_SLOW_ATTEMPT_MS;
  let attemptStart = Date.now();
  let res = await fetchWithResetRetry(doFetch, opts);
  for (let attempt = 0; attempt < attempts - 1; attempt++) {
    if (res.ok || !isTransientUpstreamStatus(res.status)) return res;
    if (opts.abortSignal?.aborted) return res;
    if (Date.now() - attemptStart > slowAttemptMs) return res;
    console.warn(
      `[upstream-retry] transient ${res.status}${opts.label ? ` (${opts.label})` : ""} — retrying (${attempt + 2}/${attempts})`,
    );
    const delay = retryBackoffDelayMs(attempt, {
      baseDelayMs: TRANSIENT_RETRY_BASE_DELAY_MS,
      maxDelayMs: TRANSIENT_RETRY_MAX_DELAY_MS,
      headers: res.headers,
    });
    cancelResponseBodyBestEffort(res);
    await sleepWithAbort(delay, opts.abortSignal);
    attemptStart = Date.now();
    res = await fetchWithResetRetry(doFetch, opts, "transient-5xx");
  }
  return res;
}
