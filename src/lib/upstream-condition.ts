/**
 * Presentation-only classification of an upstream failure into a small closed set of conditions.
 *
 * The output is what request logs and client-facing error text may name. It never carries input
 * bytes: callers pass bounded structured tokens (status, type, code, reason) and optionally the
 * upstream message, which is read here only through fixed lowercase keyword sets and never stored
 * or returned. Routing, retry and recovery keep using their own classifiers (src/lib/errors.ts);
 * this module must not feed them.
 */

import { isDefiniteContextOverflow } from "./context-overflow-verdict";

export const UPSTREAM_CONDITIONS = [
  "auth_failed",
  "access_denied",
  "context_overflow",
  "location_unsupported",
  "account_verification_required",
  "billing_exhausted",
  "model_unavailable",
  "rate_limited",
  "upstream_unavailable",
  "upstream_failed",
  "request_rejected",
] as const;

export type UpstreamCondition = typeof UPSTREAM_CONDITIONS[number];

const CONDITION_SET: ReadonlySet<string> = new Set(UPSTREAM_CONDITIONS);

export function isUpstreamCondition(value: unknown): value is UpstreamCondition {
  return typeof value === "string" && CONDITION_SET.has(value);
}

export interface UpstreamConditionEvidence {
  status: number;
  type?: string;
  code?: string;
  reason?: string;
  message?: string;
}

// Structured tokens are compared after lowercasing; anything longer than this is not a token.
const MAX_TOKEN_LENGTH = 128;
// Keyword matching reads at most this much of the message.
const MAX_MESSAGE_SCAN = 4096;

const STRUCTURED: ReadonlyArray<readonly [UpstreamCondition, ReadonlySet<string>]> = [
  ["context_overflow", new Set(["context_length_exceeded", "string_above_max_length", "context_window_exceeded", "prompt_too_long"])],
  ["location_unsupported", new Set(["location_not_supported", "unsupported_country_region_territory", "unsupported_country", "user_location_is_not_supported"])],
  ["account_verification_required", new Set(["validation_required", "verification_required", "organization_verification_required"])],
  ["billing_exhausted", new Set(["insufficient_quota", "billing_hard_limit_reached", "usage_limit_reached", "usage_limit_exceeded", "1308", "monthly_request_count", "overage_request_limit_exceeded", "payment_required", "insufficient_balance", "credit_balance_too_low"])],
  ["model_unavailable", new Set(["model_not_found", "unsupported_model", "model_not_available", "model_not_supported", "deployment_not_found"])],
  ["rate_limited", new Set(["rate_limit_exceeded", "rate_limit_error", "too_many_requests", "throttling", "throttled", "rate_limited"])],
  ["upstream_unavailable", new Set(["server_is_overloaded", "overloaded_error", "service_unavailable", "unavailable"])],
];

// Context overflow from message text uses the same verdict the combo router trusts, so a validation
// error that merely quotes "prompt is too long" (an invalid tool name, for example) is not an overflow.
const KEYWORDS: Readonly<Record<"location_unsupported" | "account_verification_required" | "billing_exhausted" | "model_unavailable" | "rate_limited", readonly string[]>> = {
  location_unsupported: ["location is not supported", "unsupported location", "not supported in your region", "region is not supported", "country, region, or territory", "not available in your country", "not available in your region"],
  account_verification_required: ["verify your organization", "organization must be verified", "verification required", "verify your account", "account verification"],
  billing_exhausted: ["insufficient quota", "quota exceeded", "quota exhausted", "exceeded your current quota", "run out of credits", "out of credits", "insufficient credits", "credit balance", "insufficient balance", "billing", "payment required"],
  model_unavailable: ["model not found", "model does not exist", "unsupported model", "not allowed to use this model", "does not have access to model", "model is not available", "no such model"],
  rate_limited: ["rate limit", "too many requests", "throttl"],
};

function token(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_TOKEN_LENGTH ? trimmed.toLowerCase() : undefined;
}

function structuredCondition(tokens: readonly string[]): UpstreamCondition | undefined {
  for (const [condition, set] of STRUCTURED) {
    if (tokens.some(value => set.has(value))) return condition;
  }
  return undefined;
}

function mentions(message: string, condition: keyof typeof KEYWORDS): boolean {
  return KEYWORDS[condition].some(keyword => message.includes(keyword));
}

function statusFallback(status: number): UpstreamCondition | undefined {
  if (status === 401) return "auth_failed";
  if (status === 403) return "access_denied";
  if (status === 402) return "billing_exhausted";
  if (status === 404) return "model_unavailable";
  if (status === 429) return "rate_limited";
  if (status === 503 || status === 529) return "upstream_unavailable";
  if (status >= 500) return "upstream_failed";
  if (status >= 400) return "request_rejected";
  return undefined;
}

/**
 * Precedence: 401 is authoritative; structured tokens next; keyword evidence only for 4xx
 * statuses (a 5xx stays a server failure whatever its text says); a bare status last.
 */
export function classifyUpstreamCondition(evidence: UpstreamConditionEvidence): UpstreamCondition | undefined {
  const { status } = evidence;
  if (!Number.isInteger(status)) return undefined;
  if (status === 401) return "auth_failed";
  const tokens = [token(evidence.code), token(evidence.type), token(evidence.reason)].filter((value): value is string => value !== undefined);
  const structured = structuredCondition(tokens);
  if (structured) return structured;
  const message = typeof evidence.message === "string" ? evidence.message.slice(0, MAX_MESSAGE_SCAN).toLowerCase() : "";
  if (message && status >= 400 && status < 500) {
    if (isDefiniteContextOverflow(status, evidence.message!.slice(0, MAX_MESSAGE_SCAN))) return "context_overflow";
    if (mentions(message, "location_unsupported")) return "location_unsupported";
    if (mentions(message, "account_verification_required")) return "account_verification_required";
    // A 429 that names a rate limit is a rate limit even when it also mentions quota.
    if (status === 429 && mentions(message, "rate_limited")) return "rate_limited";
    if (mentions(message, "billing_exhausted")) return "billing_exhausted";
    if (mentions(message, "model_unavailable")) return "model_unavailable";
    if (mentions(message, "rate_limited")) return "rate_limited";
  }
  return statusFallback(status);
}

const MESSAGES: Readonly<Record<UpstreamCondition, string>> = {
  auth_failed: "The provider rejected the configured credentials.",
  access_denied: "The provider denied access to this request.",
  context_overflow: "The request exceeds the model's context window.",
  location_unsupported: "The provider does not serve this request from the current location.",
  account_verification_required: "The provider requires account verification before serving this model.",
  billing_exhausted: "The provider account has no remaining quota or credits.",
  model_unavailable: "The requested model is not available from the provider.",
  rate_limited: "The provider rate limit was reached; retry later.",
  upstream_unavailable: "The provider is temporarily unavailable; retry later.",
  upstream_failed: "The provider failed to complete the request.",
  request_rejected: "The provider rejected the request.",
};

const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Proxy-written text for a condition; the provider id comes from configuration, never from an error. */
export function upstreamConditionMessage(condition: UpstreamCondition, providerId?: string): string {
  const base = MESSAGES[condition];
  return providerId !== undefined && PROVIDER_ID.test(providerId) ? `${base} (provider: ${providerId})` : base;
}
