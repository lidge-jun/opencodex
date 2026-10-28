import { restoreNativeCodexAsync } from "../codex/inject";
import type { RetainedCodexProviderTable } from "../codex/inject/restore";
import { stripGrokConfig } from "../grok/inject";
import { readClientConnectionState, type ClientConnectionState } from "../client/state";
import { readPid, readRuntimePort } from "../config/process-state";
import { loadConfig } from "../config";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { createLocalAttestationChallenge, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER, verifyLocalAttestationProof } from "../lib/local-management-attestation";
import { LOCAL_MANAGEMENT_READ_PATHS } from "../lib/local-management-capability";
import { gracefulStopHost, isProcessAlive, ProxyOwnershipRefusedError } from "../lib/process-control";
import { directLocalHttpFetch } from "../server/direct-local-http";
import { fetchBoundLocalManagementRead } from "../server/local-management-read-client";
import { findLiveProxy, probeEndpointLiveness, proveLiveProxyOwnedByHome } from "../server/proxy-liveness";
import { observeGuardedManagerStopped } from "../service/guarded-manager-target";
import type { StartExitTeardown } from "./dispatch";
import type { StopOutcome } from "./stop-report";

/** Re-read ownership when an ordinary runtime actually exits, including after API drain. */
export function preserveConnectedClientRoutingOnExit(teardown: StartExitTeardown): StartExitTeardown {
  return readClientConnectionState().kind === "connected"
    ? { ...teardown, restoreNativeCodex: false, stripGrokConfig: false }
    : teardown;
}

type ConnectedStopTarget = { pid: number; port: number; hostname?: string };
const CONNECTED_STOP_PROBE_MS = 2000;
const unsupportedConnectedStop = () => new ProxyOwnershipRefusedError(
  "Connected-client stop refused: runtime identity, shutdown preservation or safe runtime absence could not be verified. Inspect 'ocx service status' and update/restart an incompatible runtime through its supervisor, then retry; use 'ocx disconnect' only if you intend to release those integrations.",
  "connected_client_stop_unsupported",
);

/** Require the pinned runtime's proof before accepting its shutdown contract. */
export async function assertConnectedClientStopSupported(target: ConnectedStopTarget | null): Promise<void> {
  if (!target) throw unsupportedConnectedStop();
  if (!isProcessAlive(target.pid)) return; // A manager may already have ended this exact target.
  const runtime = readRuntimePort(target.pid);
  if (!runtime?.attestationSecret || runtime.pid !== target.pid || runtime.port !== target.port
    || gracefulStopHost(runtime.hostname) !== gracefulStopHost(target.hostname)) throw unsupportedConnectedStop();
  const endpoint = { ...target, hostname: gracefulStopHost(runtime.hostname) };
  const readPinnedRuntime = () => {
    const current = readRuntimePort(target.pid);
    return current?.pid === runtime.pid && current.port === runtime.port && current.hostname === runtime.hostname
      && current.attestationSecret === runtime.attestationSecret ? current : null;
  };
  const origin = `http://${endpoint.hostname}:${endpoint.port}`;
  const deadline = Date.now() + CONNECTED_STOP_PROBE_MS;
  const signal = AbortSignal.timeout(CONNECTED_STOP_PROBE_MS);
  const readDocument = async (response: Response): Promise<Record<string, unknown> | null> => {
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return null; }
    const body = await readBoundedResponseBody(response, { maxBytes: 4096, signal, fatalUtf8: true });
    if (body.truncated) return null;
    const parsed: unknown = JSON.parse(body.text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  };
  try {
    const nonce = createLocalAttestationChallenge();
    const response = await directLocalHttpFetch(`${origin}/healthz`, {
      method: "GET", headers: { [LOCAL_ATTESTATION_CHALLENGE_HEADER]: nonce }, redirect: "error", signal,
    }, { timeoutMs: CONNECTED_STOP_PROBE_MS });
    if (!readPinnedRuntime() || !verifyLocalAttestationProof(runtime.attestationSecret, nonce, target.pid, target.port,
      response.headers.get(LOCAL_ATTESTATION_PROOF_HEADER))) {
      void response.body?.cancel().catch(() => {});
      throw unsupportedConnectedStop();
    }
    const health = await readDocument(response);
    if (!readPinnedRuntime() || health?.service !== "opencodex" || health.pid !== target.pid) throw unsupportedConnectedStop();
    // Native machine listeners preserve integrations on signal and have no /api/stop route.
    if (health.role === "client") return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw unsupportedConnectedStop();
    const read = await fetchBoundLocalManagementRead({ ...endpoint, source: "runtime" }, LOCAL_MANAGEMENT_READ_PATHS.stop, {
      readRuntime: readPinnedRuntime, timeoutMs: remaining, requireResponseProof: true,
    });
    if (read.kind !== "response") throw unsupportedConnectedStop();
    const capability = await readDocument(read.response);
    if (readPinnedRuntime() && capability?.schema === "ocx-stop-capabilities/1"
      && capability.pid === target.pid && capability.connectedClientOwnership === true) return;
  } catch { /* A missing or replaced runtime never grants shutdown authority. */ }
  throw unsupportedConnectedStop();
}

