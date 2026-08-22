import { readRuntimePort, type RuntimePortState } from "../config/process-state";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationChallenge,
  verifyLocalAttestationProof,
} from "../lib/local-management-attestation";
import {
  LOCAL_PROVIDER_RELOAD_CAPABILITY_HEADER,
  LOCAL_PROVIDER_RELOAD_CAPABILITY_TTL_MS,
  LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION,
  LOCAL_PROVIDER_RELOAD_EXPECTED_PID_HEADER,
  LOCAL_PROVIDER_RELOAD_EXPIRES_AT_HEADER,
  LOCAL_PROVIDER_RELOAD_METHOD,
  LOCAL_PROVIDER_RELOAD_NAME_HEADER,
  LOCAL_PROVIDER_RELOAD_NONCE_HEADER,
  LOCAL_PROVIDER_RELOAD_PATH,
  createLocalProviderReloadCapability,
  isLocalProviderReloadName,
} from "../lib/local-provider-reload-contract";
import { directLocalHttpFetch } from "./direct-local-http";
import { isOpencodexHealthz, probeHostname, type HealthzIdentity, type LiveProxy } from "./proxy-liveness";

export type LocalProviderReloadResult =
  | { kind: "reloaded" }
  | { kind: "unavailable"; reason: "invalid-name" | "unattested-target" | "runtime-mismatch" | "attestation" | "capability" | "transport" | "rejected" };

export interface LocalProviderReloadDeps {
  fetchImpl?: typeof fetch;
  readRuntime?: (pid: number) => RuntimePortState | null;
  createNonce?: () => string;
  now?: () => number;
  timeoutMs?: number;
}

const LOCAL_PROVIDER_RELOAD_TIMEOUT_MS = 10_000;

/**
 * Ask the exact runtime proxy to reload one already-persisted provider.
 *
 * No provider object, API key, OAuth token, custom header, or reusable management
 * credential crosses the socket. The request is bodyless and its one-shot capability
 * binds the provider name to the attested process, method, path, PID, port, and expiry.
 */
export async function requestBoundLocalProviderReload(
  target: LiveProxy,
  name: string,
  deps: LocalProviderReloadDeps = {},
): Promise<LocalProviderReloadResult> {
  if (!isLocalProviderReloadName(name)) return { kind: "unavailable", reason: "invalid-name" };
  if (target.source !== "runtime" || target.pid === null || target.pid <= 0) {
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

  const fetchImpl = deps.fetchImpl ?? directLocalHttpFetch;
  const timeoutMs = deps.timeoutMs ?? LOCAL_PROVIDER_RELOAD_TIMEOUT_MS;
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
  const body = await proofResponse.json().catch(() => null) as HealthzIdentity | null;
  if (
    !proofResponse.ok
    || !isOpencodexHealthz(body)
    || body?.pid !== target.pid
    || body?.port !== target.port
    || body?.providerReloadCapability !== LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION
    || !verifyLocalAttestationProof(
      runtime.attestationSecret,
      nonce,
      target.pid,
      target.port,
      proofResponse.headers.get(LOCAL_ATTESTATION_PROOF_HEADER),
    )
  ) {
    return { kind: "unavailable", reason: "attestation" };
  }

  const currentRuntime = readRuntime(target.pid);
  if (
    !currentRuntime?.attestationSecret
    || currentRuntime.pid !== runtime.pid
    || currentRuntime.port !== runtime.port
    || currentRuntime.hostname !== runtime.hostname
    || currentRuntime.attestationSecret !== runtime.attestationSecret
  ) {
    return { kind: "unavailable", reason: "runtime-mismatch" };
  }

  const expiresAt = (deps.now ?? Date.now)() + LOCAL_PROVIDER_RELOAD_CAPABILITY_TTL_MS;
  const capability = createLocalProviderReloadCapability(
    runtime.attestationSecret,
    nonce,
    LOCAL_PROVIDER_RELOAD_METHOD,
    LOCAL_PROVIDER_RELOAD_PATH,
    name,
    target.pid,
    target.port,
    expiresAt,
  );
  if (!capability) return { kind: "unavailable", reason: "capability" };

  try {
    const response = await fetchImpl(`${baseUrl}${LOCAL_PROVIDER_RELOAD_PATH}`, {
      method: LOCAL_PROVIDER_RELOAD_METHOD,
      headers: {
        [LOCAL_PROVIDER_RELOAD_EXPECTED_PID_HEADER]: String(target.pid),
        [LOCAL_PROVIDER_RELOAD_NONCE_HEADER]: nonce,
        [LOCAL_PROVIDER_RELOAD_EXPIRES_AT_HEADER]: String(expiresAt),
        [LOCAL_PROVIDER_RELOAD_NAME_HEADER]: name,
        [LOCAL_PROVIDER_RELOAD_CAPABILITY_HEADER]: capability,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok
      ? { kind: "reloaded" }
      : { kind: "unavailable", reason: "rejected" };
  } catch {
    return { kind: "unavailable", reason: "transport" };
  }
}
