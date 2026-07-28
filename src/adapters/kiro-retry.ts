import type { AdapterFetchContext, AdapterRequest } from "./base";
import { classifyKiroHttpError, safeKiroHttpErrorMessage } from "./kiro-errors";
import { normalizeUpstreamHttpErrorResponse } from "./upstream-http-error";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { resolveClientRetryAfter } from "../lib/retry-after";
import { parseRetryAfterMs } from "../combos";
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
const THROTTLE_ATTEMPTS = 3;
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

interface KiroThrottleProbe {
  token: symbol;
  promise: Promise<void>;
  release: () => void;
}

let kiroThrottleCooldownUntil = 0;
let kiroThrottleProbe: KiroThrottleProbe | undefined;

function newKiroThrottleProbe(): KiroThrottleProbe {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  const probe = { token: Symbol("kiro-throttle-probe"), promise, release };
  kiroThrottleProbe = probe;
  return probe;
}

function releaseKiroThrottleProbe(token: symbol | undefined): void {
  if (!token || kiroThrottleProbe?.token !== token) return;
  const probe = kiroThrottleProbe;
  kiroThrottleProbe = undefined;
  probe.release();
}

async function waitWithAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForKiroCooldown(signal?: AbortSignal): Promise<void> {
  // Re-check after every sleep because another throttled request can extend the shared deadline.
  while (true) {
    const remaining = kiroThrottleCooldownUntil - Date.now();
    if (remaining <= 0) return;
    await sleepWithAbort(remaining, signal);
  }
}

async function enterKiroThrottleGate(signal?: AbortSignal): Promise<symbol | undefined> {
  while (true) {
    const active = kiroThrottleProbe;
    if (active) {
      await waitWithAbort(active.promise, signal);
      continue;
    }
    if (kiroThrottleCooldownUntil <= Date.now()) return undefined;
    const owned = newKiroThrottleProbe();
    try {
      await waitForKiroCooldown(signal);
      return owned.token;
    } catch (error) {
      releaseKiroThrottleProbe(owned.token);
      throw error;
    }
  }
}

function claimKiroThrottleProbe(
  delayMs: number,
  currentToken?: symbol,
): { token?: symbol; wait?: Promise<void> } {
  kiroThrottleCooldownUntil = Math.max(kiroThrottleCooldownUntil, Date.now() + Math.max(0, delayMs));
  if (currentToken && kiroThrottleProbe?.token === currentToken) return { token: currentToken };
  if (!kiroThrottleProbe) return { token: newKiroThrottleProbe().token };
  return { wait: kiroThrottleProbe.promise };
}

/** Stream-level throttles arrive after HTTP 200, so record their cooldown for the next client retry. */
export function noteKiroTransientThrottle(delayMs = 2_000): void {
  kiroThrottleCooldownUntil = Math.max(kiroThrottleCooldownUntil, Date.now() + Math.max(0, delayMs));
}

export function resetKiroThrottleStateForTests(): void {
  const active = kiroThrottleProbe;
  kiroThrottleProbe = undefined;
  kiroThrottleCooldownUntil = 0;
  active?.release();
}

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

async function inspectKiroThrottle(
  response: Response,
  signal?: AbortSignal,
): Promise<{ response: Response; transient: boolean; delayMs: number } | undefined> {
  if (response.status !== 429) return undefined;
  const body = await readBoundedResponseBody(response, { signal });
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const payloadText = body.displaySafe ? body.text : "";
  const rebuilt = new Response(payloadText, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const failure = classifyKiroHttpError(response.status, headers, payloadText);
  const retryAfter = resolveClientRetryAfter({
    status: response.status,
    message: failure.message,
    upstreamRetryAfter: headers.get("retry-after"),
  });
  const delayMs = retryAfter === "0" ? 0 : parseRetryAfterMs(retryAfter) ?? 2_000;
  return {
    response: rebuilt,
    transient: failure.retryable && failure.code === "rate_limit_exceeded",
    delayMs,
  };
}

async function fetchKiroAttempt(
  request: AdapterRequest,
  ctx: AdapterFetchContext,
  timeoutMs: number,
): Promise<Response> {
  const legacy = legacyUrl(request.url);
  let response: Response;
  try {
    response = await fetchWithResetRecovery(request, request.url, ctx, timeoutMs);
  } catch (error) {
    if (!legacy || !endpointConnectFailure(error)) throw error;
    return fetchWithResetRecovery(request, legacy, ctx, timeoutMs);
  }

  if (legacy && !response.ok) {
    const inspected = await inspectEndpointHttpFailure(response, ctx.abortSignal);
    response = inspected.response;
    if (inspected.fallback) {
      cancelResponseBodyBestEffort(response);
      response = await fetchWithResetRecovery(request, legacy, ctx, timeoutMs);
    }
  }
  return response;
}

/**
 * Kiro owns replay-safe reset recovery, one endpoint fallback, and bounded process-wide transient
 * throttle recovery. The shared probe starts only after a 429, so healthy parallel traffic remains
 * parallel while a throttled account cannot burn every caller's independent retry budget (#532).
 */
export async function fetchKiroWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  let probeToken: symbol | undefined;
  try {
    for (let attempt = 0; attempt < THROTTLE_ATTEMPTS; attempt++) {
      if (!probeToken) probeToken = await enterKiroThrottleGate(ctx.abortSignal);
      else await waitForKiroCooldown(ctx.abortSignal);

      const response = await fetchKiroAttempt(request, ctx, timeoutMs);
      const throttle = await inspectKiroThrottle(response, ctx.abortSignal);
      if (!throttle || !throttle.transient) {
        releaseKiroThrottleProbe(probeToken);
        const finalResponse = throttle?.response ?? response;
        return ctx.returnRawErrors
          ? finalResponse
          : normalizeFinalKiroHttpError(finalResponse, ctx.abortSignal);
      }

      const claim = claimKiroThrottleProbe(throttle.delayMs, probeToken);
      if (!claim.token) {
        cancelResponseBodyBestEffort(throttle.response);
        await waitWithAbort(claim.wait!, ctx.abortSignal);
        probeToken = undefined;
        continue;
      }
      probeToken = claim.token;
      if (attempt === THROTTLE_ATTEMPTS - 1) {
        releaseKiroThrottleProbe(probeToken);
        return ctx.returnRawErrors
          ? throttle.response
          : normalizeFinalKiroHttpError(throttle.response, ctx.abortSignal);
      }
      cancelResponseBodyBestEffort(throttle.response);
    }
    throw new Error("Kiro throttle retry loop exhausted without a response");
  } catch (error) {
    releaseKiroThrottleProbe(probeToken);
    throw error;
  }
}
