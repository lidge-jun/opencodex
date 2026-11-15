import { boundedValidationIssues, type ValidationIssue } from "./upstream-validation-detail";
/**
 * Failure detail a request-log row may carry: a closed code plus bounded numeric or closed parameters.
 * The dashboard renders each code as localized text; rows never hold free-form failure text.
 */
export const FAILURE_DETAIL_CODES = [
  "provider_error",
  "header_timeout",
  "connect_timeout",
  "connect_failed",
  "client_closed",
  "body_stall",
  "body_overflow",
  "stream_error_stop",
  "stream_ended_early",
  "stream_failed",
  "output_limit",
  "stall_timeout",
  "adapter_eof",
  "generation_timeout",
  "turn_inactivity",
] as const;

export type FailureDetailCode = typeof FAILURE_DETAIL_CODES[number];

/**
 * Closed provider error classes a provider_error detail may name: the Anthropic error envelope types
 * and the canonical Google RPC status names (google.rpc.Code) that Gemini, Vertex and Antigravity put in
 * `error.status`. Both are published vocabularies, so naming one discloses nothing the provider wrote.
 */
export const FAILURE_DETAIL_PROVIDER_TYPES = [
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
  "rate_limit_error", "api_error", "overloaded_error", "request_too_large",
  "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND", "ALREADY_EXISTS",
  "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE",
  "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED",
] as const;

export type FailureDetailProviderType = typeof FAILURE_DETAIL_PROVIDER_TYPES[number];

/** Gemini/Vertex candidate finishReason values (the published FinishReason enum) a provider_error may name. */
export const FAILURE_DETAIL_FINISH_REASONS = [
  "FINISH_REASON_UNSPECIFIED", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "LANGUAGE", "OTHER", "BLOCKLIST",
  "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION", "IMAGE_OTHER", "NO_IMAGE", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS",
] as const;

export type FailureDetailFinishReason = typeof FAILURE_DETAIL_FINISH_REASONS[number];

export interface FailureDetail {
  code: FailureDetailCode;
  /** Milliseconds for timeouts and stalls, bytes for an overflow. */
  value?: number;
  type?: FailureDetailProviderType;
  /** The provider's own closed finish reason for the turn that failed; provider_error only. */
  finishReason?: FailureDetailFinishReason;
  validation?: ValidationIssue[];
}

const CODES: ReadonlySet<string> = new Set(FAILURE_DETAIL_CODES);
const TYPES: ReadonlySet<string> = new Set(FAILURE_DETAIL_PROVIDER_TYPES);
const FINISH_REASONS: ReadonlySet<string> = new Set(FAILURE_DETAIL_FINISH_REASONS);
const MAX_VALUE = 1e12;

/** Codes whose value parameter carries meaning; the value is dropped for any other code. */
const VALUED: ReadonlySet<FailureDetailCode> = new Set([
  "header_timeout", "connect_timeout", "body_stall", "body_overflow", "generation_timeout", "turn_inactivity",
]);

/**
 * The detail when it is a closed code with valid parameters, else undefined. Free text (a legacy or
 * edited row) is never accepted. Returns the same object when it is already exactly valid.
 */
export function boundedFailureDetail(value: unknown): FailureDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !CODES.has(record.code)) return undefined;
  const code = record.code as FailureDetailCode;
  const number = record.value;
  const valid = typeof number === "number" && Number.isSafeInteger(number) && number >= 0 && number <= MAX_VALUE && VALUED.has(code);
  const type = code === "provider_error" && typeof record.type === "string" && TYPES.has(record.type)
    ? record.type as FailureDetailProviderType : undefined;
  const finishReason = code === "provider_error" && typeof record.finishReason === "string" && FINISH_REASONS.has(record.finishReason)
    ? record.finishReason as FailureDetailFinishReason : undefined;
  const validation = code === "provider_error" ? boundedValidationIssues(record.validation) : undefined;
  const keys = Object.keys(record);
  const exact = keys.every(key => key === "code" || (key === "value" && valid) || (key === "type" && type !== undefined)
    || (key === "finishReason" && finishReason !== undefined)
    || (key === "validation" && validation !== undefined && validation === record.validation));
  if (exact) return record as unknown as FailureDetail;
  return {
    code, ...(valid ? { value: number as number } : {}), ...(type ? { type } : {}),
    ...(finishReason ? { finishReason } : {}), ...(validation ? { validation } : {}),
  };
}

/** The closed facts an adapter can state about a provider failure it parsed off the wire. */
export interface ProviderFailureFacts {
  type?: FailureDetailProviderType;
  finishReason?: FailureDetailFinishReason;
}

// Keyed by the adapter event object, so the facts can never be serialized with it; an event a guard
// rebuilds simply carries none.
const providerFailureFacts = new WeakMap<object, ProviderFailureFacts>();

/**
 * Attach the closed provider facts to an adapter error event. Values outside the closed sets are
 * dropped here, so an adapter can pass what the provider sent without checking it first.
 */
export function withProviderFailureFacts<T extends object>(event: T, facts: { type?: unknown; finishReason?: unknown }): T {
  const type = typeof facts.type === "string" && TYPES.has(facts.type) ? facts.type as FailureDetailProviderType : undefined;
  const finishReason = typeof facts.finishReason === "string" && FINISH_REASONS.has(facts.finishReason)
    ? facts.finishReason as FailureDetailFinishReason : undefined;
  if (type || finishReason) providerFailureFacts.set(event, { ...(type ? { type } : {}), ...(finishReason ? { finishReason } : {}) });
  return event;
}

export function providerFailureDetailOf(event: object): ProviderFailureFacts | undefined {
  return providerFailureFacts.get(event);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The closed provider error class a parsed upstream error body names: the envelope `error.type`, Google's
 * `error.status` (also as the first element of a streamed JSON array), or a top-level `type`.
 */
export function providerErrorTypeOf(payload: unknown): FailureDetailProviderType | undefined {
  const record = Array.isArray(payload) ? payload[0] : payload;
  if (!isObject(record)) return undefined;
  const nested = isObject(record.error) ? record.error : undefined;
  for (const value of [nested?.type, nested?.status, record.type]) {
    if (typeof value === "string" && TYPES.has(value)) return value as FailureDetailProviderType;
  }
  return undefined;
}
