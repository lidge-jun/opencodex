import { lstatSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { restoreNativeCodexAsync } from "../codex/inject";
import type { RetainedCodexProviderTable } from "../codex/inject/restore";
import { stripGrokConfig } from "../grok/inject";
import { linkStopConnectionOwner, readClientConnectionState, type ClientConnectionState } from "../client/state";
import { withClientLifecycleSync } from "../client/lifecycle-lock";
import { StopRestoreOwnershipError, type RestoreBoundaryOwnership } from "../client/restore-ownership";
export type { RestoreBoundaryOwnership } from "../client/restore-ownership";
import { inspectStopRestoreOwnership, stopRestoreWriteGuard } from "./stop-restore-guard";
export { clearRestoredStopReceipts, settleUnrestoredStopBoundary } from "./stop-restore-guard";
import { isOcxStartCommandLine, readAlivePid, readPid, readProcessCommandLine, readRuntimePort, type ClientStopOwner, type RuntimePortState } from "../config/process-state";
import { getConfigDir } from "../config/paths";
import type { OutstandingTeardown } from "../config/pending-teardown";
import type { LinkInheritedTeardown } from "../client/stop-native-handoff";
import { loadConfig } from "../config";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { sameFileIdentity, type FileIdentity } from "../lib/file-identity";
import { createLocalAttestationChallenge, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER, verifyLocalAttestationProof } from "../lib/local-management-attestation";
import { LOCAL_MANAGEMENT_READ_PATHS } from "../lib/local-management-capability";
import { gracefulStopHost, isProcessAlive, ProxyOwnershipRefusedError, stopRequestFetch as directStopRequestFetch } from "../lib/process-control";
import { directLocalHttpFetch } from "../server/direct-local-http";
import { fetchBoundLocalManagementRead } from "../server/local-management-read-client";
import { isSharedTeardownDeferredOnExit } from "../server/stop-teardown";
import { findLiveProxy, isPackageTreeFencedHealthz, probeEndpointLiveness } from "../server/proxy-liveness";
import { inspectGuardedManagerTarget, observeGuardedManagerStopped } from "../service/guarded-manager-target";
import { assertServiceEnvironmentMatchesInstall } from "../service/guards";
import { installedServiceListenPort } from "../service/health";
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
export type StopTargetProof = { target: ConnectedStopTarget; verify: () => void; siblingOnly?: true; terminateSibling?: () => void };
export type LinkStopPreflight = StopTargetProof & { owner: ClientStopOwner; inheritedTeardownDigest?: string; forceKill: (pid: number) => void };

const CONNECTED_STOP_PROBE_MS = 2000;
export const unsupportedConnectedStop = () => new ProxyOwnershipRefusedError(
  "Connected-client stop refused: runtime identity, saved connection ownership, shutdown preservation or safe runtime absence could not be verified. No process was stopped by this check. Inspect 'ocx service status', repair saved connection ownership or update/restart an incompatible runtime through its supervisor, then retry. Use 'ocx disconnect' only if you intend to release those integrations.",
  "connected_client_stop_unsupported",
);

export function unclassifiedStopTarget(pid: number): ProxyOwnershipRefusedError {
  return new ProxyOwnershipRefusedError(
    `Stop refused: could not verify that live OpenCodex PID ${pid} is standalone. Run 'ocx service status' to identify its supervisor, or check the terminal that started it. Repair its runtime or saved Link records, then retry 'ocx stop'.`,
    "connected_client_stop_unsupported",
  );
}

export function stopOwnershipRefused(error: ProxyOwnershipRefusedError): StopOutcome {
  console.error(error.message);
  process.exitCode = 1;
  return { ok: false, summary: { schema: "ocx-stop/1", ok: false, outcome: "failed", exitCode: 1,
    runtimeDown: false, service: "absent", proxy: "ownership-refused", sharedTeardown: "skipped", message: error.message } };
}

export function isRegisteredServiceStopTarget(pid: number): boolean {
  try {
    assertServiceEnvironmentMatchesInstall();
    const manager = inspectGuardedManagerTarget(pid, installedServiceListenPort());
    return (manager.kind === "bound" || manager.kind === "bound-stray") && manager.pid === pid;
  } catch { return false; }
}

function legacyLinkStopRefusal(): ProxyOwnershipRefusedError {
  return new ProxyOwnershipRefusedError(
    "Connected-client stop refused: this older Link Child has no stop fence. No process was stopped. To update/restart while keeping the Home connection: close Codex, Grok and other routed clients. Stop the old owner: press Ctrl+C in its foreground terminal, use Stop and quit its Desktop supervisor, or run the old installation's 'ocx stop' for a background service (including Task Scheduler). Once it is down, run the current installation's 'ocx stop' with the same OPENCODEX_HOME and client homes to clean up file routes. Keep clients closed until cleanup succeeds. Then run 'ocx start' (or 'ocx service start' for an installed service, or open the updated Desktop app) and run 'ocx sync --restart-codex'.",
    "connected_client_stop_unsupported",
  );
}

export function verifyConnectedStopTarget(
  proof: StopTargetProof | undefined, linkStop: LinkStopPreflight | undefined, pid?: number,
): void {
  const state = readClientConnectionState();
  if (state.kind === "invalid" || state.kind === "mismatched") throw unsupportedConnectedStop();
  if (pid !== undefined && pid !== proof?.target.pid) throw unsupportedConnectedStop();
  if (state.kind === "connected" && state.value.transport === "link" && !linkStop && !proof?.siblingOnly) throw unsupportedConnectedStop();
  if (proof && isProcessAlive(proof.target.pid)) proof.verify();
  const currentPid = readAlivePid();
  if (currentPid !== null && currentPid !== proof?.target.pid) throw unsupportedConnectedStop();
}

function hasClientRuntimeEvidence(runtime: RuntimePortState): boolean {
  return runtime.role === "client" || runtime.clientLinkOwner !== undefined || runtime.servingGeneration !== undefined
    || runtime.clientStopping === true || runtime.clientStopOwner !== undefined;
}

/** A discovery miss cannot establish the role of a live tracked process. */
export async function classifyStopRole(
  connection: ClientConnectionState, runtime: RuntimePortState | null, receipts: readonly OutstandingTeardown[],
): Promise<"connected" | "standalone" | "unknown"> {
  const sibling = runtime?.siblingOfPort;
  if (connection.kind === "connected" && (connection.value.transport === "link" || sibling === undefined)) return "connected";
  if (connection.kind === "mismatched" || receipts.some(read => read.state === "valid" && read.receipt.ownerStartTime !== undefined)) return "connected";
  const { readRouteIntentReceipt } = await import("../integrations/route-intent-state");
  if (readRouteIntentReceipt()?.linkId !== undefined) return "connected";
  if (runtime && isProcessAlive(runtime.pid)) {
    if (hasClientRuntimeEvidence(runtime)) return "connected";
    if (runtime.attestationSecret) {
      const capability = await assertConnectedClientStopSupported(runtime, { healthOnly: true }).catch(() => null);
      if (capability) return capability.linkStopFence || capability.nativeClient ? "connected" : "standalone";
    }
  }
  // Classification needs only the reported role. The preflight must verify identity itself.
  const live = await findLiveProxy({ attempts: 1, verifyPidFn: () => null }).catch(() => null);
  return live?.role === "client" && live.port !== sibling ? "connected" : "unknown";
}

function readStopDirectoryIdentity(path: string | undefined): FileIdentity | undefined {
  if (!path) return;
  try {
    const stat = statSync(path, { bigint: true });
    if (stat.isDirectory()) return stat;
  } catch { /* An unreadable directory cannot establish identity. */ }
}

/** Called after role discovery yields no affirmative result. Never adopts an orphan PID. */
export async function proveStandaloneStopRecord(
  runtime: RuntimePortState | null, pid: number, receipts: readonly OutstandingTeardown[],
): Promise<(() => void) | undefined> {
  if (runtime?.pid !== pid || hasClientRuntimeEvidence(runtime)
    || receipts.some(read => read.state !== "valid" || read.receipt.ownerStartTime !== undefined)) return;
  const { readRouteIntentReceiptStrict } = await import("../integrations/route-intent-state");
  const hasNoLinkReceipt = () => {
    try { return readRouteIntentReceiptStrict()?.linkId === undefined; } catch { return false; }
  };
  if (!hasNoLinkReceipt()) return;
  const { isLegacyWindowsStartCommandLine, readClientStopProcessStart, readLegacyStopProcessHome } = await import("../client/stop-teardown-owner");
  const start = readClientStopProcessStart(pid);
  if (!start) return;
  let legacyHomeIsCurrent: (() => boolean) | undefined;
  if (runtime.startTime !== undefined) {
    if (runtime.startTime !== start) return;
  } else {
    const command = readProcessCommandLine(pid);
    if (!command) return;
    const windows = process.platform === "win32";
    // CIM does not expose the environment. Windows uses the SID-checked creation
    // identity above, exact start argv and ownership of the recorded bind instead.
    if (windows) {
      if (!isLegacyWindowsStartCommandLine(command)) return;
    } else {
      if (!isOcxStartCommandLine(command)) return;
      const home = readStopDirectoryIdentity(getConfigDir());
      if (!home) return;
      const matchesHome = (path: string | undefined) => {
        const identity = readStopDirectoryIdentity(path);
        return identity !== undefined && sameFileIdentity(identity, home);
      };
      legacyHomeIsCurrent = () => matchesHome(readLegacyStopProcessHome(pid)) && matchesHome(getConfigDir());
      if (!legacyHomeIsCurrent()) return;
    }
    const { inspectIpv4LoopbackListener, ownsLegacyStopBind, scanListenPidsForAddress } = await import("../server/port-reclaim");
    const bind = runtime.hostname?.trim().replace(/^\[(.*)\]$/, "$1");
    const wildcard = bind === "0.0.0.0" || bind === "::";
    const address = windows || wildcard
      ? (bind && bind.toLowerCase() !== "localhost" ? bind : "127.0.0.1")
      : gracefulStopHost(runtime.hostname).replace(/^\[(.*)\]$/, "$1");
    if (windows || wildcard) {
      if (!await ownsLegacyStopBind(runtime.port, pid, address)) return;
    } else if (address === "127.0.0.1") {
      if ((await inspectIpv4LoopbackListener(runtime.port, pid)).kind !== "match") return;
    } else {
      const listeners = scanListenPidsForAddress(runtime.port, address);
      if (!listeners.ok || listeners.pids.length !== 1 || listeners.pids[0] !== pid) return;
    }
    if (readClientStopProcessStart(pid) !== start || legacyHomeIsCurrent?.() === false) return;
  }
  return () => {
    if (readClientConnectionState().kind !== "disconnected" || !hasNoLinkReceipt()) throw unsupportedConnectedStop();
    if (isProcessAlive(pid) && (readClientStopProcessStart(pid) !== start
      || !Bun.deepEquals(readRuntimePort(pid), runtime, true) || legacyHomeIsCurrent?.() === false)) throw unclassifiedStopTarget(pid);
  };
}

// A guessed endpoint can name a standalone teardown obligation but cannot direct POST.
export function configuredStopEndpoint(): { hostname: string; port: number } {
  try {
    const config = loadConfig();
    return {
      hostname: config.hostname ?? "127.0.0.1",
      port: typeof config.port === "number" && config.port > 0 ? config.port : 10100,
    };
  } catch {
    return { hostname: "127.0.0.1", port: 10100 };
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
  target: ConnectedStopTarget | null, options: { requireLinkStopFence?: boolean; healthOnly?: boolean } = {},
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
  const readDocument = async (response: Response, allowFenced = false): Promise<Record<string, unknown> | null> => {
    if (!response.ok && !(allowFenced && response.status === 503)) { void response.body?.cancel().catch(() => {}); return null; }
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
    const health = await readDocument(response, options.healthOnly);
    if (!response.ok && (!health || !isPackageTreeFencedHealthz(health))) throw unsupportedConnectedStop();
    if (!readPinnedRuntime() || health?.service !== "opencodex" || health.pid !== target.pid) throw unsupportedConnectedStop();
    const linkStopFence = health.linkStopFence === true;
    if (options.requireLinkStopFence && !linkStopFence) throw unsupportedConnectedStop();
    // A native listener proves its contract on health and has no /api/stop route.
    if (health.role === "client") return { linkStopFence, nativeClient: true };
    if (health.role !== undefined) throw unsupportedConnectedStop();
    if (options.healthOnly) return { linkStopFence, nativeClient: false };
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
  inheritedTeardowns?: readonly LinkInheritedTeardown[],
  onLinkStop?: (preflight: LinkStopPreflight) => void,
  onTarget?: (proof: StopTargetProof) => void,
  siblingOfPort?: number,
): Promise<StopOutcome | "already-stopped" | null> {
  try {
    const connection = readClientConnectionState();
    if (connection.kind === "invalid" || connection.kind === "mismatched") throw unsupportedConnectedStop();
    let target = approved;
    if (!target) {
      const trackedPid = readPid() ?? readAlivePid();
      const runtime = readRuntimePort();
      const pid = trackedPid ?? (runtime?.servingGeneration ? runtime.pid : undefined);
      if (pid && (trackedPid === pid || isProcessAlive(pid))) {
        if (runtime?.pid !== pid) throw unsupportedConnectedStop();
        target = { ...runtime, pid };
      } else {
        const live = await findLiveProxy({ acceptPackageTreeFenced: true, attempts: 1 });
        if (live && live.port !== siblingOfPort) {
          if (!live.pid) throw unsupportedConnectedStop();
          target = { ...live, pid: live.pid };
        } else {
          if (runtime && isProcessAlive(runtime.pid)) throw unsupportedConnectedStop();
          const config = loadConfig();
          const endpoints = [...(runtime ? [runtime] : []),
            ...(config.port === 0 || config.port === siblingOfPort ? [] : [{ port: config.port, hostname: config.hostname }])];
          const clientMayRemain = connection.kind !== "disconnected" || runtime?.clientLinkOwner !== undefined
            || runtime?.servingGeneration !== undefined;
          const manager = await observeGuardedManagerStopped({ kind: "absent" });
          const offlineForegroundLink = manager === "unknown"
            && connection.kind === "connected" && connection.value.transport === "link"
            && (await import("../service/systemd")).systemdInstallationAbsent();
          if ((clientMayRemain && endpoints.length === 0)
            || (manager !== "inactive" && !offlineForegroundLink)) throw unsupportedConnectedStop();
          for (const endpoint of endpoints) {
            if (await probeEndpointLiveness(endpoint) !== "dead") throw unsupportedConnectedStop();
          }
          return "already-stopped";
        }
      }
    }
    if (!isProcessAlive(target.pid)) throw unsupportedConnectedStop();
    const stopTarget = target;
    const pinned = readRuntimePort(target.pid);
    const standaloneSibling = siblingOfPort !== undefined && pinned?.siblingOfPort === siblingOfPort
      && pinned.clientLinkOwner === undefined && pinned.servingGeneration === undefined;
    const savedLink = connection.kind === "connected" && connection.value.transport === "link";
    const publishedLink = pinned?.clientLinkOwner != null;
    const clientRecord = pinned?.servingGeneration !== undefined || pinned?.clientLinkOwner !== undefined;
    const { readClientStopProcessStart } = await import("../client/stop-teardown-owner");
    const targetStart = savedLink || clientRecord ? readClientStopProcessStart(target.pid) : undefined;
    if ((savedLink || clientRecord) && !targetStart) throw unsupportedConnectedStop();
    const capability = await assertConnectedClientStopSupported(target, { healthOnly: connection.kind === "disconnected" || standaloneSibling });
    const sameStart = () => targetStart === undefined || readClientStopProcessStart(stopTarget.pid) === targetStart;
    const checkPinnedRecord = (afterTerm?: RuntimePortState) => {
      const current = readRuntimePort(stopTarget.pid);
      if (!Bun.deepEquals(current, pinned, true) && !(afterTerm && Bun.deepEquals(current, afterTerm, true))) throw unsupportedConnectedStop();
    };
    const checkPinnedTarget = (afterTerm?: RuntimePortState) => {
      checkPinnedRecord(afterTerm);
      if (!sameStart()) throw unsupportedConnectedStop();
    };
    // Attestation is read-only. Check the record now and the process again at the
    // first write, manager stop or signal boundary that uses this proof.
    checkPinnedRecord();
    if (!capability) throw unsupportedConnectedStop();
    if (standaloneSibling && !capability.nativeClient && !capability.linkStopFence) {
      onTarget?.({ target, verify: checkPinnedTarget, siblingOnly: true });
      return null;
    }
    if (savedLink && capability.nativeClient && !capability.linkStopFence && pinned?.clientLinkOwner === undefined) {
      throw legacyLinkStopRefusal();
    }
    if (savedLink || publishedLink || capability.linkStopFence) {
      if (!capability.linkStopFence || !targetStart) throw unsupportedConnectedStop();
      const link = connection.kind === "connected" && linkStopConnectionOwner(connection.value);
      if (!link || pinned?.clientLinkOwner !== link) throw unsupportedConnectedStop();
      if (siblingOfPort !== undefined || pinned.siblingOfPort !== undefined) {
        if (siblingOfPort === undefined || pinned.siblingOfPort !== siblingOfPort || !capability.nativeClient
          || !pinned.servingGeneration) throw unsupportedConnectedStop();
        const { terminateAttestedClient } = await import("./stop-client-process");
        const stopping = { ...pinned, clientStopping: true as const };
        const verify = (phase?: "after-term") => {
          checkPinnedTarget(phase === "after-term" ? stopping : undefined);
          const current = readClientConnectionState();
          if (current.kind !== "connected" || linkStopConnectionOwner(current.value) !== link) throw unsupportedConnectedStop();
        };
        // The sibling owns its listener only. Keep shared routing and teardown with the owner.
        onTarget?.({ target, verify, siblingOnly: true, terminateSibling: () => terminateAttestedClient(stopTarget.pid, targetStart, verify) });
        return null;
      }
      if (loadConfig().port !== target.port) throw unsupportedConnectedStop();
      // A native Child has no /api/stop refusal: SIGTERM can escalate to SIGKILL.
      // Refuse known inherited restore blockers before any manager or kill step.
      const { inheritedTeardownDigest, readLinkInheritedTeardowns } = await import("../client/stop-native-handoff");
      const normalizeHost = (value: string | undefined) => (value ?? "127.0.0.1").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
      const verifiedForeign: Buffer[] = [];
      for (const read of inheritedTeardowns ?? readLinkInheritedTeardowns()) {
        if (read.state === "valid" && read.receipt.endpointSource === "exact") {
          const endpoint = read.receipt.endpoint;
          if (endpoint.port === target.port && normalizeHost(endpoint.hostname) === normalizeHost(target.hostname)) continue;
          if (read.bytes && await probeEndpointLiveness(endpoint) === "dead") {
            verifiedForeign.push(read.bytes);
            continue;
          }
        }
        throw new ProxyOwnershipRefusedError("Link Child native teardown preflight refused: pending recovery evidence would prevent native restoration. No process was stopped; repair that evidence, then retry ocx stop.", "link_native_teardown_refused");
      }
      // A manager can kill the Child before its signal handler runs. Drain these file routes
      // first, under an exact runtime fence; refusal must return before any manager/kill step.
      if (!pinned?.attestationSecret || !Bun.deepEquals(readRuntimePort(target.pid), pinned, true)) throw unsupportedConnectedStop();
      const { finishClientRuntimeStop, markClientRuntimeStopping, markClientRuntimeStoppingWithRetry } = await import("../client/sync-runtime");
      const { restoreLinkFileRouting } = await import("../client/stop-file-routing");
      const startTime = readClientStopProcessStart(process.pid);
      if (!startTime) throw unsupportedConnectedStop();
      const owner = { pid: process.pid, startTime, nonce: randomBytes(16).toString("hex") };
      const identity = { pid: target.pid, port: target.port, attestationSecret: pinned.attestationSecret };
      // The CLI holds its ownership mutation lease through this finalizer. A retained listener
      // can distinguish a finished stop from one still about to call a manager or kill fallback.
      onFence(async () => {
        const finished = await markClientRuntimeStoppingWithRetry(identity, { mark: () => {
          if (sameStart()) finishClientRuntimeStop(identity, owner);
        } });
        if (!finished) console.warn("The retained Child's stop state could not be finalized; repair its runtime record before retrying recovery.");
      });
      const stopping = { ...pinned, clientStopping: true, clientStopRequested: true, clientStopOwner: owner };
      const checkRuntime = () => {
        if (!sameStart() || !Bun.deepEquals(readRuntimePort(identity.pid), stopping, true)) throw new Error("client_runtime_changed");
      };
      const fenced = await markClientRuntimeStoppingWithRetry(identity, {
        mark: () => stopRestoreWriteGuard(connection.value).run(() => {
          const current = readRuntimePort(identity.pid);
          if (!sameStart() || (!Bun.deepEquals(current, pinned, true) && !Bun.deepEquals(current, stopping, true))) throw new Error("client_runtime_changed");
          // The marker is checked by every sync commit, including already admitted work.
          markClientRuntimeStopping(identity, owner);
        }),
      });
      try {
        if (!fenced) throw new Error("the runtime sync fence could not be verified");
        await restoreLinkFileRouting(connection.value, { beforeWrite: checkRuntime });
        const { terminateAttestedClient } = await import("./stop-client-process");
        const guard = stopRestoreWriteGuard(connection.value);
        const verify = () => {
          try { guard.run(() => {
            checkRuntime();
            if (loadConfig().port !== identity.port) throw new Error("client_route_port_changed");
          }); }
          catch { throw unsupportedConnectedStop(); }
        };
        onTarget?.({ target, verify });
        onLinkStop?.({ target, owner, inheritedTeardownDigest: inheritedTeardownDigest(verifiedForeign), verify, forceKill: pid => {
          if (pid !== stopTarget.pid) throw unsupportedConnectedStop();
          terminateAttestedClient(pid, targetStart, verify);
        } });
      } catch (error) {
        throw new ProxyOwnershipRefusedError(`Link Child file routing restore refused: ${error instanceof Error ? error.message : "restoration failed"}. No process was stopped. ${fenced ? "Sync remains fenced; " : ""}repair the client configuration or ownership evidence, then retry ocx stop.`, "link_file_restore_refused");
      }
    } else if (capability.nativeClient && (connection.kind !== "connected" || pinned?.clientLinkOwner !== null)) {
      // Older native listeners cannot distinguish Hub from Link once the saved connection drifts.
      throw unsupportedConnectedStop();
    } else {
      if (connection.kind === "disconnected" && clientRecord) throw unsupportedConnectedStop();
      onTarget?.({ target, verify: checkPinnedTarget });
    }
    return null;
  } catch (cause) {
    return stopOwnershipRefused(cause instanceof ProxyOwnershipRefusedError ? cause : unsupportedConnectedStop());
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

async function hasLinkFileRouteEvidence(): Promise<boolean> {
  const { readRouteIntentReceiptStrict } = await import("../integrations/route-intent-state");
  const { homeRouteIntentPath } = await import("../client/link-home");
  try { lstatSync(homeRouteIntentPath()); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return readRouteIntentReceiptStrict()?.linkId !== undefined;
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
  try {
    const connection = readClientConnectionState();
    if (connection.kind === "connected" && connection.value.transport === "link") {
      const { restoreLinkFileRouting } = await import("../client/stop-file-routing");
      await restoreLinkFileRouting(connection.value);
    } else if (await hasLinkFileRouteEvidence()) {
      throw new Error("Link route receipts remain. Repair the saved Link ownership and rerun 'ocx stop' before reopening clients.");
    }
  } catch (error) {
    if (error instanceof StopRestoreOwnershipError) {
      if (error.boundary === "unproven") return { historyOnly, historyDeferred, other, boundary: error.boundary };
      // A concurrent Hub connection can supersede native teardown. A surviving Link file
      // receipt still needs recovery and must not be silently settled with the native receipt.
      if (!await hasLinkFileRouteEvidence().catch(() => true)) return { historyOnly, historyDeferred, other, boundary: error.boundary };
    }
    console.error(`⚠️  Link Child file routing restore failed: ${error instanceof Error ? error.message : "ownership could not be verified"}`);
    return { historyOnly, historyDeferred, other: true };
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
