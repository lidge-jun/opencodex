/** Diagnostic only: never use this outcome as quota, entitlement, or admission evidence. */
export type CodexQuotaRefreshOutcome =
  | { status: "http_error"; httpStatus: number }
  | { status: "ok" | "not_reported" | "timeout" | "network_error" | "invalid_response" | "internal_error" };

/** The management response is untrusted at the CLI boundary; copy only the fixed vocabulary. */
export function projectCodexQuotaRefreshOutcome(value: unknown): CodexQuotaRefreshOutcome | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.status === "http_error") {
    return typeof row.httpStatus === "number" && Number.isInteger(row.httpStatus)
      && row.httpStatus >= 100 && row.httpStatus <= 599
      ? { status: "http_error", httpStatus: row.httpStatus }
      : undefined;
  }
  switch (row.status) {
    case "ok":
    case "not_reported":
    case "timeout":
    case "network_error":
    case "invalid_response":
    case "internal_error":
      return { status: row.status };
    default:
      return undefined;
  }
}
