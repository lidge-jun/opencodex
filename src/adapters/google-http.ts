import type { AdapterFetchContext, AdapterRequest } from "./base";
import {
  isAntigravityGeoBlockedBody,
  isQuotaExhaustedBody,
  retryableGoogleStatus,
  safeGoogleHttpErrorMessage,
} from "./google-errors";
import { repairGoogleInvalidRequestBody } from "./google-wire-compiler";
import { normalizeUpstreamHttpErrorResponse, readDisplaySafeErrorPayloadText } from "./upstream-http-error";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { antigravityHostCandidates } from "./google-antigravity-hosts";
import { recordAntigravityCooldown } from "../oauth/antigravity-routing";
import {
  abortError,
  cancelResponseBodyBestEffort,
  fetchWithAttemptDeadline,
  retryBackoffDelayMs,
  sleepWithAbort,
} from "../lib/upstream-retry";

const GOOGLE_RETRY_ATTEMPTS = 3;
const GOOGLE_RETRY_BASE_MS = 250;
const GOOGLE_RETRY_MAX_MS = 2_000;
const CCA_STREAM_INSPECTION_MAX_BYTES = 256 * 1024;

function isAntigravitySseRequest(request: AdapterRequest): boolean {
  return request.url.includes("/v1internal:streamGenerateContent?alt=sse");
}

function requestForHost(request: AdapterRequest, host: string): AdapterRequest {
  const current = new URL(request.url);
  const replacement = new URL(host);
  current.protocol = replacement.protocol;
  current.host = replacement.host;
  return { ...request, url: current.toString() };
}

function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) && timestamp > now ? timestamp - now : undefined;
}

async function inspectCcaSseBody(response: Response, signal?: AbortSignal): Promise<string> {
  try {
    const result = await readBoundedResponseBytes(response.clone(), {
      maxBytes: CCA_STREAM_INSPECTION_MAX_BYTES,
      signal,
    });
    return result.oversized ? "" : new TextDecoder().decode(result.bytes);
  } catch {
    return "";
  }
}

function isEmptyCcaSseBody(body: string): boolean {
  let sawCandidate = false;
  let sawInlineError = false;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) continue;
    const record = frame as Record<string, unknown>;
    if (record.error) sawInlineError = true;
    const response = record.response;
    const root = response && typeof response === "object" && !Array.isArray(response)
      ? response as Record<string, unknown>
      : record;
    if (Array.isArray(root.candidates) && root.candidates.length > 0) sawCandidate = true;
  }
  return !sawCandidate && !sawInlineError;
}

function isUnavailableResponse(response: Response): boolean {
  return response.status === 503;
}

function recordAntigravityHttpCooldown(
  response: Response,
  payloadText: string,
  accountId: string | undefined,
): void {
  if (!accountId) return;
  if (response.status === 429) {
    recordAntigravityCooldown(
      accountId,
      isQuotaExhaustedBody(payloadText) ? "quota_exhausted" : "rate_limited",
      retryAfterMs(response.headers.get("retry-after")),
    );
  } else if (response.status === 403 && isAntigravityGeoBlockedBody(payloadText)) {
    recordAntigravityCooldown(accountId, "geo_blocked");
  }
}

async function normalizeFinalGoogleError(label: string, res: Response, signal?: AbortSignal): Promise<Response> {
  return normalizeUpstreamHttpErrorResponse(res, {
    signal,
    formatMessage: payloadText => safeGoogleHttpErrorMessage(label, res.status, payloadText),
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
  const antigravityHosts = label === "Antigravity" && isAntigravitySseRequest(request)
    ? antigravityHostCandidates(new URL(request.url).origin)
    : [];
  let antigravityHostIndex = 0;
  let lastError: unknown;
  let activeRequest = request;
  let compatibilityReplayUsed = false;
  for (let attempt = 0; attempt < GOOGLE_RETRY_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      const res = await fetchWithAttemptDeadline(activeRequest.url, {
        method: activeRequest.method,
        headers: activeRequest.headers,
        body: activeRequest.body,
      }, timeoutMs, ctx.abortSignal, ctx.stream);
      if (antigravityHosts.length > 1 && antigravityHostIndex === 0) {
        const shouldTryPeer = res.status === 404 || isUnavailableResponse(res);
        if (shouldTryPeer) {
          cancelResponseBodyBestEffort(res);
          antigravityHostIndex = 1;
          activeRequest = requestForHost(request, antigravityHosts[antigravityHostIndex]!);
          continue;
        }
        if (res.ok) {
          const body = await inspectCcaSseBody(res, ctx.abortSignal);
          if (isEmptyCcaSseBody(body)) {
            cancelResponseBodyBestEffort(res);
            antigravityHostIndex = 1;
            activeRequest = requestForHost(request, antigravityHosts[antigravityHostIndex]!);
            continue;
          }
        }
      }
      if (label === "Antigravity" && (res.status === 429 || res.status === 403)) {
        const body = await inspectCcaSseBody(res, ctx.abortSignal);
        recordAntigravityHttpCooldown(res, body, ctx.accountId);
      }
      if (res.status === 400 && !compatibilityReplayUsed) {
        let payloadText = "";
        try {
          payloadText = await readDisplaySafeErrorPayloadText(res.clone(), ctx.abortSignal);
        } catch (error) {
          if (ctx.abortSignal?.aborted) throw error;
        }
        const repairedBody = repairGoogleInvalidRequestBody(activeRequest.body, payloadText);
        if (repairedBody !== undefined) {
          compatibilityReplayUsed = true;
          activeRequest = { ...activeRequest, body: repairedBody };
          cancelResponseBodyBestEffort(res);
          attempt--; // The changed-request replay is separate from transient retry accounting.
          continue;
        }
      }
      if (!retryableGoogleStatus(res.status) || attempt === GOOGLE_RETRY_ATTEMPTS - 1) {
        return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, ctx.abortSignal);
      }
      // A 429 may be a transient rate limit (retry) or hard quota exhaustion (do NOT retry —
      // it won't recover for hours and burns retries). Peek the body to tell them apart.
      if (res.status === 429 && !ctx.returnRawErrors) {
        const peek = await readDisplaySafeErrorPayloadText(res, ctx.abortSignal);
        if (isQuotaExhaustedBody(peek)) {
          return normalizeUpstreamHttpErrorResponse(res, {
            signal: ctx.abortSignal,
            formatMessage: payloadText => safeGoogleHttpErrorMessage(label, res.status, payloadText || peek),
          });
        }
      }
      cancelResponseBodyBestEffort(res);
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: GOOGLE_RETRY_BASE_MS,
        maxDelayMs: GOOGLE_RETRY_MAX_MS,
        headers: res.headers,
      }), ctx.abortSignal);
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      lastError = err;
      if (antigravityHosts.length > 1 && antigravityHostIndex === 0) {
        antigravityHostIndex = 1;
        activeRequest = requestForHost(request, antigravityHosts[antigravityHostIndex]!);
        continue;
      }
      if (attempt === GOOGLE_RETRY_ATTEMPTS - 1) throw err;
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: GOOGLE_RETRY_BASE_MS,
        maxDelayMs: GOOGLE_RETRY_MAX_MS,
      }), ctx.abortSignal);
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