/** Fail before either service-manager path, including a manager that cascades process exit. */
export async function preflightConnectedClientStop(approved?: ConnectedStopTarget): Promise<StopOutcome | "already-stopped" | null> {
  try {
    let target = approved;
    if (!target) {
      const pid = readPid();
      const runtime = readRuntimePort(pid ?? undefined);
      if (pid && isProcessAlive(pid)) {
        if (!runtime) throw unsupportedConnectedStop();
        target = { ...runtime, pid };
      }
      else {
        const live = await findLiveProxy({ acceptPackageTreeFenced: true });
        if (live?.pid) {
          if (await proveLiveProxyOwnedByHome(live) !== "proven") throw unsupportedConnectedStop();
          target = { ...live, pid: live.pid };
        } else {
          const config = loadConfig();
          const endpoints = [...(runtime ? [runtime] : []), { port: config.port, hostname: config.hostname }];
          if (endpoints.some(endpoint => !Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535)
            || await observeGuardedManagerStopped({ kind: "absent" }) !== "inactive") throw unsupportedConnectedStop();
          for (const endpoint of endpoints) {
            if (await probeEndpointLiveness(endpoint) !== "dead") throw unsupportedConnectedStop();
          }
          return "already-stopped";
        }
      }
    }
    if (!isProcessAlive(target.pid)) throw unsupportedConnectedStop();
    await assertConnectedClientStopSupported(target);
    return null;
  } catch {
    const error = unsupportedConnectedStop();
    console.error(error.message);
    process.exitCode = 1;
    return { ok: false, summary: { schema: "ocx-stop/1", ok: false, outcome: "failed", exitCode: 1,
      runtimeDown: false, service: "absent", proxy: "ownership-refused", sharedTeardown: "skipped", message: error.message } };
  }
}

/**
 * The line `ocx stop` prints in place of the shared teardown on a connected client, or null
 * when this home is not one (#7563).
 *
 * A hub client or Remote Link Child gets its Codex routing and catalog from `ocx connect` /
 * `ocx sync`, and its client runtime never writes them on start. The standalone teardown
 * restored native Codex, rewrote the catalog and stripped the Grok block, and nothing on the
 * client put any of it back: `ocx start` brought the runtime up with Codex still native and
 * Grok unconfigured. Leaving them in place makes stop/start a round trip; `ocx disconnect`
 * remains the teardown that owns them, with its own ownership checks.
 */
export function connectedClientStopSkipLine(state: ClientConnectionState): string | null {
  if (state.kind !== "connected") return null;
  const role = state.value.transport === "link" ? "Remote Link Child" : "hub client";
  return `↩️  Codex routing, its catalog and the Grok config stay as they are: this ${role}'s connection owns them, and 'ocx start' serves them again. To hand Codex back to its own account, run 'ocx disconnect'.`;
}

/**
 * Restore shared client state after a stop.
 *
 * Returns the two failure kinds separately. `historyOnly` means teardown succeeded and
 * only Codex history metadata could not be finalized: the proxy is down, the service is
 * stopped, and a manifest is waiting for review. `other` means something that actually
 * removes state a client depends on.
 *
 * The distinction exists because `ocx update` must proceed for the first and abort for the
 * second, and it can only see an exit code (#3008).
 *
 * `historyDeferred` is the third kind (#4718). The Codex history preflight refuses BEFORE
 * the config half runs, so nothing was restored at all: config, catalog, history and
 * provenance are untouched and the client is still routed at the proxy that just stopped.
 * Like `historyOnly` the proxy is genuinely down, so an update may replace package files.
 * Unlike `historyOnly` the obligation was not performed, so the receipt must survive.
 */
export async function restoreSharedClientStateAfterStop(
  reportRetainedCodexProviderTable: (retained: RetainedCodexProviderTable) => void,
): Promise<{ historyOnly: boolean; historyDeferred: boolean; other: boolean }> {
  let historyOnly = false;
  let historyDeferred = false;
  let other = false;
  try {
    const result = await restoreNativeCodexAsync();
    if (result.success) {
      console.log(`↩️  ${result.message}`);
      if (result.retainedCodexProviderTable) {
        reportRetainedCodexProviderTable(result.retainedCodexProviderTable);
      }
    }
    else {
      // Codex history is the one restore whose failure leaves the runtime consistent: the
      // manifest is retained and the routed metadata is untouched. Config and catalog are
      // not — a client reads those, so their failure is a real teardown failure.
      const artifacts = result.artifacts;
      const configOrCatalogFailed = artifacts.config.state === "failed" || artifacts.catalog.state === "failed";
      // A preflight refusal reports every artifact as `skipped` because none of them were
      // attempted. Reading the states alone cannot tell that apart from an ownership
      // refusal, so the structured reason carries it and the states are still required to
      // agree — a refusal that somehow reports a failed artifact is not this case.
      // A degraded restore has no refusal reason and reports config as partial, so it cannot
      // enter this branch: its config obligation was discharged and the stop receipt must be
      // released rather than preserved.
      const preflightRefused = result.historyPreflightRefusal !== undefined
        && artifacts.config.state === "skipped"
        && artifacts.catalog.state === "skipped"
        && artifacts.history.state === "skipped";
      if (preflightRefused) historyDeferred = true;
      else if (!configOrCatalogFailed && artifacts.history.state === "failed") historyOnly = true;
      else other = true;
      console.error(`⚠️  ${result.message}`);
    }
  } catch (error) {
    other = true;
    console.error(`⚠️  Native Codex restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A refused or thrown Grok strip is actionable because it would point Grok at a dead proxy.
  try {
    const grok = stripGrokConfig();
    if (grok.changed) console.log(`↩️  ${grok.message}`);
    else if (!grok.ok) { other = true; console.error(`⚠️  ${grok.message}`); }
  } catch (error) {
    other = true;
    console.error(`⚠️  Grok config restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { historyOnly, historyDeferred, other };
}
