import { randomBytes } from "node:crypto";
import { restoreNativeCodexAsync } from "../codex/inject";
import type { RetainedCodexProviderTable } from "../codex/inject/restore";
import { stripGrokConfig } from "../grok/inject";
import { linkStopConnectionOwner, readClientConnectionState, type ClientConnectionState } from "../client/state";
import { withClientLifecycleSync } from "../client/lifecycle-lock";
import type { RestoreBoundaryOwnership } from "../client/restore-ownership";
export type { RestoreBoundaryOwnership } from "../client/restore-ownership";
import { inspectStopRestoreOwnership, stopRestoreWriteGuard } from "./stop-restore-guard";
export { clearRestoredStopReceipts, settleUnrestoredStopBoundary } from "./stop-restore-guard";
import { readPid, readRuntimePort, type ClientStopOwner, type RuntimePortState } from "../config/process-state";
import type { OutstandingTeardown } from "../config/pending-teardown";
import { loadConfig } from "../config";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { createLocalAttestationChallenge, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER, verifyLocalAttestationProof } from "../lib/local-management-attestation";
import { LOCAL_MANAGEMENT_READ_PATHS } from "../lib/local-management-capability";
import { gracefulStopHost, isProcessAlive, ProxyOwnershipRefusedError, stopRequestFetch as directStopRequestFetch } from "../lib/process-control";
import { directLocalHttpFetch } from "../server/direct-local-http";
import { fetchBoundLocalManagementRead } from "../server/local-management-read-client";
import { isSharedTeardownDeferredOnExit } from "../server/stop-teardown";
import { findLiveProxy, probeEndpointLiveness, proveLiveProxyOwnedByHome } from "../server/proxy-liveness";
import { observeGuardedManagerStopped } from "../service/guarded-manager-target";
import type { StartExitTeardown } from "./dispatch";
import type { StopOutcome } from "./stop-report";

/** Honor accepted API deferral, otherwise re-read connection ownership on ordinary exit. */
export function preserveConnectedClientRoutingOnExit(teardown: StartExitTeardown): StartExitTeardown {
  if (isSharedTeardownDeferredOnExit()) {
    return { ...teardown, restoreNativeCodex: false, stripGrokConfig: false };
  }
  const connection = readClientConnectionState();
  return connection.kind === "connected" && connection.value.transport !== "link"
    ? { ...teardown, restoreNativeCodex: false, stripGrokConfig: false }
    : teardown;
}

type ConnectedStopTarget = { pid: number; port: number; hostname?: string };
export type LinkStopPreflight = { target: ConnectedStopTarget; owner: ClientStopOwner; verify: () => void };
export function needsConnectedStopPreflight(connection: ClientConnectionState, runtime: RuntimePortState | null): boolean {
  return connection.kind !== "disconnected" || runtime?.clientLinkOwner !== undefined || runtime?.servingGeneration !== undefined;
}

const CONNECTED_STOP_PROBE_MS = 2000;
export const unsupportedConnectedStop = () => new ProxyOwnershipRefusedError(
  "Connected-client stop refused: runtime identity, saved connection ownership, shutdown preservation or safe runtime absence could not be verified. No process was stopped by this check. Inspect 'ocx service status', repair saved connection ownership or update/restart an incompatible runtime through its supervisor, then retry. Use 'ocx disconnect' only if you intend to release those integrations.",
  "connected_client_stop_unsupported",
);

export function verifyConnectedStopTarget(
  linkStop: LinkStopPreflight | undefined, stoppingSibling: boolean, alreadyStopped: boolean, pid?: number,
): void {
  const state = readClientConnectionState();
  if (state.kind === "invalid" || state.kind === "mismatched") throw unsupportedConnectedStop();
  if (linkStop) {
    if (pid !== undefined && pid !== linkStop.target.pid) throw unsupportedConnectedStop();
    if (pid === undefined || isProcessAlive(pid)) linkStop.verify();
  } else if (!stoppingSibling && !alreadyStopped && (state.kind === "connected" && state.value.transport === "link"
    || readRuntimePort()?.clientLinkOwner != null)) {
    throw unsupportedConnectedStop();
  }
}

// Only a definitive "nothing is answering" authorizes finishing somebody else's
// abandoned teardown. The tri-state probe distinguishes that from "we could not tell"
// (timeout, a listener that withholds /healthz), which `findLiveProxy` collapses into
// the same null (#3008).
export async function abandonedTeardownIsSafeToFinish(
  endpoint: { hostname: string; port: number } | null,
): Promise<boolean> {
  // The endpoint has to come from the receipt. A crashed owner usually leaves no
  // runtime-port record, and the configured port is the wrong question for a proxy
  // started with an explicit --port: it refuses while the live one keeps serving.
  // An obligation that cannot name its endpoint cannot be proven discharged.
  if (!endpoint) return false;
  try {
    return await probeEndpointLiveness(endpoint) === "dead";
  } catch {
    // A probe that could not run is not evidence of absence.
    return false;
  }
}

