import type { AdapterFetchContext, AdapterRequest } from "./base";
import {
  isAntigravityGeoBlockedBody,
  isQuotaExhaustedBody,
  retryableGoogleStatus,
  safeGoogleHttpErrorMessage,
} from "./google-errors";
import { repairGoogleInvalidRequestBody } from "./google-wire-compiler";
import { normalizeUpstreamHttpErrorResponse, readDisplaySafeErrorPayloadText } from "./upstream-http-error";
import { antigravityHostCandidates, isAntigravityHttpsHost } from "./google-antigravity-hosts";
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
export const CCA_STREAM_PROBE_MAX_BYTES = 100 * 1024 * 1024;
export const CCA_STREAM_CLASSIFY_MAX_BYTES = 256 * 1024;

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

type CcaSseProbe = "empty" | "candidate" | "unavailable" | "quota_exhausted" | "geo_blocked" | "terminal";

function probeCcaSseEvent(bytes: Uint8Array): CcaSseProbe {
  const text = new TextDecoder().decode(bytes);
  let sawData = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    sawData = true;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      return "terminal";
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return "terminal";
    const record = frame as Record<string, unknown>;
    if (record.error) {
      const error = record.error;
      const errorRecord = error && typeof error === "object" && !Array.isArray(error)
        ? error as Record<string, unknown>
        : {};
      const status = String(errorRecord.status ?? "").toUpperCase();
      const code = errorRecord.code;
      if (status === "UNAVAILABLE" || status === "503" || code === 503 || code === "503") {
        return "unavailable";
      }
      const serialized = JSON.stringify(frame);
      if (isQuotaExhaustedBody(serialized)) return "quota_exhausted";
      if (isAntigravityGeoBlockedBody(serialized)) return "geo_blocked";
      return "terminal";
    }
    const response = record.response;
    if (!response || typeof response !== "object" || Array.isArray(response)) return "terminal";
    const root = response as Record<string, unknown>;
    if (Array.isArray(root.candidates) && root.candidates.length > 0) return "candidate";
  }
  return sawData ? "empty" : "empty";
}

export class CcaProbeBuffer {
  private storage: Uint8Array;
  length = 0;

  constructor(private readonly maxBytes = CCA_STREAM_PROBE_MAX_BYTES) {
    this.storage = new Uint8Array(Math.min(64 * 1024, maxBytes));
  }

  append(next: Uint8Array): boolean {
    const required = this.length + next.byteLength;
    if (required > this.maxBytes) return false;
    if (required > this.storage.byteLength) {
      let capacity = Math.max(this.storage.byteLength, 1);
      while (capacity < required) {
        const grownCapacity = Math.min(this.maxBytes, capacity * 2);
        capacity = grownCapacity <= capacity ? this.maxBytes : grownCapacity;
      }
      const grown = new Uint8Array(capacity);
      grown.set(this.storage.subarray(0, this.length));
      this.storage = grown;
    }
    this.storage.set(next, this.length);
    this.length = required;
    return true;
  }

  view(): Uint8Array {
    return this.storage.subarray(0, this.length);
  }
}

function firstSseEventEnd(bytes: Uint8Array, from: number): number | undefined {
  for (let index = from; index + 1 < bytes.byteLength; index++) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) return index + 2;
    if (index + 3 < bytes.byteLength
      && bytes[index] === 13 && bytes[index + 1] === 10
      && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
      return index + 4;
    }
  }
  return undefined;
}

