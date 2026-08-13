import { createHmac, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "./local-management-attestation";

export const SYSTEM_RESTART_METHOD = "POST";
export const SYSTEM_RESTART_PATH = "/api/system/restart";
export const SYSTEM_RESTART_CAPABILITY_VERSION = "v1";
export const SYSTEM_RESTART_EXPECTED_PID_HEADER = "x-opencodex-restart-expected-pid";
export const SYSTEM_RESTART_NONCE_HEADER = "x-opencodex-restart-nonce";
export const SYSTEM_RESTART_CAPABILITY_HEADER = "x-opencodex-restart-capability";

/** Fixed drain and replacement budgets shared by the server, CLI, and tray. */
export const MEMORY_DRAIN_RESTART_MS = 60_000;
export const REPLACEMENT_READY_TIMEOUT_MS = 70_000;

const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

export type ExpectedSystemRestartPid =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; pid: number };

export function parseExpectedSystemRestartPid(value: string | null): ExpectedSystemRestartPid {
  if (value === null) return { kind: "absent" };
  if (!/^[1-9]\d*$/.test(value)) return { kind: "invalid" };
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? { kind: "present", pid } : { kind: "invalid" };
}

function restartCapabilityPayload(
  nonce: string,
  method: string,
  path: string,
  pid: number,
  port: number,
): string | null {
  if (!BASE64URL_256.test(nonce)) return null;
  if (method !== SYSTEM_RESTART_METHOD || path !== SYSTEM_RESTART_PATH) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `opencodex-system-restart-v1\n${nonce}\n${method}\n${path}\n${pid}\n${port}`;
}

/** Process-scoped, operation-only authorization. It is not a reusable management credential. */
export function createSystemRestartCapability(
  secret: string,
  nonce: string,
  method: string,
  path: string,
  pid: number,
  port: number,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const payload = restartCapabilityPayload(nonce, method, path, pid, port);
  if (!payload) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifySystemRestartCapability(
  secret: string,
  nonce: string | null,
  method: string,
  path: string,
  pid: number,
  port: number,
  capability: string | null,
): boolean {
  if (!nonce || !capability || !BASE64URL_256.test(capability)) return false;
  const expected = createSystemRestartCapability(secret, nonce, method, path, pid, port);
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(capability);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
