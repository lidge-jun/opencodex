import { parseUpstreamJsonPayload, safeUpstreamErrorString, sanitizeUpstreamErrorText } from "./upstream-http-error";
import { isLocationUnsupportedMessage } from "../lib/errors";
import { retryAfterDelayMs } from "../lib/upstream-retry";
import { googleErrorDetails, isAntigravityTosViolationBody } from "./google-error-details";

export const ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX = "Antigravity account validation required (VALIDATION_REQUIRED)";
/** Leading words of every normalized Antigravity 403 that is not a validation demand (see `classifyGoogle`). */
export const ANTIGRAVITY_ACCESS_DENIED_PREFIX = "Antigravity access denied";
/** Leading words of a normalized Antigravity refusal whose text names the credential itself. */
export const ANTIGRAVITY_AUTH_FAILED_PREFIX = "Antigravity authentication failed";
/**
 * Written right after a normalized prefix only when the response carried Google's structured
 * `error.status: "PERMISSION_DENIED"`. Message wording alone never produces it, so a reader of the
 * normalized string can tell a refusal Google attributed to the account from a proxy page or an
 * enum-less envelope that merely says "expired".
 */
export const GOOGLE_PERMISSION_DENIED_SUFFIX = " (PERMISSION_DENIED)";
/** Emitted only for a body `isAntigravityTosViolationBody` accepts; dispatch trusts nothing else. */
export const ANTIGRAVITY_TOS_VIOLATION_PREFIX = "Antigravity account suspended (TOS_VIOLATION)";
const ANTIGRAVITY_TOS_VIOLATION_MESSAGE = "Google disabled this account for a Terms of Service violation; appeal with Google, then sign in again";

function hasAntigravityValidationReason(payloadText: string): boolean {
  const payload = parseUpstreamJsonPayload(payloadText);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const details = (error as { details?: unknown }).details;
  return Array.isArray(details) && details.some(detail =>
    detail !== null && typeof detail === "object" && !Array.isArray(detail)
    && (detail as { reason?: unknown }).reason === "VALIDATION_REQUIRED");
}

/** Pull the human detail out of the Google API error envelope `{error:{message,status,code}}`. */
function googleErrorDetail(payloadText: string): { message?: string; status?: string } {
  const trimmed = payloadText.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return { message: trimmed || undefined };
  }
  const parsed = parseUpstreamJsonPayload(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const err = (parsed as { error?: { message?: unknown; status?: unknown } }).error;
  return {
    message: safeUpstreamErrorString(err?.message),
    status: safeUpstreamErrorString(err?.status),
  };
}



const GOOGLE_QUOTA_EXHAUSTED_NEEDLES = [
  "quotafailure",
  "quota exceeded",
  "exceeded your current quota",
  "billing",
  "individual quota reached",
  "quota reached",
  "enable overages",
  "exhausted your capacity",
  "daily limit reached",
  "weekly limit reached",
];

// Per-minute / per-second / concurrency limits are transient rate limits: they should be
// retried, not treated as hard quota exhaustion. These guards run before the needles so a
// message like "Per-minute quota exceeded" stays in the retryable bucket.
const GOOGLE_TRANSIENT_RATE_LIMIT_PATTERNS = [
  "per minute",
  "per-minute",
  "per min",
  "rpm",
  "requests per minute",
  "too many requests",
  "rate limit",
  "retry after",
  // Upstream writes the header name both ways in prose ("retry-after: 60"); matching only the
  // spaced spelling let a transient 429 fall through to the exhaustion needles below.
  "retry-after",
  "concurrent request limit",
];

/** Whether the text names a transient rate limit rather than hard quota exhaustion. */
export function isGoogleTransientRateLimitText(text: string): boolean {
  const lower = text.toLowerCase();
  return GOOGLE_TRANSIENT_RATE_LIMIT_PATTERNS.some(needle => lower.includes(needle));
}

export function isGoogleQuotaExhaustedText(text: string): boolean {
  const lower = text.toLowerCase();
  if (GOOGLE_TRANSIENT_RATE_LIMIT_PATTERNS.some(needle => lower.includes(needle))) return false;
  return GOOGLE_QUOTA_EXHAUSTED_NEEDLES.some(needle => lower.includes(needle));
}

/**
 * `ErrorInfo.reason` values that make a 429 a rate/quota signal the retry ladder may wait out.
 * Google writes these into `error.details[]`; Cloud Code Assist answers a genuine capacity 429
 * with `reason: "RATE_LIMIT_EXCEEDED"` and answers a request-shape/policy rejection with no
 * `details` at all.
 */
