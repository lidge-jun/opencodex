import type { AdapterFetchContext, AdapterRequest } from "./base";
import { createAdapterPhysicalSend } from "./physical-send";
import type { SendClass } from "../lib/request-execution-budget";
import type { AttemptRecoveryKind } from "../usage/log";
import { debugProviderDiagnosticLazy } from "../lib/debug";
import { isQuotaExhaustedBody, retryableGoogleStatus, safeGoogleHttpErrorMessage } from "./google-errors";
import { repairGoogleInvalidRequestBodyWithReport } from "./google-wire-compiler";
import type { GoogleToolSchemaPolicy, GoogleToolSchemaProfile } from "./google-tool-schema";
import { normalizeUpstreamHttpErrorResponse, readDisplaySafeErrorPayloadText } from "./upstream-http-error";
import {
  abortError,
  cancelResponseBodyBestEffort,
  fetchWithAttemptDeadline,
  retryBackoffDelayMs,
  sleepWithAbort,
  SendBudgetExhaustedError,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
  isConnectionResetError,
} from "../lib/upstream-retry";

const GOOGLE_RETRY_BASE_MS = 250;
const GOOGLE_RETRY_MAX_MS = 2_000;

export interface GoogleRetryOptions {
  /** Repair-and-replay structurally invalid 400 bodies (Vertex/Antigravity behavior). */
  repairInvalid400?: boolean;
  toolSchemaProfile?: GoogleToolSchemaProfile;
  toolSchemaPolicy?: GoogleToolSchemaPolicy;
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
  for (let attempt = 0; attempt < TRANSIENT_RETRY_MAX_ATTEMPTS; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      const res = await send({ url: activeRequest.url, sendClass, recovery,
        beforeDispatch: async () => {
          if (retryDelayMs > 0) await sleepWithAbort(retryDelayMs, ctx.abortSignal);
          if (pendingResponse) cancelResponseBodyBestEffort(pendingResponse);
          pendingResponse = undefined;
        },
        dispatch: executor => fetchWithAttemptDeadline(activeRequest.url, {
          method: activeRequest.method, headers: activeRequest.headers, body: activeRequest.body,
        }, timeoutMs, ctx.abortSignal, ctx.stream, executor),
      });
      retryDelayMs = 0;
      sendClass = "transient";
      recovery = undefined;
      if (res.status === 400 && repairInvalid400 && !compatibilityReplayUsed) {
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
              return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, ctx.abortSignal);
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
      if (!retryableGoogleStatus(res.status) || attempt === TRANSIENT_RETRY_MAX_ATTEMPTS - 1) {
        return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, ctx.abortSignal);
      }
      // A 429 may be a transient rate limit (retry) or hard quota exhaustion (do NOT retry —
      // it won't recover for hours and burns retries). Peek the body to tell them apart.
      if (res.status === 429) {
        const peekTarget = res.clone();
        const peek = await readDisplaySafeErrorPayloadText(peekTarget, ctx.abortSignal);
        if (isQuotaExhaustedBody(peek)) {
          return ctx.returnRawErrors ? res : normalizeUpstreamHttpErrorResponse(res, {
            signal: ctx.abortSignal,
            formatMessage: payloadText => safeGoogleHttpErrorMessage(label, res.status, payloadText || peek),
          });
        }
      }
      pendingResponse = res;
      recovery = res.status === 429 ? "rate-limit-429" : "transient-5xx";
      retryDelayMs = retryBackoffDelayMs(attempt, {
        baseDelayMs: GOOGLE_RETRY_BASE_MS,
        maxDelayMs: GOOGLE_RETRY_MAX_MS,
        headers: res.headers,
      });
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      if (err instanceof SendBudgetExhaustedError) {
        if (pendingResponse) {
          // The ladder had already classified this response as retryable and was about to send
          // again; the budget refused. Returning the original response is right — it is a real
          // upstream answer — but it used to leave the log indistinguishable from a request
          // where no retry was ever eligible (#5044).
          ctx.onRecoveryWithheld?.({ reason: "retry-send-budget" });
          return ctx.returnRawErrors ? pendingResponse : normalizeFinalGoogleError(label, pendingResponse, ctx.abortSignal);
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
