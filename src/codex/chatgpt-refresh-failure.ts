/** Closed diagnostic vocabulary; provider descriptions and unknown codes never escape. */
const REFRESH_DIAGNOSTIC_CODES = [
  "invalid_grant", "refresh_token_invalidated", "token_invalidated", "refresh_token_reused",
  "refresh_token_expired", "invalid_client", "invalid_request", "server_error",
  "temporarily_unavailable", "rate_limit_exceeded", "unsupported_grant_type", "invalid_scope",
] as const;
export type ChatgptRefreshDiagnosticCode = typeof REFRESH_DIAGNOSTIC_CODES[number];
export type ChatgptRefreshFailure = {
  reason: "expired" | "revoked" | "unknown";
  code?: ChatgptRefreshDiagnosticCode;
};

/** HTTP availability failures cannot establish that a refresh grant was revoked. */
export function classifyChatgptRefreshFailure(status: number, body: string): ChatgptRefreshFailure {
  if (body.length > 16_384) return { reason: "unknown" };
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return { reason: "unknown" }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { reason: "unknown" };
  const row = payload as Record<string, unknown>;
  let exactCode: string | undefined;
  let description = typeof row.error_description === "string" ? row.error_description : "";
  if (typeof row.error === "string") {
    exactCode = row.error.trim() || undefined;
  } else if (row.error !== undefined) {
    if (!row.error || typeof row.error !== "object" || Array.isArray(row.error)) return { reason: "unknown" };
    const error = row.error as Record<string, unknown>;
    if (error.code !== undefined && typeof error.code !== "string") return { reason: "unknown" };
    exactCode = typeof error.code === "string" ? error.code.trim() || undefined : undefined;
    if (typeof error.message === "string") description = `${error.message} ${description}`;
  }
  const code = (REFRESH_DIAGNOSTIC_CODES as readonly unknown[]).includes(exactCode)
    ? exactCode as ChatgptRefreshDiagnosticCode : undefined;
  let reason: ChatgptRefreshFailure["reason"] = "unknown";
  if (status === 400 || status === 401 || status === 403) {
    if (["invalid_grant", "refresh_token_invalidated", "token_invalidated", "refresh_token_reused"].includes(exactCode ?? "")) {
      reason = "revoked";
    } else if (exactCode === "refresh_token_expired") {
      reason = "expired";
    } else if (status === 400 && exactCode === undefined) {
      // Preserve description-only OAuth 400 compatibility; a named code always wins.
      if (description.includes("invalidated") || description.includes("revoked")) reason = "revoked";
      else if (description.includes("expired")) reason = "expired";
    }
  }
  return { reason, ...(code ? { code } : {}) };
}

/** Endpoint verdict only: no credential identity, body, or arbitrary upstream string. */
export function noteChatgptRefreshFailure(
  kind: "pool" | "native main",
  status: number,
  failure: ChatgptRefreshFailure,
): void {
  console.warn(`[codex] ${kind} refresh: ${failure.reason === "unknown" ? "transient" : "reauth"}`
    + ` status=${status} code=${failure.code ?? "none"}`);
}
