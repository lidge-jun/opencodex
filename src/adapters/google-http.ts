import type { AdapterFetchContext, AdapterRequest } from "./base";
import { isQuotaExhaustedBody, retryableGoogleStatus, safeGoogleHttpErrorMessage } from "./google-errors";
import { clearableDeadline } from "../lib/abort";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { abortError, sleepWithAbort } from "../lib/upstream-retry";

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

function cancelResponseBodyBestEffort(res: Response): void {
  try {
    const cancellation = res.body?.cancel();
    if (cancellation) void cancellation.catch(() => {});
  } catch {
    // Cancellation is cleanup only; retries must not wait for or fail because of it.
  }
}

async function boundedBodyText(res: Response, signal?: AbortSignal): Promise<string> {
  try {
    const body = await readBoundedResponseBody(res, { signal });
    return body.displaySafe ? body.text : "";
  } catch (error) {
    if (signal?.aborted) throw error;
    return "";
  }
}

async function normalizeFinalGoogleError(label: string, res: Response, signal?: AbortSignal): Promise<Response> {
  if (res.ok) return res;
  const payloadText = await boundedBodyText(res, signal);
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
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < GOOGLE_RETRY_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      const attemptTimeout = clearableDeadline(timeoutMs, ctx.abortSignal);
      let res: Response;
      try {
        res = await fetch(request.url, {
          method: request.method, headers: request.headers, body: request.body,
          signal: attemptTimeout.signal,
        });
      } finally {
        // Only the header timer is cleared. The composed signal still contains the parent, so a
        // caller abort after headers continue to cancel consumption of the returned response body.
        attemptTimeout.clear();
      }
      if (!retryableGoogleStatus(res.status) || attempt === GOOGLE_RETRY_ATTEMPTS - 1) {
        return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, ctx.abortSignal);
      }
      // A 429 may be a transient rate limit (retry) or hard quota exhaustion (do NOT retry —
      // it won't recover for hours and burns retries). Peek the body to tell them apart.
      if (res.status === 429 && !ctx.returnRawErrors) {
        const peek = await boundedBodyText(res, ctx.abortSignal);
        if (isQuotaExhaustedBody(peek)) {
          const headers = new Headers(res.headers);
          headers.delete("content-encoding");
          headers.delete("content-length");
          return new Response(safeGoogleHttpErrorMessage(label, res.status, peek), {
            status: res.status, statusText: res.statusText, headers,
          });
        }
      }
      cancelResponseBodyBestEffort(res);
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
