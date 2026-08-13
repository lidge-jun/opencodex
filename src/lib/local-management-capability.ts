import { createHmac, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "./local-management-attestation";

export const LOCAL_MANAGEMENT_EXPECTED_PID_HEADER = "x-opencodex-local-expected-pid";
export const LOCAL_MANAGEMENT_NONCE_HEADER = "x-opencodex-local-nonce";
export const LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER = "x-opencodex-local-expires-at";
export const LOCAL_MANAGEMENT_CAPABILITY_HEADER = "x-opencodex-local-capability";
export const LOCAL_MANAGEMENT_CAPABILITY_TTL_MS = 10_000;

export const LOCAL_MANAGEMENT_READ_PATHS = {
  codexAccounts: "/api/codex-auth/accounts",
  systemMemory: "/api/system/memory",
} as const;

export type LocalManagementReadPath =
  typeof LOCAL_MANAGEMENT_READ_PATHS[keyof typeof LOCAL_MANAGEMENT_READ_PATHS];

const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;
const LOCAL_READ_METHOD = "GET";

export type ExpectedLocalManagementPid =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; pid: number };

export function parseExpectedLocalManagementPid(value: string | null): ExpectedLocalManagementPid {
  if (value === null) return { kind: "absent" };
  if (!/^[1-9]\d*$/.test(value)) return { kind: "invalid" };
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? { kind: "present", pid } : { kind: "invalid" };
}

function isLocalManagementReadPath(path: string): path is LocalManagementReadPath {
  return path === LOCAL_MANAGEMENT_READ_PATHS.codexAccounts
    || path === LOCAL_MANAGEMENT_READ_PATHS.systemMemory;
}

function localReadCapabilityPayload(
  nonce: string,
  method: string,
  path: string,
  pid: number,
  port: number,
  expiresAt: number,
): string | null {
  if (!BASE64URL_256.test(nonce)) return null;
  if (method !== LOCAL_READ_METHOD || !isLocalManagementReadPath(path)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return `opencodex-local-management-read-v1\n${nonce}\n${method}\n${path}\n${pid}\n${port}\n${expiresAt}`;
}

/** Process-scoped authorization for one allowlisted local management GET. */
export function createLocalManagementReadCapability(
  secret: string,
  nonce: string,
  method: string,
  path: string,
  pid: number,
  port: number,
  expiresAt: number,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const payload = localReadCapabilityPayload(nonce, method, path, pid, port, expiresAt);
  if (!payload) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifyLocalManagementReadCapability(
  secret: string,
  nonce: string | null,
  method: string,
  path: string,
  pid: number,
  port: number,
  expiresAt: number,
  capability: string | null,
  now = Date.now(),
): boolean {
  if (!nonce || !capability || !BASE64URL_256.test(capability)) return false;
  if (
    !Number.isSafeInteger(now)
    || expiresAt <= now
    || expiresAt > now + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS
  ) return false;
  const expected = createLocalManagementReadCapability(
    secret,
    nonce,
    method,
    path,
    pid,
    port,
    expiresAt,
  );
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(capability);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
