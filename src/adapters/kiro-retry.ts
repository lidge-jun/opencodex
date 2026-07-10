import type { AdapterFetchContext, AdapterRequest } from "./base";
import { safeKiroHttpErrorMessage } from "./kiro-errors";
import { clearableDeadline } from "../lib/abort";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { abortError, isConnectionResetError, sleepWithAbort } from "../lib/upstream-retry";

const KIRO_RETRY_ATTEMPTS = 3;
const KIRO_RETRY_BASE_MS = 250;
const KIRO_RETRY_MAX_MS = 2_000;

function retryableKiroStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

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
  if (retryAfter !== undefined) return Math.min(retryAfter, KIRO_RETRY_MAX_MS);
  const exp = Math.min(KIRO_RETRY_BASE_MS * (2 ** attempt), KIRO_RETRY_MAX_MS);
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

function retryableKiroFetchError(err: unknown): boolean {
  return isConnectionResetError(err) || (err instanceof Error && err.name === "TimeoutError");
}

async function normalizeFinalKiroHttpError(res: Response, signal?: AbortSignal): Promise<Response> {
  if (res.ok) return res;
  let payloadText = "";
  try {
    const body = await readBoundedResponseBody(res, { signal });
    if (body.displaySafe) payloadText = body.text;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(safeKiroHttpErrorMessage(res.status, res.headers, payloadText), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export async function fetchKiroWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < KIRO_RETRY_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      const attemptTimeout = clearableDeadline(timeoutMs, ctx.abortSignal);
      let res: Response;
      try {
        res = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: attemptTimeout.signal,
        });
      } finally {
        attemptTimeout.clear();
      }
      if (!retryableKiroStatus(res.status) || attempt === KIRO_RETRY_ATTEMPTS - 1) {
        return ctx.returnRawErrors ? res : normalizeFinalKiroHttpError(res, ctx.abortSignal);
      }
      cancelResponseBodyBestEffort(res);
      await sleepWithAbort(retryDelayMs(attempt, res.headers), ctx.abortSignal);
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      if (!retryableKiroFetchError(err) || attempt === KIRO_RETRY_ATTEMPTS - 1) throw err;
      lastError = err;
      await sleepWithAbort(retryDelayMs(attempt), ctx.abortSignal);
    }
  }
  throw lastError ?? new Error("Kiro fetch failed");
}
