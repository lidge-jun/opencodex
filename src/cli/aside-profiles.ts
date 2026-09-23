import type { OwnedIntegrationRefreshOutcome } from "../integrations/owned-refresh";
import { readRuntimePort } from "../config/process-state";
import { createLocalAttestationChallenge, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER, verifyLocalAttestationProof } from "../lib/local-management-attestation";
import { createLocalAsideSyncCapability, LOCAL_ASIDE_SYNC_CAPABILITY_HEADER, LOCAL_ASIDE_SYNC_CAPABILITY_TTL_MS, LOCAL_ASIDE_SYNC_CAPABILITY_VERSION, LOCAL_ASIDE_SYNC_EXPECTED_PID_HEADER, LOCAL_ASIDE_SYNC_EXPIRES_AT_HEADER, LOCAL_ASIDE_SYNC_METHOD, LOCAL_ASIDE_SYNC_NONCE_HEADER, LOCAL_ASIDE_SYNC_PATH } from "../lib/local-aside-sync-contract";
import { directLocalHttpFetch } from "../server/direct-local-http";
import { findLiveProxy, isOpencodexHealthz, probeHostname } from "../server/proxy-liveness";
import { runtimeRequest, RuntimeApiError, type RuntimeApiDeps } from "./runtime-api";

/** Aside policy and file writes share the running server's mutation owner. Never fall back locally. */
export async function refreshAsideProfilesThroughServer(
  // The optional transport seam observes the real direct-local exchange in listener tests.
  deps: RuntimeApiDeps & { directLocalFetch?: typeof directLocalHttpFetch; exchangeDeadlineMs?: number } = {},
): Promise<OwnedIntegrationRefreshOutcome[]> {
  // An explicit URL is an opt-in transport used by connected callers and tests.
  if (!deps.baseUrl) {
    const localFetch = deps.directLocalFetch ?? directLocalHttpFetch;
    const deadline = AbortSignal.timeout(deps.exchangeDeadlineMs ?? LOCAL_ASIDE_SYNC_CAPABILITY_TTL_MS);
    const live = await (deps.findLiveProxy ?? findLiveProxy)();
    if (!live) throw new RuntimeApiError("Proxy is not running. Start it with: ocx start", 503, null);
    if (live.source !== "runtime" || live.pid === null) {
      throw new RuntimeApiError("Aside profile synchronization requires an attested running proxy", 503, null);
    }
    const runtime = readRuntimePort(live.pid);
    if (!runtime?.attestationSecret || runtime.pid !== live.pid || runtime.port !== live.port) {
      throw new RuntimeApiError("Aside profile synchronization could not verify the running proxy", 503, null);
    }
    const nonce = createLocalAttestationChallenge();
    const baseUrl = `http://${probeHostname(live.hostname)}:${live.port}`;
    const proofResponse = await localFetch(`${baseUrl}/healthz`, { headers: { [LOCAL_ATTESTATION_CHALLENGE_HEADER]: nonce }, signal: deadline });
    const health = await proofResponse.json().catch(() => null);
    if (!proofResponse.ok || !isOpencodexHealthz(health) || health?.pid !== live.pid || health?.port !== live.port
      || health?.asideSyncCapability !== LOCAL_ASIDE_SYNC_CAPABILITY_VERSION
      || !verifyLocalAttestationProof(runtime.attestationSecret, nonce, live.pid, live.port, proofResponse.headers.get(LOCAL_ATTESTATION_PROOF_HEADER))) {
      throw new RuntimeApiError("Aside profile synchronization could not attest the running proxy", 503, null);
    }
    const expiresAt = Date.now() + LOCAL_ASIDE_SYNC_CAPABILITY_TTL_MS;
    const capability = createLocalAsideSyncCapability(runtime.attestationSecret, nonce, LOCAL_ASIDE_SYNC_METHOD, LOCAL_ASIDE_SYNC_PATH, live.pid, live.port, expiresAt);
    if (!capability) throw new RuntimeApiError("Aside profile synchronization capability was unavailable", 503, null);
    const response = await localFetch(`${baseUrl}${LOCAL_ASIDE_SYNC_PATH}`, {
      method: LOCAL_ASIDE_SYNC_METHOD,
      signal: deadline,
      headers: {
        [LOCAL_ASIDE_SYNC_EXPECTED_PID_HEADER]: String(live.pid),
        [LOCAL_ASIDE_SYNC_NONCE_HEADER]: nonce,
        [LOCAL_ASIDE_SYNC_EXPIRES_AT_HEADER]: String(expiresAt),
        [LOCAL_ASIDE_SYNC_CAPABILITY_HEADER]: capability,
      },
    });
    const body = await response.json().catch(() => null) as { results?: OwnedIntegrationRefreshOutcome[] } | null;
    if (!response.ok) throw new RuntimeApiError("Aside profile synchronization was rejected", response.status, body);
    if (!Array.isArray(body?.results)) throw new RuntimeApiError("The running proxy does not support Aside profile synchronization", 502, body);
    return body.results;
  }
  const result = await runtimeRequest<{ results?: OwnedIntegrationRefreshOutcome[] }>(
    "/api/client-integrations/aside/sync",
    { method: "POST", body: "{}" },
    deps,
  );
  if (!Array.isArray(result.results)) {
    throw new RuntimeApiError("The running proxy does not support Aside profile synchronization", 502, result);
  }
  return result.results;
}