const GOOGLE_RETRYABLE_429_ERROR_REASONS: Record<string, true> = {
  RATE_LIMIT_EXCEEDED: true,
  QUOTA_EXCEEDED: true,
  RATE_LIMIT_EXCEEDED_MODEL: true,
};

/** Narrow a JSON value to a plain object without asserting a shape it may not have. */
function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** ProtoJSON type of a detail whose `reason` field carries an `ErrorInfo` verdict. */
const GOOGLE_ERROR_INFO_TYPE = "google.rpc.ErrorInfo";
/** ProtoJSON type of a detail whose `retryDelay` field states when to retry. */
const GOOGLE_RETRY_INFO_TYPE = "google.rpc.RetryInfo";

/**
 * Whether a detail's declared `@type` admits `expected`.
 *
 * ProtoJSON spells a type either fully qualified (`type.googleapis.com/google.rpc.ErrorInfo`) or as
 * the bare message name; both name the same message, and only the last path segment carries the
 * identity. Suffix matching alone would accept a foreign `type.example.com/relay.google.rpc.ErrorInfo`,
 * so the segment is compared whole. A detail with no `@type` asserts nothing and admits both.
 */
function detailTypeMatches(record: Record<string, unknown>, expected: string): boolean {
  if (!Object.hasOwn(record, "@type")) return true;
  const declared = record["@type"];
  if (typeof declared !== "string") return false;
  const segment = declared.slice(declared.lastIndexOf("/") + 1);
  return segment === expected;
}

/**
 * The `error` envelope of a Google error payload, or `undefined` when the text is not JSON.
 *
 * `error` is normally an object, but both the retry-delay extractor and Google's own fixtures
 * accept the array spelling, so every reader here unwraps `error[0]` the same way rather than
 * disagreeing about which payloads count as evidence.
 */
function googleErrorEnvelope(payloadText: string): Record<string, unknown> | undefined {
  const trimmed = payloadText.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  const parsed = jsonRecord(parseUpstreamJsonPayload(trimmed));
  if (!parsed) return undefined;
  const error = parsed.error;
  if (Array.isArray(error)) return jsonRecord(error[0]) ?? parsed;
  return jsonRecord(error) ?? parsed;
}

/** Every `error.details[].reason` in a Google error envelope, in payload order. */
function googleErrorReasons(payloadText: string): string[] {
  const details = googleErrorEnvelope(payloadText)?.details;
  if (!Array.isArray(details)) return [];
  const reasons: string[] = [];
  for (const detail of details) {
    const record = jsonRecord(detail);
    if (!record) continue;
    // `@type` names which protobuf message owns this object. A detail that declares a different
    // message may carry an unrelated field spelled `reason`, so only an `ErrorInfo` detail (or one
    // with no `@type` to contradict it) speaks for the rate-limit verdict.
    if (!detailTypeMatches(record, GOOGLE_ERROR_INFO_TYPE)) continue;
    const reason = safeUpstreamErrorString(record.reason);
    if (reason) reasons.push(reason);
  }
  return reasons;
}

function isGoogleRetryDuration(value: unknown): boolean {
  return typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*s\s*$/i.test(value);
}

/**
 * Whether a detail states a wait, including an explicit `0s`.
 *
 * `extractGoogleRetryAfterSeconds` drops `0s` because it answers "how long should the caller
 * wait", and a zero there is no instruction. For eligibility the question is different: the
 * provider named a wait at all, which says the refusal is a rate signal rather than a verdict on
 * the request's shape. Local backoff still supplies the actual delay.
 */
function hasGoogleRetryDelayDetail(payloadText: string): boolean {
  const details = googleErrorEnvelope(payloadText)?.details;
  if (!Array.isArray(details)) return false;
  for (const detail of details) {
    const record = jsonRecord(detail);
    if (!record) continue;
    if (detailTypeMatches(record, GOOGLE_RETRY_INFO_TYPE) && isGoogleRetryDuration(record.retryDelay)) return true;
    const metadata = jsonRecord(record.metadata);
    if (detailTypeMatches(record, GOOGLE_ERROR_INFO_TYPE) && isGoogleRetryDuration(metadata?.quotaResetDelay)) return true;
  }
  return false;
}

