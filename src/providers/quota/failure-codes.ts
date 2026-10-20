import type { QuotaFailureCode } from "../quota-types";

/**
 * Closed quota-probe diagnoses derived from an HTTP status class or a thrown dispatch. They carry
 * no upstream text, URL, header or credential: only one of `QUOTA_FAILURE_CODES`.
 */
export function httpQuotaFailure(status: number): QuotaFailureCode {
  if (status >= 300 && status < 400) return "redirect_blocked";
  if (status === 401 || status === 403) return "access_denied";
  if (status === 429) return "rate_limited";
  return "upstream_error";
}

/** A thrown fetch: the request deadline is a timeout, anything else a transport failure. */
export function thrownQuotaFailure(error: unknown): QuotaFailureCode {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" ? "timeout" : "transport_error";
}
