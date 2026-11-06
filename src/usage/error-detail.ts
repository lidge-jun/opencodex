/**
 * Error detail kept on request-log rows (live ring, /api/logs, usage.jsonl and hydration).
 *
 * Rows carry only proxy-owned error facts: a code from a closed vocabulary, a classified upstream
 * condition, and, for one provider, a numeric quota reset time. Upstream-authored error text and
 * tokens are read here once to derive those facts and are never retained.
 */
import { classifyUpstreamCondition, isUpstreamCondition, type UpstreamCondition } from "../lib/upstream-condition";
import { boundedFailureDetail, type FailureDetail, type FailureDetailCode } from "../lib/failure-detail";
import { boundedServiceTier } from "../lib/response-service-tier";

export { boundedServiceTier };

/**
 * Every error code a row may carry. Codes outside this set (an upstream-supplied code that reached a
 * writer, a future writer's typo) collapse to the status fallback below. http_NNN codes are formatted
 * by the proxy from a numeric status and stay valid.
 */
export const LOG_ERROR_CODES: ReadonlySet<string> = new Set([
  // classifyError and requestLogErrorCode outputs
  "spend_ledger_storage_unavailable", "previous_response_not_found", "client_cancelled", "client_closed_request",
  "cyber_policy", "input_admission_refused", "inbound_body_too_large", "context_length_exceeded",
  "tool_catalog_too_large", "rate_limit_exceeded", "insufficient_quota", "request_send_budget_exhausted",
  "origin_rejected", "upstream_server_error", "invalid_api_key", "permission_denied", "location_not_supported",
  "subscription_required", "server_is_overloaded", "invalid_request_error", "upstream_error",
  // local refusals and proxy decisions
  "server_busy", "unsupported_feature", "usage_limit_reached", "undeclared_tool_call", "outbound_body_too_large",
  "codex_no_account", "upstream_reset_replay_refused", "memory_model_target_unavailable",
  "intercept_target_unavailable", "observation_barrier_timeout", "claude_thread_unsupported",
  "claude_compatibility_configuration", "claude_compatibility_unsupported",
  "unsupported_credential_domain", "unsupported_synthetic_selector", "unsupported_shadow_rewrite",
  // workflow budget refusals
  "workflow_sends_exhausted", "workflow_children_exhausted", "workflow_concurrency_exhausted",
  "workflow_spend_exhausted", "workflow_tracking_exhausted", "workflow_send_replayed",
  "workflow_pool_history_unresolved", "workflow_spend_undurable",
]);

const HTTP_CODE = /^http_[1-5][0-9]{2}$/;

function statusFallbackCode(status: number | undefined): string | undefined {
  if (status === undefined || !Number.isInteger(status) || status < 400) return undefined;
  if (status === 499) return "client_closed_request";
  if (status === 400 || status === 409) return "invalid_request_error";
  if (status === 401) return "invalid_api_key";
  if (status === 403) return "permission_denied";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 503) return "server_is_overloaded";
  if (status >= 500) return "upstream_server_error";
  return `http_${status}`;
}

/** A code from the closed vocabulary, or the proxy's own code for the status, or nothing. */
export function normalizeLogErrorCode(code: unknown, status?: number): string | undefined {
  if (typeof code === "string" && (LOG_ERROR_CODES.has(code) || HTTP_CODE.test(code))) return code;
  return typeof code === "string" && code ? statusFallbackCode(status) ?? "upstream_error" : undefined;
}

// Meta Muse states its quota window in one fixed sentence. The reset time is kept as a number so
// the dashboard needs no message text.
const MUSE_PROVIDER = "meta-muse";
const MUSE_RESET_SENTENCE = /^Subscription quota exhausted\. Your usage window resets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\.$/;
export const RATE_LIMIT_RESET_MAX_MS = 8 * 24 * 60 * 60 * 1000;

/** A reset time is kept only when it is a finite epoch-ms value after the request and within 8 days. */
export function boundedRateLimitResetAt(value: unknown, timestamp: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  return value > timestamp && value - timestamp <= RATE_LIMIT_RESET_MAX_MS ? value : undefined;
}

