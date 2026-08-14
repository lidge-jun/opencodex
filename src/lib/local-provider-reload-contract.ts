import { createHmac, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "./local-management-attestation";

export const LOCAL_PROVIDER_RELOAD_METHOD = "POST";
export const LOCAL_PROVIDER_RELOAD_PATH = "/api/providers/reload";
export const LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION = "v1";
export const LOCAL_PROVIDER_RELOAD_EXPECTED_PID_HEADER = "x-opencodex-provider-reload-expected-pid";
export const LOCAL_PROVIDER_RELOAD_NONCE_HEADER = "x-opencodex-provider-reload-nonce";
export const LOCAL_PROVIDER_RELOAD_EXPIRES_AT_HEADER = "x-opencodex-provider-reload-expires-at";
export const LOCAL_PROVIDER_RELOAD_NAME_HEADER = "x-opencodex-provider-reload-name";
export const LOCAL_PROVIDER_RELOAD_CAPABILITY_HEADER = "x-opencodex-provider-reload-capability";
export const LOCAL_PROVIDER_RELOAD_CAPABILITY_TTL_MS = 10_000;

const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export type ExpectedLocalProviderReloadPid =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; pid: number };

export function parseExpectedLocalProviderReloadPid(value: string | null): ExpectedLocalProviderReloadPid {
  if (value === null) return { kind: "absent" };
  if (!/^[1-9]\d*$/.test(value)) return { kind: "invalid" };
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? { kind: "present", pid } : { kind: "invalid" };
}

export function isLocalProviderReloadName(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_NAME.test(value);
}

function capabilityPayload(
  nonce: string,
  method: string,
  path: string,
  name: string,
  pid: number,
  port: number,
  expiresAt: number,
): string | null {
  if (!BASE64URL_256.test(nonce)) return null;
  if (method !== LOCAL_PROVIDER_RELOAD_METHOD || path !== LOCAL_PROVIDER_RELOAD_PATH) return null;
  if (!isLocalProviderReloadName(name)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return `opencodex-local-provider-reload-v1\n${nonce}\n${method}\n${path}\n${name}\n${pid}\n${port}\n${expiresAt}`;
}

/** Process-scoped authorization to reload one named provider from protected disk state. */
export function createLocalProviderReloadCapability(
  secret: string,
  nonce: string,
  method: string,
  path: string,
  name: string,
  pid: number,
  port: number,
  expiresAt: number,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const payload = capabilityPayload(nonce, method, path, name, pid, port, expiresAt);
  if (!payload) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifyLocalProviderReloadCapability(
  secret: string,
  nonce: string | null,
  method: string,
  path: string,
  name: string | null,
  pid: number,
  port: number,
  expiresAt: number,
  capability: string | null,
  now = Date.now(),
): boolean {
  if (!nonce || !name || !capability || !BASE64URL_256.test(capability)) return false;
  if (
    !Number.isSafeInteger(now)
    || expiresAt <= now
    || expiresAt > now + LOCAL_PROVIDER_RELOAD_CAPABILITY_TTL_MS
  ) return false;
  const expected = createLocalProviderReloadCapability(
    secret,
    nonce,
    method,
    path,
    name,
    pid,
    port,
    expiresAt,
  );
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(capability);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