/** Require the pinned runtime's proof before accepting its shutdown contract. */
export async function assertConnectedClientStopSupported(
  target: ConnectedStopTarget | null, options: { requireLinkStopFence?: boolean } = {},
): Promise<{ linkStopFence: boolean; nativeClient: boolean } | null> {
  if (!target) throw unsupportedConnectedStop();
  if (!isProcessAlive(target.pid)) return null; // A manager may already have ended this exact target.
  const runtime = readRuntimePort(target.pid);
  if (!runtime?.attestationSecret || runtime.pid !== target.pid || runtime.port !== target.port
    || gracefulStopHost(runtime.hostname) !== gracefulStopHost(target.hostname)) throw unsupportedConnectedStop();
  const endpoint = { ...target, hostname: gracefulStopHost(runtime.hostname) };
  const readPinnedRuntime = () => {
    const current = readRuntimePort(target.pid);
    return current?.pid === runtime.pid && current.port === runtime.port && current.hostname === runtime.hostname
      && current.attestationSecret === runtime.attestationSecret && current.clientLinkOwner === runtime.clientLinkOwner ? current : null;
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
    const linkStopFence = health.linkStopFence === true;
    if (options.requireLinkStopFence && !linkStopFence) throw unsupportedConnectedStop();
    // A native listener proves its contract on health and has no /api/stop route.
    if (health.role === "client") return { linkStopFence, nativeClient: true };
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw unsupportedConnectedStop();
    const read = await fetchBoundLocalManagementRead({ ...endpoint, source: "runtime" }, LOCAL_MANAGEMENT_READ_PATHS.stop, {
      readRuntime: readPinnedRuntime, timeoutMs: remaining, requireResponseProof: true,
    });
    if (read.kind !== "response") throw unsupportedConnectedStop();
    const capability = await readDocument(read.response);
    if (readPinnedRuntime() && capability?.schema === "ocx-stop-capabilities/1"
      && capability.pid === target.pid && capability.connectedClientOwnership === true) return { linkStopFence, nativeClient: false };
  } catch { /* A missing or replaced runtime never grants shutdown authority. */ }
  throw unsupportedConnectedStop();
}