/**
 * The text a message-level needle may match: the decoded `error.message` and enum status for
 * JSON, the whole payload for non-JSON.
 *
 * Reading the raw JSON would let any string inside it authorize a replay — a `BadRequest` field
 * violation whose description quotes "rate limit" is part of a request-shape verdict, not a rate
 * signal, and matching it re-enables exactly the futile replay this gate exists to stop.
 */
function googleMessageText(payloadText: string): string {
  const trimmed = payloadText.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  const envelope = googleErrorEnvelope(trimmed);
  if (!envelope) return "";
  return [safeUpstreamErrorString(envelope.message), safeUpstreamErrorString(envelope.status)]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

/**
 * Message wording that is evidence for a replay but must not change quota classification.
 *
 * Google's documented 429 for pay-as-you-go capacity is "Resource exhausted. Please try again
 * later." — no header, no details, no rate-limit wording. Treating it as a general transient
 * pattern would also veto hard-quota classification for every body that says it, so it is scoped
 * to the evidence predicate instead.
 */
const GOOGLE_RETRYABLE_429_MESSAGE_NEEDLES = [
  "try again later",
];

/**
 * Whether a 429 says anything a replay can act on.
 *
 * The ladder replays a byte-identical body after 250 ms, doubling to 2 s. That is a sensible
 * probe for a burst limit that clears, and meaningless for a refusal Google already made on the
 * request's shape: the same bytes are refused again. Only evidence in the response separates
 * the two, so this reports whether any exists — a parseable `Retry-After` header, a `RetryInfo.retryDelay`
 * / `quotaResetDelay` detail, a transient-rate-limit phrase, or a structured
 * `ErrorInfo.reason`. A 429 with none of them is reported as-is instead of being replayed.
 *
 * Observed Cloud Code Assist shapes behind this split (same account, minutes apart):
 * - capacity: `RESOURCE_EXHAUSTED` / "You have exhausted your capacity on this model. Resets in
 *   0s." with `details[].reason: "RATE_LIMIT_EXCEEDED"` — already hard-quota classified, and
 *   evidence-bearing if it ever is not;
 * - request-shape rejection: `RESOURCE_EXHAUSTED` / "Resource has been exhausted (e.g. check
 *   quota)." with no `details`, no `Retry-After` — replayed three times per turn, refused three
 *   times per turn.
 */
export function hasGoogle429RetryEvidence(headers: Headers, payloadText: string): boolean {
  if (retryAfterDelayMs(headers) !== undefined) return true;
  if (hasGoogleRetryDelayDetail(payloadText)) return true;
  const messageText = googleMessageText(payloadText).toLowerCase();
  if (isGoogleTransientRateLimitText(messageText)) return true;
  if (GOOGLE_RETRYABLE_429_MESSAGE_NEEDLES.some(needle => messageText.includes(needle))) return true;
  return googleErrorReasons(payloadText).some(reason => GOOGLE_RETRYABLE_429_ERROR_REASONS[reason] === true);
}


function classifyGoogle(label: string, status: number | undefined, enumStatus: string | undefined, text: string, reason?: string): string {
  // Structured reasons outrank prose. Quota exhaustion is the same contract on every Google
  // surface; RATE_LIMIT_EXCEEDED overrides quota-like prose only on Antigravity, as CPA reads it.
  if (reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE") return `${label} quota exhausted`;
  if (reason === "RATE_LIMIT_EXCEEDED" && label === "Antigravity") return `${label} rate limit exceeded`;
  const lower = `${enumStatus ?? ""} ${text}`.toLowerCase();
  const quotaExhausted = isGoogleQuotaExhaustedText(lower);
  if ((!enumStatus || enumStatus === "RESOURCE_EXHAUSTED") && quotaExhausted) return `${label} quota exhausted`;
  if (status === 429 || enumStatus === "RESOURCE_EXHAUSTED" || lower.includes("rate limit")) {
    return `${label} rate limit exceeded`;
  }
  if (status === 401 || enumStatus === "UNAUTHENTICATED" || lower.includes("unauthenticated") || lower.includes("invalid authentication") || lower.includes("expired")) {
    // Keep the enum here too: the access-denial recovery accepts this wording only under it.
    return `${label} authentication failed${enumStatus === "PERMISSION_DENIED" ? GOOGLE_PERMISSION_DENIED_SUFFIX : ""}`;
  }
  // Keep Google's explicit enum in the normalized text. Responses/combo handling receives
  // only this string, so dropping it would let location wording override the authoritative
  // permission reason during downstream classification.
  if (enumStatus === "PERMISSION_DENIED") {
    return `${label} access denied${GOOGLE_PERMISSION_DENIED_SUFFIX}`;
  }
  if (status === 403 || lower.includes("permission_denied") || lower.includes("permission denied") || lower.includes("access denied")) {
    return `${label} access denied`;
  }
  // Google rejects unsupported geographic / datacenter locations with HTTP 400
  // FAILED_PRECONDITION. The payload is not malformed, so it must not fall through to
  // "invalid request" (#3467). Only the observed 400/precondition envelope permits
  // this inference; other explicit enums and server statuses remain authoritative.
  if (status === 400 && (!enumStatus || enumStatus === "FAILED_PRECONDITION") && isLocationUnsupportedMessage(lower)) {
    return `${label} location not supported`;
  }
  if (status === 503 || enumStatus === "UNAVAILABLE" || lower.includes("overloaded") || lower.includes("unavailable")) {
    return `${label} server overloaded`;
  }
  if (status === 400 || status === 404 || enumStatus === "INVALID_ARGUMENT" || enumStatus === "NOT_FOUND" || lower.includes("invalid") || lower.includes("not found") || lower.includes("malformed")) {
    return `${label} invalid request`;
  }
  return `${label} upstream error`;
}

/**
 * Normalize a Google/Vertex/Antigravity HTTP error body into a short, classified, secret-redacted
 * message. Mirrors `kiro-errors.ts`. `label` is the provider-facing prefix ("Vertex AI",
 * "Antigravity").
 */
export function safeGoogleHttpErrorMessage(label: string, status: number, payloadText: string): string {
  // A suspension carries a fixed message: Google's text names an appeal path and the account.
  if (label === "Antigravity" && status === 403 && isAntigravityTosViolationBody(payloadText)) {
    return `${ANTIGRAVITY_TOS_VIOLATION_PREFIX}: ${ANTIGRAVITY_TOS_VIOLATION_MESSAGE}`;
  }
  const { message, status: enumStatus } = googleErrorDetail(payloadText);
  const prefix = label === "Antigravity" && status === 403 && hasAntigravityValidationReason(payloadText)
    ? ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX
    : classifyGoogle(label, status, enumStatus, [message, enumStatus].filter(Boolean).join(" "), googleErrorDetails(payloadText).reason);
  const detail = message ? sanitizeUpstreamErrorText(message).slice(0, 500) : `HTTP ${status}`;
  return `${prefix}: ${detail}`;
}

/** Vertex AI HTTP error message (label = "Vertex AI"). */
export function safeVertexHttpErrorMessage(status: number, payloadText: string): string {
  return safeGoogleHttpErrorMessage("Vertex AI", status, payloadText);
}

/** Antigravity (Cloud Code Assist) HTTP error message (label = "Antigravity"). */
export function safeAntigravityHttpErrorMessage(status: number, payloadText: string): string {
  return safeGoogleHttpErrorMessage("Antigravity", status, payloadText);
}

/** Google-family retryable HTTP set (mirrors Kiro). Quota-exhausted is classified above and not retried. */
export function retryableGoogleStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * True when a 429 body indicates hard quota exhaustion (not a transient rate limit). Quota
 * exhaustion is generally not expected to recover for hours (AIP-194), so it must NOT be retried —
 * unlike a plain rate limit. The HTTP status alone can't distinguish the two, so the retry layer
 * inspects the body with this.
 */
export function isQuotaExhaustedBody(payloadText: string, label?: string): boolean {
  const { reason } = googleErrorDetails(payloadText);
  if (reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE") return true;
  if (reason === "RATE_LIMIT_EXCEEDED" && label === "Antigravity") return false;
  const { message, status } = googleErrorDetail(payloadText);
  if (status && status !== "RESOURCE_EXHAUSTED") return false;
  return isGoogleQuotaExhaustedText(message ?? payloadText);
}

/**
 * A server-stated retry delay in whole seconds, from RetryInfo.retryDelay, ErrorInfo.metadata.
 * quotaResetDelay or a "retry after <duration>" message, in protobuf or Go duration syntax.
 */
export function extractGoogleRetryAfterSeconds(payloadText: string): string | undefined {
  const ms = googleErrorDetails(payloadText).retryDelayMs;
  return ms !== undefined && ms > 0 ? String(Math.ceil(ms / 1000)) : undefined;
}
