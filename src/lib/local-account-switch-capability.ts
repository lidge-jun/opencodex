import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "./local-management-attestation";
import { LOCAL_MANAGEMENT_CAPABILITY_TTL_MS } from "./local-management-capability";

export const LOCAL_ACCOUNT_SWITCH_PATHS = [
  "/api/codex-auth/active",
  "/api/oauth/accounts/active",
  "/api/providers/keys/active",
] as const;
export const LOCAL_ACCOUNT_SWITCH_BODY_HEADER = "x-opencodex-account-switch-sha256";
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

export function isLocalAccountSwitchPath(path: string): boolean {
  return LOCAL_ACCOUNT_SWITCH_PATHS.some(candidate => candidate === path);
}

/** Digest the exact bytes on the wire, before parsing or reserialization. */
export function accountSwitchBodyDigest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("base64url");
}

export function createLocalAccountSwitchCapability(
  secret: string, nonce: string, method: string, path: string,
  pid: number, port: number, expiresAt: number, bodyDigest: string,
): string | null {
  if (!isLocalAttestationSecret(secret) || !BASE64URL_256.test(nonce)) return null;
  if (method !== "PUT" || !isLocalAccountSwitchPath(path)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  if (!BASE64URL_256.test(bodyDigest)) return null;
  const payload = `opencodex-local-account-switch-v1\n${nonce}\n${method}\n${path}\n${pid}\n${port}\n${expiresAt}\n${bodyDigest}`;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifyLocalAccountSwitchCapability(
  secret: string, nonce: string | null, method: string, path: string,
  pid: number, port: number, expiresAt: number, bodyDigest: string | null,
  capability: string | null, now = Date.now(),
): boolean {
  if (!nonce || !bodyDigest || !capability || !BASE64URL_256.test(capability)) return false;
  if (!Number.isSafeInteger(now) || expiresAt <= now
    || expiresAt > now + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS) return false;
  const expected = createLocalAccountSwitchCapability(
    secret, nonce, method, path, pid, port, expiresAt, bodyDigest,
  );
  return expected !== null && timingSafeEqual(Buffer.from(expected), Buffer.from(capability));
}
