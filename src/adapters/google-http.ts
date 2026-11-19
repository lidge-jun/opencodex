import { inheritAccountAutoPauseResponse } from "../lib/account-auto-pause-response";
import type { AdapterFetchContext, AdapterRequest } from "./base";
import { createAdapterPhysicalSend } from "./physical-send";
import type { SendClass } from "../lib/request-execution-budget";
import type { AttemptRecoveryKind } from "../usage/log";
import { debugProviderDiagnosticLazy } from "../lib/debug";
import { extractGoogleRetryAfterSeconds, hasGoogle429BodyRetryEvidence, isQuotaExhaustedBody, retryableGoogleStatus, safeGoogleHttpErrorMessage } from "./google-errors";
import { repairGoogleInvalidRequestBodyWithReport } from "./google-wire-compiler";
import type { GoogleToolSchemaPolicy, GoogleToolSchemaProfile } from "./google-tool-schema";
import { normalizeUpstreamHttpErrorResponse, readDisplaySafeErrorPayloadText } from "./upstream-http-error";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { parseHttpDate } from "../lib/http-date";
import { markAntigravityModelNotFound } from "./antigravity-refusal";
import {
  abortError,
  cancelResponseBodyBestEffort,
  fetchWithAttemptDeadline,
  RETRY_AFTER_CEILING_MS,
  retryBackoffDelayMs,
  sleepWithAbort,
  SendBudgetExhaustedError,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
  isConnectionResetError,
  hasClientReplayVeto,
  hasUpstreamReplayRefusal,
  observedReplayRefusalCode,
  replayRefusalBodyCode,
  projectReplayRefusal,
  carryReplayRefusal,
  carryReplayRefusalToClient,
} from "../lib/upstream-retry";

const GOOGLE_RETRY_BASE_MS = 250;
const GOOGLE_RETRY_MAX_MS = 2_000;

// Google retries use RFC 9110 delta-seconds or HTTP-date from Fetch-normalized headers.
function googleRetryAfterDelayMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  if (!/\D/.test(raw)) return Math.min(Number(raw) * 1000, Number.MAX_SAFE_INTEGER);
  const now = Date.now();
  const dateMs = parseHttpDate(raw, now);
  return dateMs === undefined ? undefined : Math.max(0, dateMs - now);
}

export interface GoogleRetryOptions {
  /** Repair-and-replay structurally invalid 400 bodies (Vertex/Antigravity behavior). */
  repairInvalid400?: boolean;
  toolSchemaProfile?: GoogleToolSchemaProfile;
  toolSchemaPolicy?: GoogleToolSchemaPolicy;
}