function responseWithBufferedBody(
  response: Response,
  buffered: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pending?: Uint8Array,
  status = response.status,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          if (buffered.byteLength > 0) controller.enqueue(buffered);
          if (pending?.byteLength) controller.enqueue(pending);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.byteLength) controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      })();
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, {
    status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function prepareCcaSseResponse(
  response: Response,
  fetchPeer: (() => Promise<Response>) | undefined,
  accountId?: string,
): Promise<Response> {
  if (!response.body) return fetchPeer ? fetchPeer() : response;
  const reader = response.body.getReader();
  const probeBuffer = new CcaProbeBuffer();
  let scanned = 0;
  const passthrough = (pending?: Uint8Array, status = response.status) =>
    responseWithBufferedBody(response, probeBuffer.view(), reader, pending, status);
  const failoverOrPassthrough = async (): Promise<Response> => {
    if (!fetchPeer) return passthrough();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    return fetchPeer();
  };
  try {
    while (probeBuffer.length < CCA_STREAM_PROBE_MAX_BYTES) {
      if (scanned >= CCA_STREAM_CLASSIFY_MAX_BYTES || probeBuffer.length >= CCA_STREAM_CLASSIFY_MAX_BYTES) {
        return passthrough();
      }
      const { done, value } = await reader.read();
      if (done) {
        const buffered = probeBuffer.view();
        const residual = buffered.subarray(scanned);
        if (residual.byteLength > 0) {
          const probe = probeCcaSseEvent(residual);
          if (probe === "candidate" || probe === "terminal") {
            return passthrough();
          }
          if (probe === "unavailable") {
            return failoverOrPassthrough();
          }
          if (probe === "quota_exhausted" || probe === "geo_blocked") {
            const status = probe === "quota_exhausted" ? 429 : 403;
            if (accountId) {
              recordAntigravityCooldown(
                accountId,
                probe === "quota_exhausted" ? "quota_exhausted" : "geo_blocked",
              );
            }
            return passthrough(undefined, status);
          }
        }
        return failoverOrPassthrough();
      }
      if (!value?.byteLength) continue;
      const available = CCA_STREAM_PROBE_MAX_BYTES - probeBuffer.length;
      const overflow = value.byteLength > available ? value.subarray(available) : undefined;
      probeBuffer.append(overflow ? value.subarray(0, available) : value);
      const buffered = probeBuffer.view();
      while (true) {
        if (scanned >= CCA_STREAM_CLASSIFY_MAX_BYTES) return passthrough(overflow);
        const eventEnd = firstSseEventEnd(buffered, scanned);
        if (eventEnd === undefined) break;
        const probe = probeCcaSseEvent(buffered.subarray(scanned, eventEnd));
        scanned = eventEnd;
        if (probe === "candidate") return passthrough(overflow);
        if (probe === "unavailable") {
          if (overflow?.byteLength) {
            return passthrough(overflow);
          }
          return failoverOrPassthrough();
        }
        if (probe === "quota_exhausted" || probe === "geo_blocked") {
          const status = probe === "quota_exhausted" ? 429 : 403;
          if (accountId) {
            recordAntigravityCooldown(
              accountId,
              probe === "quota_exhausted" ? "quota_exhausted" : "geo_blocked",
            );
          }
          return passthrough(overflow, status);
        }
        if (probe === "terminal") return passthrough(overflow);
      }
      if (overflow?.byteLength) return passthrough(overflow);
      if (scanned >= CCA_STREAM_CLASSIFY_MAX_BYTES || probeBuffer.length >= CCA_STREAM_CLASSIFY_MAX_BYTES) {
        return passthrough();
      }
    }
    return passthrough();
  } catch (error) {
    try { await reader.cancel(error); } catch { /* cleanup only */ }
    reader.releaseLock();
    throw error;
  }
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

export interface GoogleRetryOptions {
  /** Repair-and-replay structurally invalid 400 bodies (Vertex/Antigravity behavior). */
  repairInvalid400?: boolean;
}

async function normalizeFinalGoogleError(label: string, res: Response, signal?: AbortSignal): Promise<Response> {
  return normalizeUpstreamHttpErrorResponse(res, {
    signal,
    formatMessage: payloadText => safeGoogleHttpErrorMessage(label, res.status, payloadText),
  });
}

/**
 * Fetch a Google-family upstream with Kiro-style hardening: per-attempt timeout
 * (`AbortSignal.any([parent, timeout])`), bounded retry on transient status / network errors,
 * `Retry-After` honoring, jittered exponential backoff, and (unless raw mode is used) a
 * classified + redacted final error body. `label` is the provider-facing prefix used in error
 * messages.
 */
async function fetchGoogleWithRetryInternal(
  label: string,
  request: AdapterRequest,
  ctx: AdapterFetchContext,
  allowAntigravityHostFailover: boolean,
  opts: GoogleRetryOptions = {},
): Promise<Response> {
  const repairInvalid400 = opts.repairInvalid400 ?? true;
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  const executor = ctx.executor ?? globalThis.fetch;
  let activeRequest = request;
  if (label === "Antigravity" && isAntigravitySseRequest(activeRequest)) {
    const origin = new URL(activeRequest.url).origin;
    if (!isAntigravityHttpsHost(origin)) {
      const httpsHost = antigravityHostCandidates(origin).find(isAntigravityHttpsHost);
      if (httpsHost) activeRequest = requestForHost(activeRequest, httpsHost);
    }
  }
  const antigravityHosts = allowAntigravityHostFailover && label === "Antigravity" && isAntigravitySseRequest(activeRequest)
    ? antigravityHostCandidates(new URL(activeRequest.url).origin).filter(isAntigravityHttpsHost)
    : [];
  let antigravityHostIndex = 0;
  let lastError: unknown;
  let compatibilityReplayUsed = false;
  for (let attempt = 0; attempt < GOOGLE_RETRY_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      const res = await fetchWithAttemptDeadline(activeRequest.url, {
        method: activeRequest.method,
        headers: activeRequest.headers,
        body: activeRequest.body,
      }, timeoutMs, ctx.abortSignal, ctx.stream, executor);
      if (antigravityHosts.length > 1 && antigravityHostIndex === 0) {
        const shouldTryPeer = res.status === 404 || isUnavailableResponse(res);
        if (shouldTryPeer) {
          cancelResponseBodyBestEffort(res);
          antigravityHostIndex = 1;
          activeRequest = requestForHost(request, antigravityHosts[antigravityHostIndex]!);
          continue;
        }
      }
      if (label === "Antigravity" && isAntigravitySseRequest(activeRequest) && res.ok) {
        const fetchPeer = antigravityHosts.length > 1 && antigravityHostIndex === 0
          ? () => fetchGoogleWithRetryInternal(
            label,
            requestForHost(request, antigravityHosts[1]!),
            ctx,
            false,
            opts,
          )
          : undefined;
        return prepareCcaSseResponse(res, fetchPeer, ctx.accountId);
      }
      if (label === "Antigravity" && (res.status === 429 || res.status === 403)) {
        const body = await readDisplaySafeErrorPayloadText(res.clone(), ctx.abortSignal);
        recordAntigravityHttpCooldown(res, body, ctx.accountId);
      }
      if (res.status === 400 && repairInvalid400 && !compatibilityReplayUsed) {
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
      if (res.status === 429) {
        const peekTarget = ctx.returnRawErrors ? res.clone() : res;
        const peek = await readDisplaySafeErrorPayloadText(peekTarget, ctx.abortSignal);
        if (isQuotaExhaustedBody(peek)) {
          return ctx.returnRawErrors ? res : normalizeUpstreamHttpErrorResponse(res, {
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

export function fetchGoogleWithRetry(
  label: string,
  request: AdapterRequest,
  ctx: AdapterFetchContext = {},
  opts: GoogleRetryOptions = {},
): Promise<Response> {
  return fetchGoogleWithRetryInternal(label, request, ctx, true, opts);
}

/**
 * AI Studio direct (`generativelanguage.googleapis.com`) retry wrapper.
 *
 * Direct requests keep the default server error surface — the raw `Provider error <status>:
 * <body>` text the shared Responses path formats — and keep single-shot 400 semantics (no
 * request-shape compatibility replay). The wrapper exists for the failure mode observed in
 * production: AI Studio's transient `503 UNAVAILABLE` "model is currently experiencing high
 * demand" spikes, plus plain rate-limit 429s, both of which previously failed immediately
 * because the default server fetch path only retries connection resets.
 */
export function fetchDirectGeminiWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  return fetchGoogleWithRetry("Gemini", request, { ...ctx, returnRawErrors: true }, { repairInvalid400: false });
}

/** Vertex AI retry wrapper. */
export function fetchVertexWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  return fetchGoogleWithRetry("Vertex AI", request, ctx);
}

/** Antigravity (Cloud Code Assist) retry wrapper. */
export function fetchAntigravityWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
  return fetchGoogleWithRetry("Antigravity", request, ctx);
}
