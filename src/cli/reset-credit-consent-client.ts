import { readRuntimePort, type RuntimePortState } from "../config";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationChallenge,
  verifyLocalAttestationProof,
} from "../lib/local-management-attestation";
import {
  CODEX_RESET_CREDIT_CONSENT_ACCOUNT_ID_HEADER,
  CODEX_RESET_CREDIT_CONSENT_CAPABILITY_HEADER,
  CODEX_RESET_CREDIT_CONSENT_CAPABILITY_TTL_MS,
  CODEX_RESET_CREDIT_CONSENT_CAPABILITY_VERSION,
  CODEX_RESET_CREDIT_CONSENT_EXPECTED_PID_HEADER,
  CODEX_RESET_CREDIT_CONSENT_EXPIRES_AT_HEADER,
  CODEX_RESET_CREDIT_CONSENT_METHOD,
  CODEX_RESET_CREDIT_CONSENT_NONCE_HEADER,
  CODEX_RESET_CREDIT_CONSENT_OPERATION_ID_HEADER,
  CODEX_RESET_CREDIT_CONSENT_PATH,
  createCodexResetCreditConsentCapability,
  isCodexResetCreditConsentAccountId,
} from "../lib/codex-reset-credit-consent-contract";
import { directLocalHttpFetch } from "../server/direct-local-http";
import {
  findLiveProxy,
  isOpencodexHealthz,
  probeHostname,
  type HealthzIdentity,
  type LiveProxy,
} from "../server/proxy-liveness";
import { isCodexResetCreditOperationId } from "../codex/reset-credit-recovery";

export type ResetCreditConsentResult =
  | { kind: "response"; response: Response }
  | {
    kind: "unavailable";
    reason:
      | "invalid-identity"
      | "unattested-target"
      | "runtime-mismatch"
      | "attestation"
      | "capability"
      | "transport";
  };

export interface ResetCreditConsentDeps {
  findLive?: typeof findLiveProxy;
  fetchImpl?: typeof fetch;
  readRuntime?: (pid: number) => RuntimePortState | null;
  createNonce?: () => string;
  now?: () => number;
  timeoutMs?: number;
}

const RESET_CREDIT_CONSENT_TIMEOUT_MS = 10_000;

function sameRuntime(left: RuntimePortState, right: RuntimePortState | null): boolean {
  return !!right
    && right.pid === left.pid
    && right.port === left.port
    && right.hostname === left.hostname
    && right.attestationSecret === left.attestationSecret;
}

/**
 * Send one user-confirmed redemption to the exact attested local proxy.
 *
 * The request carries no reusable management credential. Its body is empty; the
 * account and idempotency identities are bound into a short-lived, one-shot HMAC.
 */
export async function requestBoundCodexResetCreditConsent(
  accountId: string,
  operationId: string,
  deps: ResetCreditConsentDeps = {},
): Promise<ResetCreditConsentResult> {
  if (
    !isCodexResetCreditConsentAccountId(accountId)
    || !isCodexResetCreditOperationId(operationId)
  ) return { kind: "unavailable", reason: "invalid-identity" };

  let target: LiveProxy | null;
  try {
    target = await (deps.findLive ?? findLiveProxy)();
  } catch {
    return { kind: "unavailable", reason: "transport" };
  }
  if (target?.source !== "runtime" || target.pid === null || target.pid <= 0) {
    return { kind: "unavailable", reason: "unattested-target" };
  }
  const readRuntime = deps.readRuntime ?? readRuntimePort;
  const runtime = readRuntime(target.pid);
  if (
    !runtime?.attestationSecret
    || runtime.pid !== target.pid
    || runtime.port !== target.port
    || runtime.hostname !== target.hostname
  ) return { kind: "unavailable", reason: "runtime-mismatch" };

  const fetchImpl = deps.fetchImpl ?? directLocalHttpFetch;
  const timeoutMs = deps.timeoutMs ?? RESET_CREDIT_CONSENT_TIMEOUT_MS;
  const nonce = (deps.createNonce ?? createLocalAttestationChallenge)();
  const baseUrl = `http://${probeHostname(target.hostname)}:${target.port}`;
  let proofResponse: Response;
  try {
    proofResponse = await fetchImpl(`${baseUrl}/healthz`, {
      headers: { [LOCAL_ATTESTATION_CHALLENGE_HEADER]: nonce },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "unavailable", reason: "transport" };
  }
  const health = await proofResponse.json().catch(() => null) as HealthzIdentity | null;
  if (
    !proofResponse.ok
    || !isOpencodexHealthz(health)
    || health?.pid !== target.pid
    || health?.port !== target.port
    || health?.resetCreditConsentCapability !== CODEX_RESET_CREDIT_CONSENT_CAPABILITY_VERSION
    || !verifyLocalAttestationProof(
      runtime.attestationSecret,
      nonce,
      target.pid,
      target.port,
      proofResponse.headers.get(LOCAL_ATTESTATION_PROOF_HEADER),
    )
  ) return { kind: "unavailable", reason: "attestation" };

  if (!sameRuntime(runtime, readRuntime(target.pid))) {
    return { kind: "unavailable", reason: "runtime-mismatch" };
  }

  const expiresAt = (deps.now ?? Date.now)() + CODEX_RESET_CREDIT_CONSENT_CAPABILITY_TTL_MS;
  const capability = createCodexResetCreditConsentCapability(
    runtime.attestationSecret,
    nonce,
    CODEX_RESET_CREDIT_CONSENT_METHOD,
    CODEX_RESET_CREDIT_CONSENT_PATH,
    accountId,
    operationId,
    target.pid,
    target.port,
    expiresAt,
  );
  if (!capability) return { kind: "unavailable", reason: "capability" };

  try {
    const response = await fetchImpl(`${baseUrl}${CODEX_RESET_CREDIT_CONSENT_PATH}`, {
      method: CODEX_RESET_CREDIT_CONSENT_METHOD,
      headers: {
        [CODEX_RESET_CREDIT_CONSENT_EXPECTED_PID_HEADER]: String(target.pid),
        [CODEX_RESET_CREDIT_CONSENT_NONCE_HEADER]: nonce,
        [CODEX_RESET_CREDIT_CONSENT_EXPIRES_AT_HEADER]: String(expiresAt),
        [CODEX_RESET_CREDIT_CONSENT_ACCOUNT_ID_HEADER]: accountId,
        [CODEX_RESET_CREDIT_CONSENT_OPERATION_ID_HEADER]: operationId,
        [CODEX_RESET_CREDIT_CONSENT_CAPABILITY_HEADER]: capability,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { kind: "response", response };
  } catch {
    return { kind: "unavailable", reason: "transport" };
  }
}