export function deriveRateLimitResetAt(entry: {
  provider?: unknown; status?: unknown; errorCode?: unknown; upstreamError?: unknown; timestamp?: unknown;
}): number | undefined {
  if (entry.provider !== MUSE_PROVIDER || entry.status !== 429 || entry.errorCode !== "rate_limit_exceeded") return undefined;
  if (typeof entry.upstreamError !== "string") return undefined;
  const match = MUSE_RESET_SENTENCE.exec(entry.upstreamError);
  if (!match) return undefined;
  const parsed = Date.parse(match[1]!);
  return boundedRateLimitResetAt(Number.isFinite(parsed) ? parsed : undefined, entry.timestamp);
}

/** The fields an error-detail projection reads; all optional so legacy rows qualify. */
export interface ErrorDetailSource {
  status?: unknown;
  timestamp?: unknown;
  provider?: unknown;
  errorCode?: unknown;
  terminalStatus?: unknown;
  upstreamError?: unknown;
  upstreamErrorCode?: unknown;
  upstreamErrorType?: unknown;
  upstreamCondition?: unknown;
  rateLimitResetAt?: unknown;
  failureDetail?: unknown;
}

export interface ErrorDetail {
  errorCode?: string;
  upstreamCondition?: UpstreamCondition;
  rateLimitResetAt?: number;
  failureDetail?: FailureDetail;
}

const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

// Sentences this proxy writes into a relayed error body (web-search and image-bridge loops, body
// inactivity guard). The request log only sees them as captured error text, so a match becomes a
// closed code with the parsed number; the number is bounded so no credential-length value can fit.
const PROXY_SENTENCES: ReadonlyArray<readonly [RegExp, FailureDetailCode]> = [
  [/^Provider response-header timeout after (\d{1,7})ms during (?:web-search|image-bridge)$/, "header_timeout"],
  [/^Upstream response body stalled for (\d{1,7})ms$/, "body_stall"],
  [/^Routed model generation timeout after (\d{1,7})ms without response bytes during web-search$/, "generation_timeout"],
  [/^runTurn inactivity timeout after (\d{1,7})ms during image-bridge$/, "turn_inactivity"],
  [/^Provider connect timeout after (\d{1,7})ms$/, "connect_timeout"],
  [/^client closed request during web-search$/, "client_closed"],
];

function proxySentenceDetail(text: string | undefined): FailureDetail | undefined {
  if (text === undefined) return undefined;
  for (const [pattern, code] of PROXY_SENTENCES) {
    const match = pattern.exec(text);
    if (match) return match[1] === undefined ? { code } : { code, value: Number(match[1]) };
  }
  return undefined;
}

/**
 * Derive the proxy-owned error facts for one row. An existing condition or reset time is kept only
 * when valid; otherwise both are derived from upstream evidence, which the caller then drops.
 * A condition is derived only when the row carries upstream evidence, so local refusals get none.
 */
export function errorDetailFor(entry: ErrorDetailSource): ErrorDetail {
  const status = typeof entry.status === "number" ? entry.status : undefined;
  const errorCode = normalizeLogErrorCode(entry.errorCode, status);
  // The HTTP status decides when present: a 200 that stopped at the requested output limit is an
  // incomplete terminal but a successful request, not an upstream failure.
  const failed = status !== undefined ? status >= 400 : typeof entry.terminalStatus === "string" && entry.terminalStatus !== "completed";
  // A client that closed the request is not an upstream condition.
  const clientClosed = status === 499 || errorCode === "client_closed_request" || errorCode === "client_cancelled";
  // A recorded condition is kept under the same rules that derive one: failed and not a client close.
  let upstreamCondition: UpstreamCondition | undefined = failed && !clientClosed && isUpstreamCondition(entry.upstreamCondition)
    ? entry.upstreamCondition : undefined;
  const evidence = str(entry.upstreamError) ?? str(entry.upstreamErrorCode) ?? str(entry.upstreamErrorType);
  if (!upstreamCondition && failed && !clientClosed && evidence !== undefined && status !== undefined) {
    upstreamCondition = classifyUpstreamCondition({
      status,
      code: str(entry.upstreamErrorCode),
      type: str(entry.upstreamErrorType),
      message: str(entry.upstreamError),
    });
  }
  const rateLimitResetAt = boundedRateLimitResetAt(entry.rateLimitResetAt, entry.timestamp)
    ?? deriveRateLimitResetAt({ provider: entry.provider, status: entry.status, timestamp: entry.timestamp, upstreamError: entry.upstreamError, errorCode });
  // A closed code with bounded parameters; free text (a legacy or edited row) is dropped.
  const failureDetail = boundedFailureDetail(entry.failureDetail) ?? proxySentenceDetail(str(entry.upstreamError));
  return {
    ...(errorCode ? { errorCode } : {}),
    ...(upstreamCondition ? { upstreamCondition } : {}),
    ...(rateLimitResetAt !== undefined ? { rateLimitResetAt } : {}),
    ...(failureDetail ? { failureDetail } : {}),
  };
}

