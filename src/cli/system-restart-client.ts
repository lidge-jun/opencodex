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
  isHealthzVersion,
  isOpencodexHealthz,
  isPackageTreeFencedHealthz,
  probeHostname,
  type HealthzIdentity,
  type LiveProxy,
} from "../server/proxy-liveness";
import type { ProxyRestartRequestOutcome } from "./tray-proxy";
import { packageVersion } from "./help";
import { computeVersionSkew } from "./version-skew";

export const SYSTEM_RESTART_REQUEST_TIMEOUT_MS = 5_000;
export const SYSTEM_RESTART_ATTESTATION_TIMEOUT_MS = 4_000;

export interface BoundSystemRestartDeps {
  fetchImpl?: typeof fetch;
  readRuntime?: typeof readRuntimePort;
  findLive?: typeof findLiveProxy;
  createChallenge?: () => string;
  now?: () => number;
  /** Invoking CLI version for the skew guard; defaults to this bundle's package version. */
  cliVersion?: string;
}

function rejected(code: string): ProxyRestartRequestOutcome {
  return { accepted: false, uncertain: false, error: new Error(code) };
}

/** Own-bundle version for the skew comparison; an unreadable bundle is "cannot compare", not a crash. */
function ownCliVersion(): string {
  try {
    return packageVersion();
  } catch {
    return "unknown";
  }
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
  // A package-tree fence answers /healthz with 503 but still proves its identity (#5496).
  // Only that exact body is admitted as a non-OK proof response; the proof check is unchanged.
  const fenced = proofResponse.status === 503 && isPackageTreeFencedHealthz(body);
  if (
    !(proofResponse.ok || fenced)
    || !(isOpencodexHealthz(body) || fenced)
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

  // An in-place restart respawns the live process from its own installation
  // (selfLaunchArgv in server/management/system-restart.ts), so a restart accepted
  // from a different-version CLI would keep the OLD build serving while reporting
  // success (#4522). Both sides already publish exactly the data doctor's skew
  // diagnosis compares (packageVersion vs the /healthz version), so reuse that
  // comparison and refuse before POST. Placeholder versions (unknown/0.0.0) are
  // "cannot compare", not mismatch, and keep the existing behavior.
  //
  // A fenced proxy booted from files that have since been replaced at the same path, so its
  // boot version differs from this CLI by construction. What the respawn will run is the
  // manifest now on disk, which the fence reports as installedVersion. Without a readable
  // one the replacement is still in flight and restarting now could load a partial tree.
  if (fenced && !isHealthzVersion(body.installedVersion)) {
    return rejected("restart_package_tree_unsettled");
  }
  const proxyVersion = fenced
    ? body.installedVersion as string
    : typeof body.version === "string" ? body.version : undefined;
  if (computeVersionSkew(deps.cliVersion ?? ownCliVersion(), proxyVersion).skewed) {
    return rejected("restart_version_skew");
  }

  let observed: LiveProxy | null;
  try {
    observed = await (deps.findLive ?? findLiveProxy)({ deadlineAt, nowFn: now, acceptPackageTreeFenced: true });
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
