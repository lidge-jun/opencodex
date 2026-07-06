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

// 1 initial + 2 retries: the pool may hold more than one stale socket.
const RESET_RETRY_MAX_ATTEMPTS = 3;
const RESET_RETRY_BASE_DELAY_MS = 150;
const RESET_RETRY_MAX_DELAY_MS = 1_000;

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

function retryDelayMs(attempt: number): number {
  const exp = Math.min(RESET_RETRY_BASE_DELAY_MS * (2 ** attempt), RESET_RETRY_MAX_DELAY_MS);
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
}

export interface ResetRetryOptions {
  abortSignal?: AbortSignal;
  /** Short host/path label for the retry warn log (no secrets/query strings). */
  label?: string;
  attempts?: number;
}

/**
 * Run `doFetch`, retrying only connection-reset-shaped rejections (see
 * isConnectionResetError) with jittered backoff. The caller's thunk must be replay-safe
 * (string body); every retry is logged so persistent resets stay visible.
 */
export async function fetchWithResetRetry(
  doFetch: () => Promise<Response>,
  opts: ResetRetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? RESET_RETRY_MAX_ATTEMPTS);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.abortSignal?.aborted) throw abortError(opts.abortSignal);
    try {
      return await doFetch();
    } catch (err) {
      if (opts.abortSignal?.aborted || !isConnectionResetError(err) || attempt === attempts - 1) throw err;
      lastError = err;
      console.warn(
        `[upstream-retry] connection reset${opts.label ? ` (${opts.label})` : ""} — retrying (${attempt + 2}/${attempts})`,
      );
      await sleepWithAbort(retryDelayMs(attempt), opts.abortSignal);
    }
  }
  throw lastError ?? new Error("upstream fetch failed");
}
