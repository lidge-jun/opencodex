/** Diagnostic only: never use this outcome as quota, entitlement, or admission evidence. */
export type CodexQuotaRefreshOutcome =
  /** `code` is set only for a provider code that requires a new sign-in (fixed vocabulary). */
  | { status: "http_error"; httpStatus: number; code?: CodexTerminalAuthCode }
  | { status: "ok" | "not_reported" | "timeout" | "network_error" | "invalid_response" | "internal_error" };

/** Provider auth codes that only a new sign-in can recover. */
export const CODEX_TERMINAL_AUTH_CODES = [
  "invalid_workspace_selected",
  "invalid_refresh_token",
  // ChatGPT revokes every session of an account whose plan changes (for example Pro to Free),
  // while the access token's `exp` still lies in the future.
  "token_invalidated",
] as const;
export type CodexTerminalAuthCode = typeof CODEX_TERMINAL_AUTH_CODES[number];
export function isCodexTerminalAuthCode(code: unknown): code is CodexTerminalAuthCode {
  return (CODEX_TERMINAL_AUTH_CODES as readonly unknown[]).includes(code);
}

/** The management response is untrusted at the CLI boundary; copy only the fixed vocabulary. */
export function projectCodexQuotaRefreshOutcome(value: unknown): CodexQuotaRefreshOutcome | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.status === "http_error") {
    return typeof row.httpStatus === "number" && Number.isInteger(row.httpStatus)
      && row.httpStatus >= 100 && row.httpStatus <= 599
      ? { status: "http_error", httpStatus: row.httpStatus,
        ...(isCodexTerminalAuthCode(row.code) ? { code: row.code } : {}) }
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