/** Fail before either service-manager path, including a manager that cascades process exit. */
export async function preflightConnectedClientStop(
  approved: ConnectedStopTarget | undefined, onFence: (finish: () => Promise<void>) => void,
  inheritedTeardowns?: readonly OutstandingTeardown[],
  onLinkStop?: (preflight: LinkStopPreflight) => void,
): Promise<StopOutcome | "already-stopped" | null> {
  try {
    const connection = readClientConnectionState();
    if (connection.kind === "invalid" || connection.kind === "mismatched") throw unsupportedConnectedStop();
    let target = approved;
    if (!target) {
      const trackedPid = readPid();
      const runtime = readRuntimePort(trackedPid ?? undefined);
      // A native Child's attested record can identify it even if generic start-argv
      // inspection cannot reconstruct its installation path.
      const pid = trackedPid ?? (runtime?.servingGeneration ? runtime.pid : undefined);
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
          const endpoints = [...(runtime ? [runtime] : []),
            ...(config.port === 0 ? [] : [{ port: config.port, hostname: config.hostname }])];
          if (endpoints.length === 0 || endpoints.some(endpoint => !Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535)
            || await observeGuardedManagerStopped({ kind: "absent" }) !== "inactive") throw unsupportedConnectedStop();
          for (const endpoint of endpoints) {
            if (await probeEndpointLiveness(endpoint) !== "dead") throw unsupportedConnectedStop();
          }
          return "already-stopped";
        }
      }
    }
    if (!isProcessAlive(target.pid)) throw unsupportedConnectedStop();
    const pinned = readRuntimePort(target.pid);
    const savedLink = connection.kind === "connected" && connection.value.transport === "link";
    const publishedLink = pinned?.clientLinkOwner != null;
    const capability = await assertConnectedClientStopSupported(target, { requireLinkStopFence: savedLink || publishedLink });
    if (!capability || !Bun.deepEquals(readRuntimePort(target.pid), pinned, true)) throw unsupportedConnectedStop();
    if (savedLink || publishedLink || capability.linkStopFence) {
      const link = connection.kind === "connected" && linkStopConnectionOwner(connection.value);
      if (!link || pinned?.clientLinkOwner !== link || loadConfig().port !== target.port) throw unsupportedConnectedStop();
      // A native Child has no /api/stop refusal: SIGTERM can escalate to SIGKILL.
      // Refuse known inherited restore blockers before any manager or kill step.
      const { readLinkInheritedTeardowns } = await import("../client/stop-native-handoff");
      const normalizeHost = (value: string | undefined) => (value ?? "127.0.0.1").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
      for (const read of inheritedTeardowns ?? readLinkInheritedTeardowns()) {
        const exact = read.state === "valid" && read.receipt.endpointSource === "exact";
        const endpoint = read.state === "valid" ? read.receipt.endpoint : null;
        const sameTarget = endpoint && endpoint.port === target.port
          && normalizeHost(endpoint.hostname) === normalizeHost(target.hostname);
        if (!exact || !endpoint || (!sameTarget && await probeEndpointLiveness(endpoint) !== "dead")) {
          throw new ProxyOwnershipRefusedError("Link Child native teardown preflight refused: pending recovery evidence would prevent native restoration. No process was stopped; repair that evidence, then retry ocx stop.", "link_native_teardown_refused");
        }
      }
      // A manager can kill the Child before its signal handler runs. Drain these file routes
      // first, under an exact runtime fence; refusal must return before any manager/kill step.
      if (!pinned?.attestationSecret || !Bun.deepEquals(readRuntimePort(target.pid), pinned, true)) throw unsupportedConnectedStop();
      const { finishClientRuntimeStop, markClientRuntimeStopping, markClientRuntimeStoppingWithRetry } = await import("../client/sync-runtime");
      const { restoreLinkFileRouting } = await import("../client/stop-file-routing");
      const { readClientStopProcessStart } = await import("../client/stop-teardown-owner");
      const startTime = readClientStopProcessStart(process.pid);
      if (!startTime) throw unsupportedConnectedStop();
      const owner = { pid: process.pid, startTime, nonce: randomBytes(16).toString("hex") };
      const identity = { pid: target.pid, port: target.port, attestationSecret: pinned.attestationSecret };
      // The CLI holds its ownership mutation lease through this finalizer. A retained listener
      // can distinguish a finished stop from one still about to call a manager or kill fallback.
      onFence(async () => {
        const finished = await markClientRuntimeStoppingWithRetry(identity, { mark: () => finishClientRuntimeStop(identity, owner) });
        if (!finished) console.warn("The retained Child's stop state could not be finalized; repair its runtime record before retrying recovery.");
      });
      const stopping = { ...pinned, clientStopping: true, clientStopRequested: true, clientStopOwner: owner };
      const checkRuntime = () => {
        if (!Bun.deepEquals(readRuntimePort(identity.pid), stopping, true)) throw new Error("client_runtime_changed");
      };
      const guard = stopRestoreWriteGuard(connection.value);
      const fenced = await markClientRuntimeStoppingWithRetry(identity, {
        mark: () => guard.run(() => {
          const current = readRuntimePort(identity.pid);
          if (!Bun.deepEquals(current, pinned, true) && !Bun.deepEquals(current, stopping, true)) throw new Error("client_runtime_changed");
          // The marker is checked by every sync commit, including already admitted work.
          markClientRuntimeStopping(identity, owner);
        }),
      });
      try {
        if (!fenced) throw new Error("the runtime sync fence could not be verified");
        await restoreLinkFileRouting(connection.value, { beforeWrite: checkRuntime });
        onLinkStop?.({ target, owner, verify: () => {
          try { guard.run(() => {
            checkRuntime();
            if (loadConfig().port !== identity.port) throw new Error("client_route_port_changed");
          }); }
          catch { throw unsupportedConnectedStop(); }
        } });
      } catch (error) {
        throw new ProxyOwnershipRefusedError(`Link Child file routing restore refused: ${error instanceof Error ? error.message : "restoration failed"}. No process was stopped. ${fenced ? "Sync remains fenced; " : ""}repair the client configuration or ownership evidence, then retry ocx stop.`, "link_file_restore_refused");
      }
    } else if (capability.nativeClient && (connection.kind !== "connected" || pinned?.clientLinkOwner !== null)) {
      // Older native listeners cannot distinguish Hub from Link once the saved connection drifts.
      throw unsupportedConnectedStop();
    }
    return null;
  } catch (cause) {
    const error = cause instanceof ProxyOwnershipRefusedError ? cause : unsupportedConnectedStop();
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
 * A hub client gets its Codex routing and catalog from `ocx connect` / `ocx sync`, and its
 * client runtime never writes them on start. The standalone teardown
 * restored native Codex, rewrote the catalog and stripped the Grok block, and nothing on the
 * client put any of it back: `ocx start` brought the runtime up with Codex still native and
 * Grok unconfigured. Leaving them in place makes stop/start a round trip; `ocx disconnect`
 * remains the teardown that owns them, with its own ownership checks. A Remote Link Child
 * is deliberately excluded: its unauthenticated loopback route is unsafe after the listener exits.
 */
export function connectedClientStopSkipLine(state: ClientConnectionState): string | null {
  if (state.kind !== "connected" || state.value.transport === "link") return null;
  return `↩️  Codex routing, its catalog and the Grok config stay as they are: this hub client's connection owns them, and 'ocx start' serves them again. To hand Codex back to its own account, run 'ocx disconnect'.`;
}

/**
 * Transport for the authenticated `POST /api/stop`. The target is always this machine's own
 * runtime, so the request never consults HTTP(S)_PROXY/ALL_PROXY, whatever the connection
 * state is or becomes while the stop awaits: an environment proxy must never receive the admin
 * token. Restoration ownership is decided separately.
 */
export function stopRequestFetch(): typeof fetch {
  return directStopRequestFetch as typeof fetch;
}

/**
 * Whether the stop caller may accept `sharedTeardown: "not-owned"` as teardown confirmation.
 *
 * Refused only for a positively identified Link connection: its unauthenticated loopback
 * route is unsafe once the listener exits, only an old build answers `not-owned` for one,
 * and it says so while preserving the route this stop must restore. Everything else — a
 * sibling, a hub connection, or no connection at all — has nothing that answer skipped.
 * Callers pass the state read at the POST, not at stop entry: a connect or disconnect
 * committed while the stop is still awaiting decides the ownership the answer describes.
 */
export function notOwnedTeardownIsAcceptable(state: ClientConnectionState, stoppingSibling: boolean): boolean {
  return stoppingSibling || state.kind !== "connected" || state.value.transport !== "link";
}

/**
 * Re-read connection ownership at the parent restore boundary (#7736). A hub connection
 * committed while the stop was in flight owns Codex routing, the catalog and Grok, so the
 * stop must not restore over it. `ocx connect`/`ocx disconnect` publish connection state
 * under the client lifecycle lock (L), so this early read takes L. Each subsequent write
 * repeats the check under C via stopRestoreWriteGuard; the early read grants no write authority.
 * A busy or failing lock proves nothing either way.
 */
export function restoreBoundaryOwnership(deps: {
  read?: typeof readClientConnectionState;
  withLifecycle?: typeof withClientLifecycleSync;
} = {}): RestoreBoundaryOwnership {
  const read = deps.read ?? readClientConnectionState;
  try {
    return (deps.withLifecycle ?? withClientLifecycleSync)(() => inspectStopRestoreOwnership(read));
  } catch {
    return "unproven";
  }
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
): Promise<{ historyOnly: boolean; historyDeferred: boolean; other: boolean; boundary?: "hub-owned" | "unproven" }> {
  let historyOnly = false;
  let historyDeferred = false;
  let other = false;
  const guard = stopRestoreWriteGuard();
  const connection = readClientConnectionState();
  if (connection.kind === "connected" && connection.value.transport === "link") {
    try {
      const { restoreLinkFileRouting } = await import("../client/stop-file-routing");
      await restoreLinkFileRouting(connection.value);
    } catch (error) {
      other = true;
      console.error(`⚠️  Link Child file routing restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const result = await restoreNativeCodexAsync({ withWriteGuard: guard.run });
    if (guard.boundary() !== "restore") throw new Error("stop_restore_ownership_changed");
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
    const boundary = guard.boundary();
    if (boundary !== "restore") return { historyOnly: false, historyDeferred: false, other: false, boundary };
    other = true;
    console.error(`⚠️  Native Codex restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A refused or thrown Grok strip is actionable because it would point Grok at a dead proxy.
  try {
    const grok = guard.run(() => stripGrokConfig());
    if (grok.changed) console.log(`↩️  ${grok.message}`);
    else if (!grok.ok) { other = true; console.error(`⚠️  ${grok.message}`); }
  } catch (error) {
    const boundary = guard.boundary();
    if (boundary !== "restore") return { historyOnly, historyDeferred, other, boundary };
    other = true;
    console.error(`⚠️  Grok config restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { historyOnly, historyDeferred, other };
}
