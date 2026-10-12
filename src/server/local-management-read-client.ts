import { readRuntimePort, type RuntimePortState } from "../config/process-state";
import {
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationChallenge,
  verifyLocalAttestationProof,
} from "../lib/local-management-attestation";
import {
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_TTL_MS,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
  createLocalManagementReadCapability,
  type LocalManagementReadPath,
} from "../lib/local-management-capability";
import { directLocalHttpFetch } from "./direct-local-http";
import { probeHostname, type LiveProxy } from "./proxy-liveness";

export type LocalManagementReadResult =
  | { kind: "response"; response: Response; targetPid: number }
  | {
    kind: "unavailable";
    reason: "unattested-target" | "runtime-mismatch" | "capability-unavailable" | "transport" | "unattested-response";
  };

export interface LocalManagementReadDeps {
  fetchImpl?: typeof fetch;
  /** Default transport seam; receives the caller deadline. */
  directFetch?: typeof directLocalHttpFetch;
  readRuntime?: (pid: number) => RuntimePortState | null;
  createNonce?: () => string;
  now?: () => number;
}

export interface LocalManagementReadRequestDeps extends LocalManagementReadDeps {
  timeoutMs?: number;
  /**
   * Require the response to carry the server's attestation over this request's nonce. The
   * capability authenticates the request to the real server; only this proof tells the caller
   * that the answer came from it and not from whatever process now holds the port.
   */
  requireResponseProof?: boolean;
}

/**
 * Read one exact local management endpoint without sending a reusable admin credential.
 *
 * The runtime record is the protected source of the per-process key. The server proves
 * it owns that key by accepting a single-use capability bound to this GET, path, PID,
 * port, and short expiry.
 */
export async function fetchBoundLocalManagementRead(
  target: LiveProxy,
  path: LocalManagementReadPath,
  deps: LocalManagementReadRequestDeps = {},
): Promise<LocalManagementReadResult> {
  if (
    target.source !== "runtime"
    || target.pid === null
    || !Number.isSafeInteger(target.pid)
    || target.pid <= 0
  ) {
    return { kind: "unavailable", reason: "unattested-target" };
  }
  const readRuntime = deps.readRuntime ?? readRuntimePort;
  const runtime = readRuntime(target.pid);
  if (
    !runtime?.attestationSecret
    || runtime.pid !== target.pid
    || runtime.port !== target.port
  ) {
    return { kind: "unavailable", reason: "runtime-mismatch" };
  }

  const nonce = (deps.createNonce ?? createLocalAttestationChallenge)();
  const expiresAt = (deps.now ?? Date.now)() + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS;
  const capability = createLocalManagementReadCapability(
    runtime.attestationSecret,
    nonce,
    "GET",
    path,
    target.pid,
    target.port,
    expiresAt,
  );
  if (!capability) return { kind: "unavailable", reason: "capability-unavailable" };

  try {
    const timeoutMs = deps.timeoutMs ?? 4_000;
    const url = `http://${probeHostname(target.hostname)}:${target.port}${path}`;
    const init: RequestInit = {
      headers: {
        [LOCAL_MANAGEMENT_EXPECTED_PID_HEADER]: String(target.pid),
        [LOCAL_MANAGEMENT_NONCE_HEADER]: nonce,
        [LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER]: String(expiresAt),
        [LOCAL_MANAGEMENT_CAPABILITY_HEADER]: capability,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    const response = deps.fetchImpl
      ? await deps.fetchImpl(url, init)
      : await (deps.directFetch ?? directLocalHttpFetch)(url, init, { timeoutMs });
    if (deps.requireResponseProof && !verifyLocalAttestationProof(
      runtime.attestationSecret, nonce, target.pid, target.port, response.headers.get(LOCAL_ATTESTATION_PROOF_HEADER),
    )) {
      void response.body?.cancel().catch(() => {});
      return { kind: "unavailable", reason: "unattested-response" };
    }
    return { kind: "response", response, targetPid: target.pid };
  } catch {
    return { kind: "unavailable", reason: "transport" };
  }
}
