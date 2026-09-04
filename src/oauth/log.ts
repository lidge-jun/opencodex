// src/oauth/log.ts
import { maskAccountId } from "../lib/privacy";
import { redactSecretString } from "../lib/redact";

/** Normalize camelCase / snake_case / kebab-case field names before secret checks. */
function normalizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

const FORBIDDEN_NORMALIZED = new Set([
  "access",
  "refresh",
  "authorization",
  "code",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "oauth_code",
  "code_verifier",
  "clientsecret",
  // Device-flow polling handle. Not a token, but it is the bearer of an
  // in-flight authorization and must not be logged.
  "device_auth_id",
]);

function isForbiddenFieldKey(key: string): boolean {
  const normalized = normalizeFieldKey(key);
  if (FORBIDDEN_NORMALIZED.has(normalized)) return true;
  if (normalized.endsWith("_token") || normalized.endsWith("_secret") || normalized.endsWith("_code")) {
    return true;
  }
  return false;
}

export function logOAuthEvent(
  event: string,
  fields: { provider: string; accountId?: string; [key: string]: unknown },
): void {
  const parts = [`[opencodex] ${event}`, `provider=${fields.provider}`];
  if (fields.accountId) parts.push(`account=${maskAccountId(fields.accountId)}`);
  for (const [key, value] of Object.entries(fields)) {
    if (key === "provider" || key === "accountId") continue;
    if (isForbiddenFieldKey(key)) continue;
    if (value === undefined) continue;
    parts.push(`${key}=${String(value)}`);
  }
  console.info(redactSecretString(parts.join(" ")));
}
