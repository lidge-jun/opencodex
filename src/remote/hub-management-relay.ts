import { createHash, createHmac } from "node:crypto";

export const HUB_RELAY_READ_PREFIX = "/api/hub-relay/read";
export const HUB_RELAY_CREDENTIAL_PATH = "/api/hub-relay/credential";
export const HUB_RELAY_ENROLLMENT_ID_HEADER = "x-opencodex-hub-enrollment-id";
export const HUB_RELAY_ENROLLMENT_PROOF_HEADER = "x-opencodex-hub-enrollment-proof";
export const HUB_RELAY_PROOF_TIME_HEADER = "x-opencodex-hub-proof-time";
export const HUB_RELAY_REVOCATION_HEADER = "x-opencodex-hub-relay-revoke";
export const HUB_RELAY_TOKEN_PREFIX = "ocx_hub_relay_";

const READ_QUERIES = new Map<string, readonly string[]>([
  ["/api/codex-auth/accounts", []],
  ["/api/codex-auth/active", []],
  ["/api/oauth/providers", []],
  ["/api/oauth/accounts", ["provider"]],
  ["/api/providers/keys", ["name"]], // Hub dispatch exposes positional status rows.
  ["/api/provider-quotas", []],
  ["/api/quota-pool", ["refresh"]], // The quota-pool contract ignores refresh.
  ["/api/usage", ["range", "surface", "provider", "model", "since", "until"]],
]);

/** Keep path spelling exact, before any URL normalization or decoding. */
export function hubRelayRequestTarget(req: Request): string {
  return /^https?:\/\/[^/?#]+(\/[^#]*)$/i.exec(req.url)?.[1] ?? "";
}

export function hubRelayReadAllowed(method: string, target: string): boolean {
  if ((method !== "GET" && method !== "HEAD") || /[\s\\#]/.test(target)) return false;
  const queryIndex = target.indexOf("?");
  const path = queryIndex < 0 ? target : target.slice(0, queryIndex);
  const keys = READ_QUERIES.get(path);
  if (!keys) return false;
  const query = new URLSearchParams(queryIndex < 0 ? "" : target.slice(queryIndex + 1));
  if (path === "/api/oauth/accounts" && !query.get("provider")?.trim()) return false;
  if (path === "/api/providers/keys" && !query.get("name")?.trim()) return false;
  const seen = new Set<string>();
  for (const [key] of query) {
    if (!keys.includes(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export function hubRelayBootstrapAllowed(method: string, target: string): boolean {
  return target === "/opencodex-session" && (method === "GET" || method === "POST");
}

export function hubRelayLogoutAllowed(method: string, target: string): boolean {
  return method === "POST" && target === "/api/session/logout";
}

export function hubRelayReadTarget(req: Request): string | null {
  const raw = hubRelayRequestTarget(req);
  if (req.headers.has("upgrade") || !raw.startsWith(HUB_RELAY_READ_PREFIX + "/")) return null;
  const target = raw.slice(HUB_RELAY_READ_PREFIX.length);
  return hubRelayReadAllowed(req.method, target) ? target : null;
}

export function isHubRelayToken(token: unknown): token is string {
  return typeof token === "string" && /^ocx_hub_relay_[A-Za-z0-9_-]{43}$/.test(token);
}

export function hubRelayDigest(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

export function hubRelayEnrollmentProof(
  key: string, keyId: string, operation: "issue" | "read" | "revoke", credential = "",
  read?: { at: string; method: string; target: string },
): string {
  return createHmac("sha256", key).update(JSON.stringify([
    "ocx-hub-relay/1", keyId, operation, credential, read?.at, read?.method, read?.target,
  ])).digest("base64url");
}
