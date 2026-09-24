import { createHmac, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "./local-management-attestation";

export const LOCAL_ASIDE_SYNC_METHOD = "POST";
export const LOCAL_ASIDE_SYNC_PATH = "/api/client-integrations/aside/sync";
export const LOCAL_ASIDE_SYNC_CAPABILITY_VERSION = "v1";
export const LOCAL_ASIDE_SYNC_EXPECTED_PID_HEADER = "x-opencodex-aside-sync-expected-pid";
export const LOCAL_ASIDE_SYNC_NONCE_HEADER = "x-opencodex-aside-sync-nonce";
export const LOCAL_ASIDE_SYNC_EXPIRES_AT_HEADER = "x-opencodex-aside-sync-expires-at";
export const LOCAL_ASIDE_SYNC_CAPABILITY_HEADER = "x-opencodex-aside-sync-capability";
export const LOCAL_ASIDE_SYNC_CAPABILITY_TTL_MS = 10_000;

const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

export function parseExpectedLocalAsideSyncPid(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function payload(nonce: string, method: string, path: string, pid: number, port: number, expiresAt: number): string | null {
  if (!BASE64URL_256.test(nonce) || method !== LOCAL_ASIDE_SYNC_METHOD || path !== LOCAL_ASIDE_SYNC_PATH) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return `opencodex-local-aside-sync-v1\n${nonce}\n${method}\n${path}\n${pid}\n${port}\n${expiresAt}`;
}

export function createLocalAsideSyncCapability(secret: string, nonce: string, method: string, path: string, pid: number, port: number, expiresAt: number): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const value = payload(nonce, method, path, pid, port, expiresAt);
  return value ? createHmac("sha256", secret).update(value).digest("base64url") : null;
}

export function verifyLocalAsideSyncCapability(secret: string, nonce: string | null, method: string, path: string, pid: number, port: number, expiresAt: number, capability: string | null, now = Date.now()): boolean {
  if (!nonce || !capability || !BASE64URL_256.test(capability) || expiresAt <= now || expiresAt > now + LOCAL_ASIDE_SYNC_CAPABILITY_TTL_MS) return false;
  const expected = createLocalAsideSyncCapability(secret, nonce, method, path, pid, port, expiresAt);
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(capability);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