/** Upstream-authored fields that never leave the request context. */
export const UPSTREAM_TEXT_FIELDS = ["upstreamError", "upstreamErrorCode", "upstreamErrorType", "upstreamRequestId"] as const;

type ProjectableEntry = ErrorDetailSource & {
  attempts?: unknown; attemptNormalizationDropped?: unknown; responseServiceTier?: unknown; tierOutcome?: unknown;
};

/** A tier outcome whose recorded response tier is a closed member (or absent); same object when unchanged. */
function boundedTierOutcome(outcome: unknown): unknown {
  if (!outcome || typeof outcome !== "object" || !("responseServiceTier" in outcome)) return outcome;
  const record = outcome as Record<string, unknown>;
  const tier = boundedServiceTier(record.responseServiceTier);
  if (tier === record.responseServiceTier) return outcome;
  const { responseServiceTier: _dropped, ...rest } = record;
  return tier === undefined ? rest : { ...rest, responseServiceTier: tier };
}

/**
 * The live-row form of {@link errorDetailFor}: attach the proxy-owned facts and remove upstream text.
 * Returns the same object when nothing changes, so callers that rely on identity keep it. Attempt
 * codes outside the vocabulary are corrected, and upstream text fields removed, in place (attempts
 * keep their identity too).
 */
export function projectErrorDetail<T extends ProjectableEntry>(entry: T): T {
  if (Array.isArray(entry.attempts)) {
    for (const attempt of entry.attempts as unknown[]) {
      if (!attempt || typeof attempt !== "object") continue;
      const record = attempt as Record<string, unknown>;
      for (const field of UPSTREAM_TEXT_FIELDS) if (field in record) delete record[field];
      if ("tierOutcome" in record) record.tierOutcome = boundedTierOutcome(record.tierOutcome);
      if (typeof record.errorCode !== "string") continue;
      const code = normalizeLogErrorCode(record.errorCode, typeof record.status === "number" ? record.status : undefined);
      if (code !== record.errorCode) {
        if (code === undefined) delete record.errorCode;
        else record.errorCode = code;
      }
    }
  }
  const detail = errorDetailFor(entry);
  const responseServiceTier = boundedServiceTier(entry.responseServiceTier);
  const tierOutcome = boundedTierOutcome(entry.tierOutcome);
  const unchanged = UPSTREAM_TEXT_FIELDS.every(field => entry[field as keyof ErrorDetailSource] === undefined)
    && entry.responseServiceTier === responseServiceTier && entry.tierOutcome === tierOutcome
    && entry.errorCode === detail.errorCode
    && entry.upstreamCondition === detail.upstreamCondition
    && entry.rateLimitResetAt === detail.rateLimitResetAt
    && entry.failureDetail === detail.failureDetail;
  if (unchanged) return entry;
  const out = { ...entry } as Record<string, unknown>;
  // A non-enumerable marker does not survive a spread; carry it explicitly.
  if (entry.attemptNormalizationDropped === true) out.attemptNormalizationDropped = true;
  for (const field of UPSTREAM_TEXT_FIELDS) delete out[field];
  if (responseServiceTier === undefined) delete out.responseServiceTier;
  else out.responseServiceTier = responseServiceTier;
  if (tierOutcome === undefined) delete out.tierOutcome;
  else out.tierOutcome = tierOutcome;
  for (const field of ["errorCode", "upstreamCondition", "rateLimitResetAt", "failureDetail"] as const) {
    if (detail[field] === undefined) delete out[field];
    else out[field] = detail[field];
  }
  return out as T;
}
