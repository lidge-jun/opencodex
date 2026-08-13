import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "../codex/account-id";
import { isCodexResetCreditOperationId } from "../codex/reset-credit-recovery";
import { isLocalAttestationSecret } from "./local-management-attestation";

export const CODEX_RESET_CREDIT_CONSENT_METHOD = "POST";
export const CODEX_RESET_CREDIT_CONSENT_PATH = "/api/codex-auth/reset-credits/consume";
export const CODEX_RESET_CREDIT_CONSENT_CAPABILITY_VERSION = "v1";
export const CODEX_RESET_CREDIT_CONSENT_EXPECTED_PID_HEADER =
  "x-opencodex-reset-credit-expected-pid";
export const CODEX_RESET_CREDIT_CONSENT_NONCE_HEADER =
  "x-opencodex-reset-credit-nonce";
export const CODEX_RESET_CREDIT_CONSENT_EXPIRES_AT_HEADER =
  "x-opencodex-reset-credit-expires-at";
export const CODEX_RESET_CREDIT_CONSENT_ACCOUNT_ID_HEADER =
  "x-opencodex-reset-credit-account-id";
export const CODEX_RESET_CREDIT_CONSENT_OPERATION_ID_HEADER =
  "x-opencodex-reset-credit-operation-id";
export const CODEX_RESET_CREDIT_CONSENT_CAPABILITY_HEADER =
  "x-opencodex-reset-credit-capability";
export const CODEX_RESET_CREDIT_CONSENT_CAPABILITY_TTL_MS = 10_000;

const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

export type ExpectedCodexResetCreditConsentPid =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; pid: number };

export function parseExpectedCodexResetCreditConsentPid(
  value: string | null,
): ExpectedCodexResetCreditConsentPid {
  if (value === null) return { kind: "absent" };
  if (!/^[1-9]\d*$/.test(value)) return { kind: "invalid" };
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? { kind: "present", pid } : { kind: "invalid" };
}

export function isCodexResetCreditConsentAccountId(value: unknown): value is string {
  return value === MAIN_CODEX_ACCOUNT_ID || isValidCodexAccountId(value);
}

function capabilityPayload(
  nonce: string,
  method: string,
  path: string,
  accountId: string,
  operationId: string,
  pid: number,
  port: number,
  expiresAt: number,
): string | null {
  if (!BASE64URL_256.test(nonce)) return null;
  if (method !== CODEX_RESET_CREDIT_CONSENT_METHOD || path !== CODEX_RESET_CREDIT_CONSENT_PATH) {
    return null;
  }
  if (!isCodexResetCreditConsentAccountId(accountId)) return null;
  if (!isCodexResetCreditOperationId(operationId)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return [
    "opencodex-codex-reset-credit-consent-v1",
    nonce,
    method,
    path,
    accountId,
    operationId,
    String(pid),
    String(port),
    String(expiresAt),
  ].join("\n");
}

/** One-shot authorization for a user-confirmed reset-credit redemption. */
export function createCodexResetCreditConsentCapability(
  secret: string,
  nonce: string,
  method: string,
  path: string,
  accountId: string,
  operationId: string,
  pid: number,
  port: number,
  expiresAt: number,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const payload = capabilityPayload(
    nonce,
    method,
    path,
    accountId,
    operationId,
    pid,
    port,
    expiresAt,
  );
  if (!payload) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifyCodexResetCreditConsentCapability(
  secret: string,
  nonce: string | null,
  method: string,
  path: string,
  accountId: string | null,
  operationId: string | null,
  pid: number,
  port: number,
  expiresAt: number,
  capability: string | null,
  now = Date.now(),
): boolean {
  if (!nonce || !accountId || !operationId || !capability || !BASE64URL_256.test(capability)) {
    return false;
  }
  if (
    !Number.isSafeInteger(now)
    || expiresAt <= now
    || expiresAt > now + CODEX_RESET_CREDIT_CONSENT_CAPABILITY_TTL_MS
  ) return false;
  const expected = createCodexResetCreditConsentCapability(
    secret,
    nonce,
    method,
    path,
    accountId,
    operationId,
    pid,
    port,
    expiresAt,
  );
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(capability);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
