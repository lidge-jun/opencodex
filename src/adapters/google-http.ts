import type { AdapterFetchContext, AdapterRequest } from "./base";
import { isQuotaExhaustedBody, retryableGoogleStatus, safeGoogleHttpErrorMessage } from "./google-errors";

const GOOGLE_RETRY_ATTEMPTS = 3;
const GOOGLE_RETRY_BASE_MS = 250;
const GOOGLE_RETRY_MAX_MS = 2_000;

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function retryDelayMs(attempt: number, headers?: Headers): number {
  const retryAfter = headers ? retryAfterMs(headers) : undefined;
  if (retryAfter !== undefined) return Math.min(retryAfter, GOOGLE_RETRY_MAX_MS);
  const exp = Math.min(GOOGLE_RETRY_BASE_MS * (2 ** attempt), GOOGLE_RETRY_MAX_MS);
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function signalWithAttemptTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function normalizeFinalGoogleError(label: string, res: Response): Promise<Response> {
  if (res.ok) return res;
  const payloadText = await res.clone().text().catch(() => "");
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(safeGoogleHttpErrorMessage(label, res.status, payloadText), {
    status: res.status, statusText: res.statusText, headers,
  });
}

/**
 * Fetch a Google-family upstream (Vertex / Antigravity) with Kiro-style hardening: per-attempt
 * timeout (`AbortSignal.any([parent, timeout])`), bounded retry on transient status / network
 * errors, `Retry-After` honoring, jittered exponential backoff, and a classified + redacted final
 * error body. `label` is the provider-facing prefix used in error messages.
 */
export async function fetchGoogleWithRetry(label: string, request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? 100_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < GOOGLE_RETRY_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      const res = await fetch(request.url, {
        method: request.method, headers: request.headers, body: request.body,
        signal: signalWithAttemptTimeout(ctx.abortSignal, timeoutMs),
      });
      if (!retryableGoogleStatus(res.status) || attempt === GOOGLE_RETRY_ATTEMPTS - 1) {
        return normalizeFinalGoogleError(label, res);
      }
      // A 429 may be a transient rate limit (retry) or hard quota exhaustion (do NOT retry —
      // it won't recover for hours and burns retries). Peek the body to tell them apart.
      if (res.status === 429) {
        const peek = await res.clone().text().catch(() => "");
        if (isQuotaExhaustedBody(peek)) {
          const headers = new Headers(res.headers);
          headers.delete("content-encoding");
          headers.delete("content-length");
          return new Response(safeGoogleHttpErrorMessage(label, res.status, peek), {
            status: res.status, statusText: res.statusText, headers,
          });
        }
      }
      await res.body?.cancel().catch(() => {});
      await sleepWithAbort(retryDelayMs(attempt, res.headers), ctx.abortSignal);
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      lastError = err;
      if (attempt === GOOGLE_RETRY_ATTEMPTS - 1) throw err;
      await sleepWithAbort(retryDelayMs(attempt), ctx.abortSignal);
    }
  }
  throw lastError ?? new Error(`${label} fetch failed`);
}

/** Vertex AI retry wrapper. */
export function fetchVertexWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  return fetchGoogleWithRetry("Vertex AI", request, ctx);
}

/** Antigravity (Cloud Code Assist) retry wrapper. */
export function fetchAntigravityWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  return fetchGoogleWithRetry("Antigravity", request, ctx);
}