async function normalizeFinalGoogleError(label: string, res: Response, request: AdapterRequest, signal?: AbortSignal): Promise<Response> {
  if (label === "Antigravity" && (res.status === 403 || res.status === 404)) {
    let payloadText = "";
    try {
      const body = await readBoundedResponseBody(res, {
        maxBytes: 4096, totalTimeoutMs: 2000, firstByteTimeoutMs: 2000,
        inactivityTimeoutMs: 2000, signal,
      });
      if (body.displaySafe && !body.truncated && !body.timedOut && !body.oversized) payloadText = body.text;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    const normalized = inheritAccountAutoPauseResponse(res, new Response(safeGoogleHttpErrorMessage(label, res.status,
      payloadText), {
      status: res.status, statusText: res.statusText, headers,
    }));
    if (!signal?.aborted) markAntigravityModelNotFound(normalized, request.body, payloadText);
    return normalized;
  }
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
export async function fetchGoogleWithRetry(
  label: string,
  request: AdapterRequest,
  ctx: AdapterFetchContext = {},
  opts: GoogleRetryOptions = {},
): Promise<Response> {
  const repairInvalid400 = opts.repairInvalid400 ?? true;
  const toolSchemaProfile = opts.toolSchemaProfile ?? { endpointClass: "vertex" };
  const toolSchemaPolicy = opts.toolSchemaPolicy ?? "compatible";
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  const send = createAdapterPhysicalSend(ctx);
  let lastError: unknown;
  let activeRequest = request;
  let compatibilityReplayUsed = false;
  let pendingResponse: Response | undefined;
  let retryDelayMs = 0;
  let sendClass: SendClass = "transient";
  let recovery: AttemptRecoveryKind | undefined;
  try {
  for (let attempt = 0; attempt < TRANSIENT_RETRY_MAX_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    // A credential rebuild mutates the original request while a repaired replay owns its body.
    // Refresh its destination and headers without discarding the already-repaired payload.
    if (activeRequest !== request) activeRequest = { ...activeRequest, url: request.url, method: request.method, headers: request.headers };
    try {
      let res = await send({ url: activeRequest.url, sendClass, recovery,
        beforePacing: async () => {
          // Admission already reserved the retry budget. Drop our old response lease
          // before waiting for capacity; never hold the next slot during backoff.
          const previous = pendingResponse;
          pendingResponse = undefined;
          if (previous) cancelResponseBodyBestEffort(previous);
          if (retryDelayMs > 0) await sleepWithAbort(retryDelayMs, ctx.abortSignal);
        },
        dispatch: (executor, wasDispatched) => fetchWithAttemptDeadline(activeRequest.url, {
          method: activeRequest.method, headers: activeRequest.headers, body: activeRequest.body,
        }, timeoutMs, ctx.abortSignal, ctx.stream, executor, { wasDispatched }),
      });
      retryDelayMs = 0;
      sendClass = "transient";
      recovery = undefined;
      const canRepair = res.status === 400 && repairInvalid400 && !compatibilityReplayUsed;
      if (await hasUpstreamReplayRefusal(res, ctx.abortSignal, { requireCompleteBody: retryableGoogleStatus(res.status) || canRepair })) {
        if (ctx.abortSignal?.aborted) {
          cancelResponseBodyBestEffort(res);
          throw abortError(ctx.abortSignal);
        }
        if (ctx.returnRawErrors) return res;
        const code = observedReplayRefusalCode(res) ?? (hasClientReplayVeto(res) ? undefined
          : replayRefusalBodyCode(await readDisplaySafeErrorPayloadText(res.clone(), ctx.abortSignal)));
        if (code) {
          cancelResponseBodyBestEffort(res);
          return carryReplayRefusal(res, projectReplayRefusal(code));
        }
        return normalizeFinalGoogleError(label, res, activeRequest, ctx.abortSignal)
          .then(client => carryReplayRefusalToClient(res, client));
      }
      if (canRepair) {
        let payloadText = "";
        try {
          payloadText = await readDisplaySafeErrorPayloadText(res.clone(), ctx.abortSignal);
        } catch (error) {
          if (ctx.abortSignal?.aborted) throw error;
        }
        const repair = repairGoogleInvalidRequestBodyWithReport(activeRequest.body, payloadText, toolSchemaProfile);
        if (repair !== undefined) {
          if (repair.toolSchemaLoss) {
            const changedSendAllowed = toolSchemaPolicy !== "reject-lossy";
            debugProviderDiagnosticLazy("google", "google-tool-schema-repair", () => ({
              ...repair.toolSchemaLoss,
              phase: "repair",
              declarationCount: repair.toolSchemaDeclarationCount ?? 0,
              changedSendAllowed,
            }));
            if (!changedSendAllowed) {
              return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, activeRequest, ctx.abortSignal);
            }
          }
          compatibilityReplayUsed = true;
          activeRequest = { ...activeRequest, body: repair.body };
          pendingResponse = res;
          sendClass = "repair";
          attempt--; // The changed-request replay is separate from transient retry accounting.
          continue;
        }
      }
      if (!retryableGoogleStatus(res.status)) return finalGoogleAnswer(label, res, activeRequest, ctx);
      const lastAttempt = attempt === TRANSIENT_RETRY_MAX_ATTEMPTS - 1;
      let retryAfterMs = googleRetryAfterDelayMs(res.headers);
      if (res.status === 429) {
        // On the final attempt, read the body for retry advice only if the header cannot supply it.
        const peek = !lastAttempt || retryAfterMs === undefined
          ? await readDisplaySafeErrorPayloadText(res.clone(), ctx.abortSignal)
          : "";
        if (retryAfterMs === undefined) {
          const seconds = extractGoogleRetryAfterSeconds(peek);
          if (seconds !== undefined) retryAfterMs = Number(seconds) * 1000;
          res = replaceGoogleRetryAfter(res, seconds);
        }
        if (!lastAttempt && isQuotaExhaustedBody(peek, label)) {
          if (ctx.returnRawErrors) return res;
          return normalizeUpstreamHttpErrorResponse(res, {
            signal: ctx.abortSignal,
            formatMessage: payloadText => safeGoogleHttpErrorMessage(label, res.status, payloadText || peek),
          });
        }
        // #8897: replaying the same bytes requires evidence that the next send could succeed.
        if (!lastAttempt && retryAfterMs === undefined && !hasGoogle429BodyRetryEvidence(peek)) {
          return finalGoogleAnswer(label, res, activeRequest, ctx);
        }
      } else if (retryAfterMs === undefined) {
        res = replaceGoogleRetryAfter(res);
      }
      if (lastAttempt) return finalGoogleAnswer(label, res, activeRequest, ctx);
      // Retry-After names the earliest send Google will serve (#7802). The local maximum bounds
      // only our own backoff; it must not shorten the provider's instruction into a send it
      // already said it would refuse. An instruction past the shared wait deadline ends with
      // this upstream answer, Retry-After intact, exactly as fetchWithTransientRetry does.
      const delayMs = retryBackoffDelayMs(attempt, {
        baseDelayMs: GOOGLE_RETRY_BASE_MS,
        maxDelayMs: GOOGLE_RETRY_MAX_MS,
        retryAfterMs,
        retryAfterIsLowerBound: true,
      });
      if (delayMs > RETRY_AFTER_CEILING_MS) {
        return finalGoogleAnswer(label, res, activeRequest, ctx);
      }
      pendingResponse = res;
      recovery = res.status === 429 ? "rate-limit-429" : "transient-5xx";
      retryDelayMs = delayMs;
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      if (err instanceof SendBudgetExhaustedError) {
        if (pendingResponse) {
          // The ladder had already classified this response as retryable and was about to send
          // again; the budget refused. Returning the original response is right — it is a real
          // upstream answer — but it used to leave the log indistinguishable from a request
          // where no retry was ever eligible (#5044).
          ctx.onRecoveryWithheld?.({ reason: "retry-send-budget" });
          const retained = pendingResponse;
          pendingResponse = undefined; // Transfer ownership to the caller/normalizer.
          return finalGoogleAnswer(label, retained, activeRequest, ctx);
        }
        throw err;
      }
      lastError = err;
      if (attempt === TRANSIENT_RETRY_MAX_ATTEMPTS - 1) throw err;
      sendClass = "transient";
      recovery = isConnectionResetError(err) ? "connection-reset" : undefined;
      retryDelayMs = retryBackoffDelayMs(attempt, {
        baseDelayMs: GOOGLE_RETRY_BASE_MS,
        maxDelayMs: GOOGLE_RETRY_MAX_MS,
      });
    }
  }
  throw lastError ?? new Error(`${label} fetch failed`);
  } finally {
    // A cancellation before the next retry's preparation must not strand its lease.
    if (pendingResponse) cancelResponseBodyBestEffort(pendingResponse);
  }
}

function finalGoogleAnswer(label: string, res: Response, request: AdapterRequest, ctx: AdapterFetchContext): Response | Promise<Response> {
  return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, request, ctx.abortSignal);
}

