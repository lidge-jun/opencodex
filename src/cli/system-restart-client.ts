import { readRuntimePort } from "../config/process-state";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationChallenge,
  verifyLocalAttestationProof,
} from "../lib/local-management-attestation";
import {
  SYSTEM_RESTART_CAPABILITY_HEADER,
  SYSTEM_RESTART_CAPABILITY_VERSION,
  SYSTEM_RESTART_EXPECTED_PID_HEADER,
  SYSTEM_RESTART_METHOD,
  SYSTEM_RESTART_NONCE_HEADER,
  SYSTEM_RESTART_PATH,
  createSystemRestartCapability,
} from "../lib/system-restart-contract";
import {
  findLiveProxy,
  isOpencodexHealthz,
  probeHostname,
  type HealthzIdentity,
  type LiveProxy,
} from "../server/proxy-liveness";
import type { ProxyRestartRequestOutcome } from "./tray-proxy";

export const SYSTEM_RESTART_REQUEST_TIMEOUT_MS = 5_000;
export const SYSTEM_RESTART_ATTESTATION_TIMEOUT_MS = 4_000;

export interface BoundSystemRestartDeps {
  fetchImpl?: typeof fetch;
  readRuntime?: typeof readRuntimePort;
  findLive?: typeof findLiveProxy;
  createChallenge?: () => string;
  now?: () => number;
}

function rejected(code: string): ProxyRestartRequestOutcome {
  return { accepted: false, uncertain: false, error: new Error(code) };
}

function uncertain(code: string): ProxyRestartRequestOutcome {
  return { accepted: false, uncertain: true, error: new Error(code) };
}

function remaining(deadlineAt: number, now: () => number, cap: number): number {
  return Math.max(0, Math.min(cap, deadlineAt - now()));
}

function sameRestartTarget(expected: LiveProxy, observed: LiveProxy | null): boolean {
  return expected.pid !== null
    && observed?.source === "runtime"
    && observed.pid === expected.pid
    && observed.port === expected.port;
}

/**
 * Send one restart request to the exact runtime proxy observed by the caller.
 *
 * No reusable admin credential is sent. After the listener proves possession of
 * its per-process runtime secret, the client derives a capability bound to this
 * method, path, PID, and port. The expected PID is repeated so a replacement that
 * wins the port between proof and POST rejects the request.
 */
export async function requestBoundSystemRestart(
  target: LiveProxy,
  deadlineAt: number,
  deps: BoundSystemRestartDeps = {},
): Promise<ProxyRestartRequestOutcome> {
  if (target.source !== "runtime" || target.pid === null) return rejected("restart_target_unattested");

  const now = deps.now ?? Date.now;
  const readRuntime = deps.readRuntime ?? readRuntimePort;
  const runtime = readRuntime(target.pid);
  if (!runtime?.attestationSecret || runtime.pid !== target.pid || runtime.port !== target.port) {
    return rejected("restart_target_runtime_mismatch");
  }

  const attestationBudget = remaining(deadlineAt, now, SYSTEM_RESTART_ATTESTATION_TIMEOUT_MS);
  if (attestationBudget <= 0) return rejected("restart_deadline_expired");

  const fetchImpl = deps.fetchImpl ?? fetch;
  const challenge = (deps.createChallenge ?? createLocalAttestationChallenge)();
  const baseUrl = `http://${probeHostname(target.hostname)}:${target.port}`;
  let proofResponse: Response;
  try {
    proofResponse = await fetchImpl(`${baseUrl}/healthz`, {
      headers: { [LOCAL_ATTESTATION_CHALLENGE_HEADER]: challenge },
      signal: AbortSignal.timeout(attestationBudget),
    });
  } catch {
    return rejected("restart_attestation_unreachable");
  }
  const body = await proofResponse.json().catch(() => null) as HealthzIdentity | null;
  const proof = proofResponse.headers.get(LOCAL_ATTESTATION_PROOF_HEADER);
  if (
    !proofResponse.ok
    || !isOpencodexHealthz(body)
    || body?.pid !== target.pid
    || !verifyLocalAttestationProof(runtime.attestationSecret, challenge, target.pid, target.port, proof)
  ) {
    return rejected("restart_attestation_failed");
  }
  if (body.restartCapability !== SYSTEM_RESTART_CAPABILITY_VERSION) {
    // A pre-update proxy accepts only the reusable management credential and cannot
    // bind the operation to the attested PID. Refuse before POST rather than weakening
    // the exact-process contract or replaying a stop/start transaction.
    return rejected("restart_capability_unsupported");
  }

  let observed: LiveProxy | null;
  try {
    observed = await (deps.findLive ?? findLiveProxy)({ deadlineAt, nowFn: now });
  } catch {
    return rejected("restart_target_recheck_failed");
  }
  if (!sameRestartTarget(target, observed)) return rejected("restart_target_changed");

  const capability = createSystemRestartCapability(
    runtime.attestationSecret,
    challenge,
    SYSTEM_RESTART_METHOD,
    SYSTEM_RESTART_PATH,
    target.pid,
    target.port,
  );
  if (!capability) return rejected("restart_capability_unavailable");

  const requestBudget = remaining(deadlineAt, now, SYSTEM_RESTART_REQUEST_TIMEOUT_MS);
  if (requestBudget <= 0) return rejected("restart_deadline_expired");
  try {
    const response = await fetchImpl(`${baseUrl}${SYSTEM_RESTART_PATH}`, {
      method: SYSTEM_RESTART_METHOD,
      headers: {
        [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(target.pid),
        [SYSTEM_RESTART_NONCE_HEADER]: challenge,
        [SYSTEM_RESTART_CAPABILITY_HEADER]: capability,
      },
      signal: AbortSignal.timeout(requestBudget),
    });
    return response.ok ? { accepted: true } : rejected(`restart_request_http_${response.status}`);
  } catch {
    // The server may have accepted the restart before the response connection failed.
    // The coordinator observes the original PID for replacement instead of replaying.
    return uncertain("restart_request_outcome_unknown");
  }
}
