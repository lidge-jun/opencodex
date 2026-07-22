import type { AdapterFetchContext, AdapterRequest } from "./base";
import { safeKiroHttpErrorMessage } from "./kiro-errors";
import { normalizeUpstreamHttpErrorResponse } from "./upstream-http-error";
import { readBoundedResponseBody } from "../lib/bounded-body";
import {
  abortError,
  cancelResponseBodyBestEffort,
  fetchWithAttemptDeadline,
  isConnectionResetError,
  retryBackoffDelayMs,
  sleepWithAbort,
} from "../lib/upstream-retry";

const RESET_ATTEMPTS = 3;
const RESET_RETRY_BASE_MS = 150;
const RESET_RETRY_MAX_MS = 1_000;
const CANONICAL_RUNTIME_HOST = /^runtime\.([a-z]{2}(?:-[a-z]+)+-\d)\.kiro\.dev$/i;
const ENDPOINT_ERROR_MARKERS = [
  "unknownoperation",
  "unknown operation",
  "invalidsignature",
  "invalid signature",
  "endpoint not found",
  "unsupported endpoint",
];
const CONNECT_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);

function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return chain;
}

function endpointConnectFailure(error: unknown): boolean {
  return errorChain(error).some(item => {
    if (item.name === "AbortError" || item.name === "TimeoutError") return false;
    const code = (item as Error & { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return true;
    const message = item.message.toLowerCase();
    return message.includes("dns")
      || message.includes("name resolution")
      || message.includes("failed to lookup address")
      || message.includes("connection refused")
      || message.includes("failed to connect")
      || message.includes("connect error");
  });
}

function legacyUrl(requestUrl: string): string | undefined {
  let url: URL;
  try { url = new URL(requestUrl); } catch { return undefined; }
  const match = CANONICAL_RUNTIME_HOST.exec(url.hostname);
  if (!match || url.pathname !== "/" || url.search || url.hash) return undefined;
  url.hostname = `q.${match[1]}.amazonaws.com`;
  return url.toString();
}

async function fetchWithResetRecovery(
  request: AdapterRequest,
  url: string,
  ctx: AdapterFetchContext,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RESET_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      const headers = new Headers(request.headers);
      const recovered = attempt > 0;
      if (recovered) headers.set("connection", "close");
      return await fetchWithAttemptDeadline(url, {
        method: request.method,
        headers,
        body: request.body,
        ...(recovered ? { keepalive: false } : {}),
      }, timeoutMs, ctx.abortSignal, ctx.stream);
    } catch (error) {
      if (ctx.abortSignal?.aborted || !isConnectionResetError(error) || attempt === RESET_ATTEMPTS - 1) throw error;
      lastError = error;
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: RESET_RETRY_BASE_MS,
        maxDelayMs: RESET_RETRY_MAX_MS,
      }), ctx.abortSignal);
    }
  }
  throw lastError ?? new Error("Kiro fetch failed");
}

async function inspectEndpointHttpFailure(
  response: Response,
  signal?: AbortSignal,
): Promise<{ response: Response; fallback: boolean }> {
  if (response.status === 404 || response.status === 405) return { response, fallback: true };
  if (response.status !== 400 && response.status !== 403) return { response, fallback: false };

  const body = await readBoundedResponseBody(response, { signal });
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const rebuilt = new Response(body.displaySafe ? body.text : "", {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const text = body.displaySafe ? body.text.toLowerCase() : "";
  return { response: rebuilt, fallback: ENDPOINT_ERROR_MARKERS.some(marker => text.includes(marker)) };
}

async function normalizeFinalKiroHttpError(res: Response, signal?: AbortSignal): Promise<Response> {
  return normalizeUpstreamHttpErrorResponse(res, {
    signal,
    formatMessage: payloadText => safeKiroHttpErrorMessage(res.status, res.headers, payloadText),
  });
}

/**
 * Kiro owns only replay-safe pre-header reset recovery and one canonical-to-legacy endpoint fallback.
 * Client-level retry policy owns throttling, timeouts, and ordinary service failures.
 */
export async function fetchKiroWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  const legacy = legacyUrl(request.url);
  let response: Response;
  try {
    response = await fetchWithResetRecovery(request, request.url, ctx, timeoutMs);
  } catch (error) {
    if (!legacy || !endpointConnectFailure(error)) throw error;
    response = await fetchWithResetRecovery(request, legacy, ctx, timeoutMs);
    return ctx.returnRawErrors ? response : normalizeFinalKiroHttpError(response, ctx.abortSignal);
  }

  if (legacy && !response.ok) {
    const inspected = await inspectEndpointHttpFailure(response, ctx.abortSignal);
    response = inspected.response;
    if (inspected.fallback) {
      cancelResponseBodyBestEffort(response);
      response = await fetchWithResetRecovery(request, legacy, ctx, timeoutMs);
    }
  }
  return ctx.returnRawErrors ? response : normalizeFinalKiroHttpError(response, ctx.abortSignal);
}