/** Replace an invalid header with body advice, or remove it when no delay survives. */
function replaceGoogleRetryAfter(res: Response, seconds?: string): Response {
  if (seconds === undefined && !res.headers.has("retry-after")) return res;
  const headers = new Headers(res.headers);
  if (seconds === undefined) headers.delete("retry-after");
  else headers.set("retry-after", seconds);
  return inheritAccountAutoPauseResponse(res, new Response(res.body, { status: res.status, statusText: res.statusText, headers }));
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
export function fetchDirectGeminiWithRetry(
  request: AdapterRequest,
  ctx: AdapterFetchContext = {},
  schemaPolicy: Pick<GoogleRetryOptions, "toolSchemaProfile" | "toolSchemaPolicy"> = {},
): Promise<Response> {
  return fetchGoogleWithRetry("Gemini", request, { ...ctx, returnRawErrors: true }, {
    ...schemaPolicy,
    repairInvalid400: false,
  });
}

/** Transient ladder plus one compatibility repair. */
export const GOOGLE_HOSTED_ITERATION_SEND_LIMIT = TRANSIENT_RETRY_MAX_ATTEMPTS + 1;

/** Vertex AI retry wrapper. */
export function fetchVertexWithRetry(
  request: AdapterRequest,
  ctx: AdapterFetchContext = {},
  schemaPolicy: Pick<GoogleRetryOptions, "toolSchemaProfile" | "toolSchemaPolicy"> = {},
): Promise<Response> {
  return fetchGoogleWithRetry("Vertex AI", request, ctx, {
    toolSchemaProfile: { endpointClass: "vertex" },
    ...schemaPolicy,
  });
}

/** Antigravity (Cloud Code Assist) retry wrapper. */
export function fetchAntigravityWithRetry(
  request: AdapterRequest,
  ctx: AdapterFetchContext = {},
  schemaPolicy: Pick<GoogleRetryOptions, "toolSchemaProfile" | "toolSchemaPolicy"> = {},
): Promise<Response> {
  return fetchGoogleWithRetry("Antigravity", request, ctx, {
    toolSchemaProfile: { endpointClass: "cloud-code-assist" },
    ...schemaPolicy,
  });
}
