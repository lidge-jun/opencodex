import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "./local-management-attestation";
import { LOCAL_MANAGEMENT_CAPABILITY_TTL_MS } from "./local-management-capability";

export const LOCAL_DESKTOP_SNAPSHOT_PATH = "/api/update/desktop-snapshot";
export const LOCAL_DESKTOP_SNAPSHOT_BODY_HEADER = "x-opencodex-desktop-snapshot-sha256";
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

/** Digest the exact bytes sent on the wire, before JSON parsing or reserialization. */
export function desktopSnapshotBodyDigest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("base64url");
}

/** A separate, body-bound grant for the one bounded desktop display-state POST. */
export function createLocalDesktopSnapshotCapability(
  secret: string,
  nonce: string,
  method: string,
  path: string,
  pid: number,
  port: number,
  expiresAt: number,
  bodyDigest: string,
): string | null {
  if (!isLocalAttestationSecret(secret) || !BASE64URL_256.test(nonce)) return null;
  if (method !== "POST" || path !== LOCAL_DESKTOP_SNAPSHOT_PATH) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  if (!BASE64URL_256.test(bodyDigest)) return null;
  const payload = `opencodex-local-desktop-snapshot-v1\n${nonce}\n${method}\n${path}\n${pid}\n${port}\n${expiresAt}\n${bodyDigest}`;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Verify scope, lifetime and MAC; admission separately consumes the grant once. */
export function verifyLocalDesktopSnapshotCapability(
  secret: string,
  nonce: string | null,
  method: string,
  path: string,
  pid: number,
  port: number,
  expiresAt: number,
  bodyDigest: string | null,
  capability: string | null,
  now = Date.now(),
): boolean {
  if (!nonce || !bodyDigest || !capability || !BASE64URL_256.test(capability)) return false;
  if (!Number.isSafeInteger(now) || expiresAt <= now
    || expiresAt > now + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS) return false;
  const expected = createLocalDesktopSnapshotCapability(
    secret, nonce, method, path, pid, port, expiresAt, bodyDigest,
  );
  if (!expected) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(capability));
}
