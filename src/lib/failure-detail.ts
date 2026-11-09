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

/** Closed provider error classes a provider_error detail may name (the Anthropic error envelope types). */
export const FAILURE_DETAIL_PROVIDER_TYPES = [
  "invalid_request_error", "authentication_error", "permission_error", "not_found_error",
  "rate_limit_error", "api_error", "overloaded_error", "request_too_large",
] as const;

export type FailureDetailProviderType = typeof FAILURE_DETAIL_PROVIDER_TYPES[number];

export interface FailureDetail {
  code: FailureDetailCode;
  /** Milliseconds for timeouts and stalls, bytes for an overflow. */
  value?: number;
  type?: FailureDetailProviderType;
  validation?: ValidationIssue[];
}

const CODES: ReadonlySet<string> = new Set(FAILURE_DETAIL_CODES);
const TYPES: ReadonlySet<string> = new Set(FAILURE_DETAIL_PROVIDER_TYPES);
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
  const validation = code === "provider_error" ? boundedValidationIssues(record.validation) : undefined;
  const keys = Object.keys(record);
  const exact = keys.every(key => key === "code" || (key === "value" && valid) || (key === "type" && type !== undefined) || (key === "validation" && validation !== undefined && validation === record.validation));
  if (exact) return record as unknown as FailureDetail;
  return { code, ...(valid ? { value: number as number } : {}), ...(type ? { type } : {}), ...(validation ? { validation } : {}) };
}
