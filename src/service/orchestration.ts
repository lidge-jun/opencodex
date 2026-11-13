import { findLiveProxy, proveLiveProxyOwnedByHome, proxyIdentityAt, SERVICE_STOP_LIVENESS } from "../server/proxy-liveness";
import { existsSync, unlinkSync } from "node:fs";
import { durableBunRuntime, type DurableBunRuntime } from "../lib/bun-runtime";
import { assertSelectedRuntimeWritable, type RuntimePreflightDeps } from "../lib/bun-runtime-preflight";
import { getConfigDir } from "../config";
import { readPid, readRuntimePort, removePid, removeRuntimePort, verifyPidIdentity } from "../config/process-state";
import { isWslRuntime } from "../codex/home";
import { isProcessAlive, stopProxy } from "../lib/process-control";
import { randomUUID } from "node:crypto";
import { startWinswService, stopWinswService, statusWinswRaw, uninstallWinswService, WINSW_SERVICE_ID, winswExePath, winswStatusSummary, type WinswStatus } from "../lib/winsw";
import { queryWinswBinaryPathName, scBinaryPathNamesExecutable } from "../service-manager-probe";
import { diagnoseService } from "./diagnostics";
import { assertServiceEnvironmentMatchesInstall } from "./guards";
import { runLaunchctl, launchdEvictionTargets, launchctlBootoutBenign, probeLaunchdLoadState, installLaunchd, startLaunchd, stopLaunchd, statusLaunchd, uninstallLaunchd } from "./launchd";
import { assertSchedulerRegistrationBeforeStart } from "./repair";
import { SERVICE_MANAGED_ENV, TASK, plistPath, removeServiceInstallStateRecords, writeServiceInstallState } from "./state";
import type { ServiceBackend } from "./state";
import { unitPath, isSystemd, installSystemd, startSystemd, stopSystemd, statusSystemd, uninstallSystemd, systemdServiceInstallCleanupOps } from "./systemd";
import { writeWindowsSchedulerAssets, stageWindowsSchedulerRegistrationXml, removeWindowsSchedulerRegistrationStage, registerFreshWindowsSchedulerTask, recordWindowsSchedulerOwnership, removeNativeWindowsServiceForScheduler, commitWindowsInstall, commitWindowsNativeInstall, type WindowsServiceInstallDeps, startWindows, isWindowsSchedulerEndBenign, stopWindows, statusWindows, statusWindowsXml, uninstallWindows } from "./windows-ops";
import type { WindowsCheckedStopResult } from "./windows-checked-stop";
import { WINDOWS_STOP_CAPS } from "./windows-stop-budget";
import type { WindowsStopConfirmResult } from "./windows-stop-confirm";
import { claimPendingTeardown, clearPendingTeardown, type PendingTeardownReceipt } from "../config/pending-teardown";
import { probeEndpointLiveness, type EndpointLiveness } from "../server/proxy-liveness";
import type { ProbeEndpoint } from "../cli/uninstall-plan";
import { confirmWindowsServiceStop, describeWindowsPartA, describeWindowsPartB, endpointsAllDead, runWindowsServiceStopPartA, serviceStopOutcomeFromWindows, windowsPartARecord, windowsRemovalEndpoints, windowsServiceStopPort, windowsStopAdmission, windowsStopRemainingMs, type WindowsPartARequest } from "./windows-service-stop";
import { schtasks, probeWindowsSchedulerTask, rollbackWindowsSchedulerTaskOwnedByAttempt, settleDelay } from "./windows-scheduler";
import type { WindowsSchedulerTaskProbe } from "./windows-scheduler";
import { windowsTaskRegistrationOwnedByAttempt, windowsTaskRegistrationHealthy } from "./windows-taskxml";
import { win32 } from "node:path";
import { launchdGuiDomain } from "./launchd";
import { LABEL } from "./state";
import { assertNoDesktopSupervision, createSupervisionLatch, type SupervisionInspector, type SupervisionLatch } from "./desktop-command-guard";
import type { HeldRestartReceipt } from "./restart-proxy-stop";
import { readClientConnectionState } from "../client/state";

type ServiceOps = {
  install: (runtime: DurableBunRuntime) => void | Promise<void>; start: () => void; stop: () => void;
  status: () => string; uninstall: () => void;
};

export type ServiceInstallCleanupOps = {
  status: () => string | null;
  stop: () => void;
};

export function platformOps(backend: ServiceBackend = "scheduler", deps: { platform?: NodeJS.Platform; windowsInstall?: WindowsServiceInstallDeps } = {}): ServiceOps | null {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin")
    // Wrapped, not passed: `installLaunchd` reports whether it reloaded launchd, and only
    // `repairService` (for the `restart` verb) has any use for that. `ServiceOps.install` is
    // the generic install seam and deliberately promises nothing about a return value.
    return { install: () => { installLaunchd(); }, start: startLaunchd, stop: stopLaunchd, status: statusLaunchd, uninstall: uninstallLaunchd };
  if (platform === "win32") {
    if (backend === "native")
      return { install: runtime => commitWindowsNativeInstall(runtime, deps.windowsInstall), start: startWinswService, stop: stopWinswService, status: winswStatusSummary, uninstall: uninstallWinswService };
    return { install: runtime => commitWindowsInstall(runtime, deps.windowsInstall), start: startWindows, stop: stopWindows, status: statusWindows, uninstall: uninstallWindows };
  }
  if (platform === "linux") {
    if (existsSync("/.dockerenv")) {
      console.error("Docker detected. Run 'ocx start' directly instead of using the service manager.");
      process.exit(1);
    }
    if (!isSystemd() && !existsSync(unitPath())) {
      console.error("systemd not found. Run 'ocx start' under your process supervisor.");
      if (isWslRuntime()) {
        console.error("WSL detected: enable systemd by adding [boot] systemd=true to /etc/wsl.conf, then run 'wsl --shutdown' from Windows and reopen the distro (WSL 0.67.6+).");
      }
      process.exit(1);
    }
    return { install: installSystemd, start: startSystemd, stop: stopSystemd, status: statusSystemd, uninstall: uninstallSystemd };
  }
  return null;
}

/**
 * Install-only manager operations. Unlike the ordinary status/stop helpers, these
 * distinguish confirmed absence from a failed manager query and propagate every
 * non-benign stop failure. Installing new assets is unsafe while either answer is
 * unknown because an old manager may still respawn a listener on the target port.
 */
function platformServiceInstallCleanupOps(backend: ServiceBackend): ServiceInstallCleanupOps | null {
  if (process.platform === "darwin") {
    return {
      // Same probe as `diagnoseService`, so the two answers to one question can no longer
      // have opposite failure semantics: this one used to throw on a launchctl error while
      // `statusLaunchd` swallowed it into "absent". Installing over an unverifiable
      // manager is the unsafe case, so `unknown` fails closed here.
      status: () => {
        const probe = probeLaunchdLoadState();
        if (probe.state === "unknown") {
          throw new Error(`launchd job status could not be verified: ${probe.detail ?? "launchctl could not be asked"}`);
        }
        return probe.state === "not-loaded" ? null : `${LABEL} loaded in ${probe.domain ?? launchdGuiDomain()}`;
      },
      // `unload` is legacy and CANNOT evict a gui-domain job, which is what this cleanup
      // exists to do before new assets are installed. Both user domains, because the probe
      // above reports `user/<uid>` too: a gui-only bootout exits 3 against one of those,
      // which this function would have read as "already stopped" and installed over a live
      // job (see `launchdEvictionTargets`).
      stop: () => {
        for (const target of launchdEvictionTargets()) {
          const booted = runLaunchctl(["bootout", target]);
          if (launchctlBootoutBenign(booted.status)) continue;
          throw new Error(`launchctl bootout ${target} failed: ${booted.stderr || `exit ${String(booted.status)}`}`);
        }
      },
    };
  }
  if (process.platform === "win32") {
    if (backend === "native") {
      return {
        status: () => {
          const status = statusWinswRaw();
          if (status === "unknown") throw new Error("Native service status could not be verified.");
          return status === "nonexistent" ? null : status;
        },
        stop: stopWinswService,
      };
    }
    return {
      status: () => {
        const probe = probeWindowsSchedulerTask(TASK);
        if (probe.status === "unknown") throw new Error(`Task Scheduler status could not be verified: ${probe.detail}`);
        return probe.status === "present" ? "present" : null;
      },
      stop: () => {
        try {
          schtasks(["/end", "/tn", TASK]);
        } catch (error) {
          if (!isWindowsSchedulerEndBenign(error)) throw error;
        }
      },
    };
  }
  if (process.platform === "linux") {
    // `list-unit-files <name>` exits non-zero when the unit has never been
    // installed, which made a clean first install look like an unknown manager
    // failure. `show LoadState` gives us the tri-state we actually need: a
    // healthy user manager returns `not-found` for a missing unit, while an
    // unreachable/permission-denied manager still makes `sh()` throw and the
    // caller therefore fails closed.
    return systemdServiceInstallCleanupOps();
  }
  return null;
}

type TrackedProxyCleanupResult = "none" | "stale" | "stopped";

function verifiedKillTarget(pid: number | null | undefined): number | null {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const verified = verifyPidIdentity(pid);
  return verified === pid ? verified : null;
}

/**
 * Whether a proxy is still answering after the service manager claimed to stop it.
 *
 * `ops.stop()` reports the outcome of the STOP COMMAND, not of the process. A Windows scheduler
 * task whose wrapper survives `schtasks /end` respawns its child a few seconds later, so a stop
 * that returned success can still leave a live proxy — and `ocx service stop` then restored
 * native Codex on top of a running one (#764). The tracked-pid cleanup does not catch it either:
 * the respawned child writes a different pid, or none this process knows about.
 *
 * Probed rather than assumed, and bounded. The respawn risk is specific to a supervisor that can
 * restart its child — the Windows scheduler wrapper — so only that case pays the restart window.
 * Everywhere else a single probe answers the question, because nothing is going to bring the
 * proxy back after `launchctl unload` or `systemctl stop`. Making every platform wait 7s on a
 * stop that already succeeded would trade one bug for a worse everyday one.
 */
export async function proxyStillLiveAfterStop(deps: {
  findProxy?: () => Promise<{ port: number } | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Whether the stopped supervisor can respawn its child; only then is polling worth the wait. */
  canRespawn?: boolean;
} = {}): Promise<{ port: number } | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const canRespawn = deps.canRespawn ?? process.platform === "win32";
  const deadline = now() + (canRespawn ? 7000 : 0);
  // Single-shot (non-respawn) still needs one full SERVICE_STOP_LIVENESS budget; respawn
  // polling shares the outer deadline so multi-candidate discovery cannot overrun it.
  const findProxy = deps.findProxy ?? (() => {
    const probeDeadline = canRespawn
      ? deadline
      : now() + (SERVICE_STOP_LIVENESS.timeoutMs! * SERVICE_STOP_LIVENESS.attempts! + 250);
    // A package-tree-fenced proxy (#5496) still holds the port; stop must not call it gone.
    return findLiveProxy({ ...SERVICE_STOP_LIVENESS, deadlineAt: probeDeadline, nowFn: now, acceptPackageTreeFenced: true });
  });
  for (;;) {
    try {
      const live = await findProxy();
      if (live) return live;
    } catch {
      // A probe failure is not proof the proxy is gone; keep polling until the deadline.
    }
    if (now() >= deadline) return null;
    await sleep(1000);
  }
}

/**
 * How long orphan discovery may take when the caller does not name a cap.
 *
 * Seven seconds is the legacy multi-candidate window. It stays the default so macOS and
 * Linux stops behave exactly as before; a Windows caller that admitted a budget
 * (030 "Time budget") passes its own 3 s cap instead.
 */
export const DEFAULT_ORPHAN_DISCOVERY_MS = 7_000;

type TrackedProxyStop = (pid: number, endpoint: { hostname: string; port: number } | null) => Promise<unknown>;

/** How the tracked proxy is stopped: the deferral receipt and the Windows port wait. */
export interface TrackedProxyStopIo {
  /** Pre-resolved Windows target; null means there is no child to stop. */
  target?: TrackedProxyTarget | null;
  /** ocx service stop on Windows: the claimed receipt, so the proxy defers its teardown. */
  deferSharedTeardownNonce?: string;
  /** Part B follows and owns the port wait (030), so stopProxy skips its own. */
  skipPortWait?: boolean;
  /**
   * Cap on the identity-checked orphan discovery that follows the tracked stop.
   *
   * The checked Windows stop admits `WINDOWS_STOP_CAPS.orphanDiscovery` (3 s) for this step
   * (030 "Time budget"), and Part B runs inside the same deadline: discovery that spent the
   * legacy 7 s would overrun the budget admission had just proven. Omitted keeps 7 s.
   */
  orphanDiscoveryCapMs?: number;
  /** Replaces the plain stop of each target (the scheduler restart's receipt-backed, attested stop). */
  stop?: TrackedProxyStop;
  /** Throw when a proxy still answers that this home cannot verify, instead of leaving it alone silently. */
  refuseUnverifiedLive?: boolean;
}

export interface TrackedProxyTarget {
  pid: number;
  endpoint: { hostname: string; port: number } | null;
}

/** Resolve once before claiming a receipt, so its endpoint is the stop's endpoint. */
export async function resolveTrackedProxyTarget(): Promise<TrackedProxyTarget | null> {
  const pid = verifiedKillTarget(readPid());
  if (pid !== null && isProcessAlive(pid)) {
    const runtime = readRuntimePort(pid);
    return { pid, endpoint: runtime?.port ? { hostname: runtime.hostname ?? "127.0.0.1", port: runtime.port } : null };
  }
  const live = await findLiveProxy({ ...SERVICE_STOP_LIVENESS, deadlineAt: Date.now() + WINDOWS_STOP_CAPS.orphanDiscovery, acceptPackageTreeFenced: true });
  if (!live) return null;
  const livePid = verifiedKillTarget(live.pid);
  if (livePid === null) throw new Error("A live proxy was found but its process identity could not be verified.");
  return { pid: livePid, endpoint: { hostname: live.hostname ?? "127.0.0.1", port: live.port } };
}

export async function stopTrackedProxyIfRunning(io: TrackedProxyStopIo = {}): Promise<TrackedProxyCleanupResult> {
  if (io.target !== undefined) {
    if (!io.target) return "none";
    await stopProxy(io.target.pid, { ...io, ...(io.target.endpoint ? { runtimeEndpoint: io.target.endpoint } : {}) });
    removePid(io.target.pid);
    removeRuntimePort(io.target.pid);
    return "stopped";
  }
  let stopped = false;
  const pid = readPid();
  const trackedKillPid = verifiedKillTarget(pid);
  if (trackedKillPid !== null && isProcessAlive(trackedKillPid)) {
    if (io.stop) await io.stop(trackedKillPid, null);
    else await stopProxy(trackedKillPid, io);
    removePid(trackedKillPid);
    removeRuntimePort(trackedKillPid);
    stopped = true;
  } else if (pid) {
    removePid(pid);
    removeRuntimePort(pid);
  }
  // Orphan recovery: the pid file can be missing/stale while the service wrapper keeps
  // a live proxy running — mirror `ocx stop`'s identity-checked findLiveProxy fallback.
  // Cap multi-candidate discovery so stop cleanup cannot hang for three full retry budgets,
  // and let a caller that admitted a budget name its own cap (#7771).
  const live = await findLiveProxy({
    ...SERVICE_STOP_LIVENESS,
    deadlineAt: Date.now() + (io.orphanDiscoveryCapMs ?? DEFAULT_ORPHAN_DISCOVERY_MS),
    acceptPackageTreeFenced: true,
  });
  const liveKillPid = verifiedKillTarget(live?.pid);
  if (live && liveKillPid !== null) {
    if (io.stop) await io.stop(liveKillPid, { hostname: live.probeHostname ?? live.hostname ?? "127.0.0.1", port: live.port });
    else await stopProxy(liveKillPid, io);
    removePid(liveKillPid);
    removeRuntimePort(liveKillPid);
    stopped = true;
  } else if (live && io.refuseUnverifiedLive) {
    throw new Error("A proxy still answers for this home, but its process could not be verified as this home's proxy, so it was not stopped.");
  }
  if (stopped) return "stopped";
  if (pid) return "stale";
  return "none";
}

/**
 * The tracked-proxy stop of a scheduler restart (#8416): receipt-backed, so the proxy's own respawn
 * refusal does not apply to the restart that verifies the window, and refusing an unverifiable
 * survivor so the caller can stop before it removes the wrappers that supervise it.
 */
export async function stopTrackedProxyForServiceRestart(
  hold: (receipt: HeldRestartReceipt) => void,
  deps: { linkChild?: () => boolean } = {},
): Promise<TrackedProxyCleanupResult> {
  const { stopProxyForServiceRestart } = await import("./restart-proxy-stop");
  // Re-decided before every stop, not only before the restart began: a Link connection or a Child
  // that started meanwhile must not be stopped through a deferral that keeps its route.
  assertNotLinkChildForRestart(deps.linkChild);
  return stopTrackedProxyIfRunning({
    stop: async pid => { assertNotLinkChildForRestart(deps.linkChild); return stopProxyForServiceRestart(pid, hold); },
    refuseUnverifiedLive: true,
  });
}

const LINK_CHILD_RESTART_REFUSAL = "Nothing was changed, and this Child keeps serving under its existing task. 'ocx service restart' does not restart a Child connected over a Remote Link under Task Scheduler: "
  + "stopping its proxy keeps Codex routed to the Child's unauthenticated loopback port, which another local process could take if the restart then failed.";

function linkChildConnected(read?: () => boolean): boolean {
  try {
    return (read ?? (() => {
      const state = readClientConnectionState();
      return state.kind === "connected" && state.value.transport === "link";
    }))();
  } catch {
    throw new Error("The client connection state could not be read, so the restart cannot tell whether this is a linked Child; nothing was stopped.");
  }
}

function assertNotLinkChildForRestart(read?: () => boolean): void {
  if (linkChildConnected(read)) throw new Error(LINK_CHILD_RESTART_REFUSAL);
}

/**
 * Whether a replacement serves the endpoint a scheduler restart's receipt names. Client routing
 * still names that endpoint, so only this home's freshly published runtime record counts: it must
 * name that port and a pid other than the stopped ones, the listener there must answer healthy (a
 * package-tree-fenced proxy cannot serve requests) as that pid, and it must prove possession of the
 * record's attestation secret for a fresh challenge. A listener that merely names some live pid in
 * an unattested /healthz never releases a receipt. Bounded; false is not proof of failure, only that
 * the restart cannot release the receipt on the replacement's behalf.
 */
export async function schedulerReplacementServing(
  endpoint: { hostname: string; port: number },
  stoppedPids: readonly number[],
  deps: {
    readRecord?: () => { pid: number; port: number } | null;
    identityAt?: (endpoint: { hostname: string; port: number }, pid: number) => Promise<{ pid: number | null; packageTreeFenced?: true } | null>;
    prove?: (pid: number, endpoint: { hostname: string; port: number }) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    windowMs?: number;
  } = {},
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (deps.windowMs ?? 30_000);
  const readRecord = deps.readRecord ?? (() => readRuntimePort());
  const identityAt = deps.identityAt ?? ((target, pid) => proxyIdentityAt(target.port, { hostname: target.hostname, expectedPid: pid }, { ...SERVICE_STOP_LIVENESS, deadlineAt: deadline }));
  const prove = deps.prove ?? (async (pid, target) =>
    await proveLiveProxyOwnedByHome({ pid, port: target.port, hostname: target.hostname, source: "runtime" }, { ...SERVICE_STOP_LIVENESS, deadlineAt: deadline }) === "proven");
  for (;;) {
    try {
      const record = readRecord();
      if (record && record.port === endpoint.port && !stoppedPids.includes(record.pid)) {
        const identity = await identityAt(endpoint, record.pid);
        if (identity && !identity.packageTreeFenced && identity.pid === record.pid && await prove(record.pid, endpoint)) return true;
      }
    } catch {
      // A probe failure is not proof either way; keep looking until the deadline.
    }
    if (now() >= deadline) return false;
    await sleep(1000);
  }
}

/**
 * Refuse a scheduler restart of a live Child connected over a Remote Link, before anything changes.
 *
 * Its proxy can only be stopped by a deferred stop that keeps Codex routed to the Child's loopback
 * listener, which accepts unauthenticated local requests. If the restart then failed, nothing would
 * bind that port again and another local process could take it. A Link Child whose proxy is not
 * running has nothing to stop here; every later stop decides again (stopTrackedProxyForServiceRestart).
 */
export async function assertSchedulerRestartTargetAllowed(deps: {
  linkChild?: () => boolean;
  findProxy?: () => Promise<unknown | null>;
} = {}): Promise<void> {
  if (!linkChildConnected(deps.linkChild)) return;
  const live = await (deps.findProxy ?? (() => findLiveProxy({ ...SERVICE_STOP_LIVENESS, acceptPackageTreeFenced: true })))();
  if (!live) return;
  throw new Error(LINK_CHILD_RESTART_REFUSAL);
}

export async function stopTrackedProxyForServiceCommand(io: TrackedProxyStopIo = {}): Promise<TrackedProxyCleanupResult> {
  try {
    return await stopTrackedProxyIfRunning(io);
  } catch (err) {
    console.error(`⚠️  Failed to stop proxy: ${err instanceof Error ? err.message : String(err)}`);
    return "none";
  }
}

export interface ServiceInstallPreparationDeps extends RuntimePreflightDeps {
  inspectSupervision?: SupervisionInspector;
  supervisionLatch?: SupervisionLatch;
  managerOps?: (backend: ServiceBackend) => ServiceInstallCleanupOps | null;
  /**
   * Windows: Part A of the checked stop (#7771) for every registered manager and the
   * bound wrappers of this home. Replaces the manager stops plus the best-effort sweep.
   */
  windowsPartA?: (request: WindowsPartARequest) => Promise<WindowsCheckedStopResult>;
  /** Windows: Part B after the tracked-proxy stop; the port must be free and stay free. */
  windowsPartB?: (request: { port: number; remainingMs: number }) => Promise<WindowsStopConfirmResult>;
  /**
   * Windows: the port the stopped proxy was serving, resolved ONCE before Part A (#7771).
   *
   * Resolving it after the tracked cleanup reads a runtime record the cleanup just deleted,
   * so Part B confirmed the wrapper's port while the proxy's own port was never checked.
   */
  windowsStopPort?: () => number;
  /** Receives the deferral nonce so the wrapper's POST does not run the teardown. */
  stopTrackedProxy?: (io?: TrackedProxyStopIo) => Promise<unknown>;
  resolveTarget?: typeof resolveTrackedProxyTarget;
  claimTeardown?: typeof claimPendingTeardown;
  clearTeardown?: (nonce: string) => boolean;
  /** Every endpoint an absent-manager install must prove down, resolved once. */
  installEndpoints?: () => ProbeEndpoint[];
  endpointLiveness?: (endpoint: ProbeEndpoint) => Promise<EndpointLiveness>;
  platform?: NodeJS.Platform;
}

/**
 * What an install preparation left behind.
 *
 * `deferredTeardownNonce` exists on Windows when the install stopped a target: it stopped
 * the old proxy with the shared teardown deferred, so it owes the receipt. The install that
 * replaces the proxy keeps shared config pointed at OpenCodex and completes the receipt
 * after the new service is installed and started; a failed install leaves it for the next
 * `ocx stop` to finish.
 */
export interface ServiceInstallPreparationResult {
  deferredTeardownNonce?: string;
}

/**
 * Claim the deferred-teardown receipt the install's tracked stop will name.
 *
 * Part A leaves the scheduler task registered, so a receipt-less POST answers 409
 * `respawnable_service` and the stop throws while the old proxy keeps serving. The
 * receipt is claimed with Part A's record before the POST, exactly as `ocx service stop`
 * does; without it no undeferred stop is sent.
 */
function claimInstallTeardownReceipt(
  deps: ServiceInstallPreparationDeps,
  partA: WindowsCheckedStopResult,
  endpoint: { hostname: string; port: number },
): PendingTeardownReceipt {
  try {
    return (deps.claimTeardown ?? claimPendingTeardown)(endpoint, "exact", process.pid, undefined, windowsPartARecord(partA));
  } catch (error) {
    throw new Error(
      "The deferred-teardown receipt could not be recorded, so the proxy was left running and nothing was replaced: "
      + (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Stop every manager that could own the install port, then stop the tracked
 * standalone listener. Any unknown status or cleanup failure rejects, so callers
 * cannot write assets or report success over a surviving old listener.
 */
export async function prepareServiceInstall(
  requestedBackend: ServiceBackend,
  deps: ServiceInstallPreparationDeps = {},
): Promise<ServiceInstallPreparationResult> {
  const latch = deps.supervisionLatch ?? createSupervisionLatch();
  assertNoDesktopSupervision(deps.inspectSupervision, latch);
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    // Resolve the stopped proxy's port BEFORE anything removes its runtime record: Part B
    // has to confirm that port, and the wrapper's port is only a fallback (#7771).
    const stopPort = (deps.windowsStopPort ?? windowsServiceStopPort)();
    // Part A stops whichever managers are registered (both on a conflicting install) and
    // ends the bound wrappers, or refuses with nothing deleted or replaced (#7771). It
    // also covers a registration deleted mid-uninstall that left a detached wrapper
    // looping: with nothing registered it binds no orphan, and an unbound survivor
    // refuses instead of being killed by path alone.
    const partA = await (deps.windowsPartA ?? runWindowsServiceStopPartA)({
      admission: windowsStopAdmission({ orphanDiscovery: true }),
    });
    if (partA.outcome !== "stopped" && partA.outcome !== "absent") {
      throw new Error(`The installed Windows service could not be proven stopped (${partA.outcome}); nothing was replaced. ${describeWindowsPartA(partA)}`);
    }
    // With no manager registered, Part B is skipped and the tracked stop can come back
    // "none" after its discovery cap while an unresponsive proxy still holds the port.
    // Resolve the candidates now: the cleanup below deletes the runtime record that is one
    // of them. Nothing may be published over a candidate that is not definitively dead.
    const absentProofEndpoints = partA.outcome === "absent"
      ? (deps.installEndpoints ?? windowsRemovalEndpoints)()
      : [];
    const target = await (deps.resolveTarget ?? resolveTrackedProxyTarget)();
    if (target?.endpoint && partA.outcome === "absent" && !absentProofEndpoints.some(e => e.hostname === target.endpoint!.hostname && e.port === target.endpoint!.port)) absentProofEndpoints.push(target.endpoint);
    let nonce: string | undefined;
    if (target) {
      // Before the tracked stop: a receipt-less POST would answer 409 and abort the install
      // while the old proxy kept serving.
      if (!target.endpoint) throw new Error("The target endpoint is unavailable, so deferred teardown cannot be recorded.");
      nonce = claimInstallTeardownReceipt(deps, partA, target.endpoint).nonce;
    }
    // Part B owns the port wait after a stopped manager (030 "Time budget").
    await (deps.stopTrackedProxy ?? ((io?: TrackedProxyStopIo) => stopTrackedProxyIfRunning(io ?? {
      skipPortWait: partA.outcome === "stopped",
      orphanDiscoveryCapMs: WINDOWS_STOP_CAPS.orphanDiscovery,
    })))({
      target,
      ...(nonce ? { deferSharedTeardownNonce: nonce } : {}),
      skipPortWait: partA.outcome === "stopped",
      orphanDiscoveryCapMs: WINDOWS_STOP_CAPS.orphanDiscovery,
    });
    if (partA.outcome === "stopped") {
      const partB = await (deps.windowsPartB ?? confirmWindowsServiceStop)({
        port: target?.endpoint?.port ?? stopPort,
        remainingMs: windowsStopRemainingMs(),
      });
      if (partB.outcome !== "freed") {
        throw new Error(`The service port is not free after the stop; nothing was published or started. ${describeWindowsPartB(partB)}`);
      }
      return { deferredTeardownNonce: nonce };
    }
    if (partA.outcome === "absent") {
      const proof = await endpointsAllDead(absentProofEndpoints, deps.endpointLiveness ?? probeEndpointLiveness);
      if (!proof.dead) {
        throw new Error(proof.live.length > 0
          ? `A proxy is still listening on port ${proof.live.join(", ")}; nothing was published or started. Check for a manually started proxy, then retry.`
          : `The endpoint on port ${(proof.unknown.join(", ") || stopPort)} could not be confirmed down; nothing was published or started. Check for a manually started proxy, then retry.`);
      }
    }
    return nonce ? { deferredTeardownNonce: nonce } : {};
  }
  const resolveOps = deps.managerOps ?? platformServiceInstallCleanupOps;
  const backends: ServiceBackend[] = [];
  const addBackend = (backend: ServiceBackend) => {
    if (!backends.includes(backend)) backends.push(backend);
  };
  addBackend(requestedBackend);

  for (const backend of backends) {
    const manager = resolveOps(backend);
    if (!manager) throw new Error(`Background service manager is unavailable for ${backend}.`);
    if (manager.status() !== null) manager.stop();
  }
  await (deps.stopTrackedProxy ?? stopTrackedProxyIfRunning)();
  // No manager deferral off Windows: the launchd/systemd stop is down when it reports so.
  return {};
}

export async function installServiceSafely(
  requestedBackend: ServiceBackend,
  install: (runtime: DurableBunRuntime) => void | Promise<void>,
  deps: ServiceInstallPreparationDeps = {},
): Promise<void> {
  const latch = deps.supervisionLatch ?? createSupervisionLatch();
  assertNoDesktopSupervision(deps.inspectSupervision, latch);
  const runtime = Object.freeze({ ...(deps.selectRuntime ?? durableBunRuntime)() });
  const configDir = (deps.configDir ?? getConfigDir)();
  (deps.assertRuntimeWritable ?? assertSelectedRuntimeWritable)(runtime, configDir, { platform: deps.platform, rootWasAbsent: !existsSync(configDir) });
  const prepared = await prepareServiceInstall(requestedBackend, { ...deps, supervisionLatch: latch });
  assertNoDesktopSupervision(deps.inspectSupervision, latch);
  await install(runtime);
  // The new service is installed and started, so shared config stays pointed at OpenCodex
  // and the deferral is discharged. An install failure above throws before this line and
  // keeps the receipt for the next stop.
  const nonce = prepared.deferredTeardownNonce;
  if (nonce && !(deps.clearTeardown ?? clearPendingTeardown)(nonce)) {
    console.warn("⚠️  The deferred-teardown receipt could not be removed; the next 'ocx stop' will finish it.");
  }
}

export interface FreshWindowsSchedulerInstallDeps extends RuntimePreflightDeps {
  inspectSupervision?: SupervisionInspector;
  supervisionLatch?: SupervisionLatch;
  stageRegistrationXml?: (attemptNonce: string) => string;
  register?: (xmlPath: string, attemptNonce: string) => Promise<void>;
  recordOwnership?: () => boolean;
  prepare?: () => Promise<ServiceInstallPreparationResult | void>;
  removeNativeService?: () => void;
  publishAssets?: (runtime: DurableBunRuntime) => void;
  verifyBeforeRun?: (attemptNonce: string) => void | Promise<void>;
  /** Reads the newly registered task; empty or throwing reads are retried before rollback. */
  readSchedulerXml?: () => string;
  /** Bounded wait before retrying an unreadable fresh-install registration. */
  settleSchedulerRead?: (delayMs: number) => void | Promise<void>;
  runTask?: () => void;
  writeState?: (runtime: DurableBunRuntime) => void;
  rollbackTask?: (attemptNonce: string) => Promise<string | null>;
  removeStagedXml?: (xmlPath: string) => void;
}

/**
 * Fresh Windows scheduler install with UAC before the destructive commit.
 *
 * The registration is created but never run before `prepare`: UAC cancellation and
 * create failure therefore cannot stop the existing proxy or trigger its native-routing
 * cleanup. Rollback proves ownership from the live registration's attempt nonce before
 * deleting, because the fixed task name can be replaced by another process at any time.
 */
export async function installFreshWindowsSchedulerSafely(
  deps: FreshWindowsSchedulerInstallDeps = {},
): Promise<void> {
  const latch = deps.supervisionLatch ?? createSupervisionLatch();
  assertNoDesktopSupervision(deps.inspectSupervision, latch);
  const stage = deps.stageRegistrationXml ?? stageWindowsSchedulerRegistrationXml;
  const register = deps.register ?? registerFreshWindowsSchedulerTask;
  const recordOwnership = deps.recordOwnership ?? recordWindowsSchedulerOwnership;
  const prepare = deps.prepare ?? (() => prepareServiceInstall("scheduler", {
    inspectSupervision: deps.inspectSupervision, supervisionLatch: latch,
  }));
  const removeNativeService = deps.removeNativeService ?? removeNativeWindowsServiceForScheduler;
  const publishAssets = deps.publishAssets ?? writeWindowsSchedulerAssets;
  const verifyBeforeRun = deps.verifyBeforeRun ?? ((nonce: string) => (
    assertSchedulerRegistrationBeforeStart(
      deps.readSchedulerXml ?? statusWindowsXml,
      deps.settleSchedulerRead ?? settleDelay,
      liveXml => (
        windowsTaskRegistrationHealthy(liveXml)
        && windowsTaskRegistrationOwnedByAttempt(liveXml, nonce)
      ),
      "The fresh Task Scheduler registration changed before start; it was preserved and not run.",
      "The fresh Task Scheduler registration remained unreadable before start; it was preserved and not run.",
    )
  ));
  const runTask = deps.runTask ?? startWindows;
  const writeState = deps.writeState ?? ((runtime: DurableBunRuntime) => writeServiceInstallState("scheduler", undefined, {}, runtime));
  const rollbackTask = deps.rollbackTask ?? ((attemptNonce: string) => (
    rollbackWindowsSchedulerTaskOwnedByAttempt(attemptNonce, TASK)
  ));
  const removeStagedXml = deps.removeStagedXml ?? ((path: string) => {
    removeWindowsSchedulerRegistrationStage(path);
  });

  let stagedXml: string | null = null;
  const attemptNonce = randomUUID();
  const configDir = (deps.configDir ?? getConfigDir)();
  const configRootWasAbsent = !existsSync(configDir);
  const runtime = Object.freeze({ ...(deps.selectRuntime ?? durableBunRuntime)() });
  let registered = false;
  let started = false;
  try {
    stagedXml = stage(attemptNonce);
    await register(stagedXml, attemptNonce);
    registered = true;
    assertNoDesktopSupervision(deps.inspectSupervision, latch);

    // The destructive boundary begins only after Task Scheduler accepted the definition.
    // The registration has consumed its temporary XML. Remove it before claiming a newly
    // created config root, because ownership initialization intentionally requires emptiness.
    removeStagedXml(stagedXml);
    stagedXml = null;
    const ownershipRecorded = recordOwnership();
    if (!ownershipRecorded && configRootWasAbsent) {
      throw new Error(
        "The fresh OpenCodex config root could not be claimed for safe uninstall; "
        + "aborting before service-manager cleanup or asset publication.",
      );
    }
    (deps.assertRuntimeWritable ?? assertSelectedRuntimeWritable)(runtime, configDir, { platform: deps.platform, rootWasAbsent: false });
    const prepared = await prepare();
    assertNoDesktopSupervision(deps.inspectSupervision, latch);
    removeNativeService();
    publishAssets(runtime);
    await verifyBeforeRun(attemptNonce);
    assertNoDesktopSupervision(deps.inspectSupervision, latch);
    runTask();
    started = true;
    writeState(runtime);
    // A prepare that stopped an old manager claimed the deferral receipt; the replacement
    // is running now, so shared config stays pointed at OpenCodex and the obligation is
    // discharged. A failure above keeps it for the next stop.
    const nonce = prepared && "deferredTeardownNonce" in prepared ? prepared.deferredTeardownNonce : undefined;
    if (nonce && !clearPendingTeardown(nonce)) {
      console.warn("⚠️  The deferred-teardown receipt could not be removed; the next 'ocx stop' will finish it.");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (registered && !started) {
      const rollback = await rollbackTask(attemptNonce);
      throw new Error(
        `${detail}\n`
        + (rollback
          ? `The new Task Scheduler registration may remain: ${rollback}`
          : "The new Task Scheduler registration was rolled back. The previous proxy/routing state was not assumed restored."),
      );
    }
    if (started) {
      throw new Error(
        `${detail}\nThe scheduler task started, but install state was not published. `
        + "The task was left in place; inspect `ocx service status` before retrying.",
      );
    }
    throw error;
  } finally {
    if (stagedXml) {
      try { removeStagedXml(stagedXml); } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
        console.error(
          `⚠️  Failed to remove the private Task Scheduler staging directory${code ? ` (${code})` : ""}.`,
        );
      }
    }
  }
}

// `stopServiceIfInstalled` (boolean) is deliberately gone. It collapsed "not installed",
// "refused to stop" and "state could not be read" into the same `false`, and every caller
// that trusted it eventually read a live manager as absence — the route, then uninstall
// (#3008). Callers take `stopServiceIfInstalledDetailed` and handle the outcomes.
/**
 * Would stopping the installed manager leave something that can respawn the proxy?
 *
 * Answered WITHOUT stopping anything, because a caller that must refuse the stop has to
 * refuse before it acts: `POST /api/stop` briefly ended the Task Scheduler task and then
 * returned 409, which left the proxy running with its manager stopped — worse than either
 * outcome it was choosing between.
 *
 * Task Scheduler only. `schtasks /end` ends the task instance while the `cmd :loop`
 * wrapper survives and respawns its child (#764); launchd, systemd and WinSW are down when
 * they report stopped.
 */
export function installedServiceRespawnRisk(
  probe: () => WindowsSchedulerTaskProbe = probeWindowsSchedulerTask,
  platform: NodeJS.Platform = process.platform,
  io: { env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {},
): "none" | "respawnable" | "unknown" | "self-unload" {
  // launchd, systemd and WinSW are down when they report stopped; only the Task Scheduler
  // wrapper survives its task ending (#764).
  //
  // "Down when they report stopped" answers the RESPAWN question but not the SELF-UNLOAD
  // one (#4023). When the proxy is itself the managed job, `launchctl unload` /
  // `systemctl stop` terminate this very process, so the manager stop can kill the request
  // handler before the shared teardown restores the native Codex config keys — leaving
  // `openai_base_url`, `experimental_realtime_ws_base_url` and `model_catalog_json`
  // pointed at a proxy that is gone. Reordering teardown ahead of the manager stop is not
  // available here: the #3008 contract requires the manager to be proven stopped first.
  // So refuse, exactly as Windows does, and send the operator to `ocx stop`, which stops
  // the proxy from the outside and owns the teardown through its receipt.
  if (platform !== "win32") {
    const env = io.env ?? process.env;
    // Discriminate on the wrapper-only marker, not on OCX_SERVICE: `ocx claude` and
    // `ocx opencode` set OCX_SERVICE=1 on the proxies they spawn (for preserveRouting),
    // and refusing their dashboard stop would break a proxy that no manager supervises.
    if (env[SERVICE_MANAGED_ENV] !== "1") return "none";
    const exists = io.exists ?? existsSync;
    if (platform === "darwin") return exists(plistPath()) ? "self-unload" : "none";
    if (platform === "linux") return exists(unitPath()) ? "self-unload" : "none";
    return "none";
  }
  try {
    // `probeWindowsSchedulerTask` returns "unknown" as an ordinary value when its queries
    // fail — it does not throw — so testing for "present" let an unanswerable probe
    // through, and the route then killed scheduler wrappers before refusing.
    //
    // "unknown" is kept SEPARATE from "respawnable" because the remedies differ. Telling
    // an operator whose schtasks query is broken to run `ocx stop` is circular: that
    // command maps the same unknown to a stop failure, so it cannot finish either.
    const status = probe().status;
    if (status === "absent") return "none";
    return status === "present" ? "respawnable" : "unknown";
  } catch {
    // A probe that cannot answer is not evidence of absence either.
    return "unknown";
  }
}

/**
 * Outcome of stopping an installed process manager.
 *
 * `stopServiceIfInstalled` collapses "no service was installed" and "a service was
 * installed and would not stop" into the same `false`, which is fine for a caller that
 * only wants to log. It is not fine for one deciding whether an update may replace package
 * files: a manager that refused to stop can respawn the proxy on top of a half-written
 * install (#3008).
 */
/**
 * `stopped-respawnable` was Task Scheduler specifically: `schtasks /end` ends the task
 * instance while the `cmd :loop` wrapper survives and respawns its child seconds later
 * (#764). Since the checked Windows stop (#7771) no current backend returns it: Windows
 * reports `stopped` only after Part A ended the manager and every bound wrapper, and its
 * callers then run Part B unconditionally. The value stays for documents and receipts
 * written by older CLIs, which callers still read.
 */
/**
 * `state-unknown` is kept apart from `failed` because the remedies differ. A manager that
 * refused to stop is a stop failure the operator can retry; a scheduler whose state cannot
 * be READ is a broken query, and telling that operator "the manager did not stop" sends
 * them looking for the wrong thing (#3008).
 */
export type ServiceStopOutcome = "absent" | "stopped" | "stopped-respawnable" | "failed" | "state-unknown";

/** The outcome plus, on Windows, the Part A result behind it (reason, bound wrappers). */
export interface ServiceStopReport {
  outcome: ServiceStopOutcome;
  windows: WindowsCheckedStopResult | null;
}

/**
 * Stop whatever manager is installed. On Windows this is Part A of the checked stop
 * (#7771): both backends are probed, the registered managers stopped and the bound
 * wrappers ended and waited for, with admission against the caller's deadline. The proxy
 * child is left to the caller's graceful stop, and the caller runs Part B after it.
 */
export async function stopServiceIfInstalledReport(
  request: WindowsPartARequest = {},
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceStopReport> {
  assertServiceEnvironmentMatchesInstall();
  if (platform === "darwin") {
    if (existsSync(plistPath())) {
      try { stopLaunchd(); return { outcome: "stopped", windows: null }; } catch { return { outcome: "failed", windows: null }; }
    }
  } else if (platform === "win32") {
    // Both backends are probed regardless of state (a failed switch can leave two), an
    // unreadable probe is state-unknown and never absence, and a wrapper that survives
    // `schtasks /end` is ended through the binding rule instead of a path-only sweep.
    const windows = await runWindowsServiceStopPartA(request);
    return { outcome: serviceStopOutcomeFromWindows(windows), windows };
  } else if (platform === "linux" && isSystemd() && existsSync(unitPath())) {
    try { stopSystemd(); return { outcome: "stopped", windows: null }; } catch { return { outcome: "failed", windows: null }; }
  }
  return { outcome: "absent", windows: null };
}

export async function stopServiceIfInstalledDetailed(request: WindowsPartARequest = {}): Promise<ServiceStopOutcome> {
  return (await stopServiceIfInstalledReport(request)).outcome;
}

/** Delete install-state files; stale state would make `ocx update` "reinstall" a service that no longer exists. */
export function removeServiceInstallState(): void {
  removeServiceInstallStateRecords();
}

type UninstallServiceHooksForTests = {
  platform: typeof process.platform;
  assertEnvironment: () => void;
  probeWindowsTask: () => WindowsSchedulerTaskProbe;
  uninstallWindowsTask: () => void;
  nativeStatus: () => WinswStatus;
  /**
   * Is the registered `opencodex-proxy-native` service THIS home's? `sc stop/delete` name a
   * fixed ID, so a registration is not evidence of ownership — another installation's
   * WinSW service under the same ID would be stopped and deleted here. Production reads
   * `sc qc` BINARY_PATH_NAME and compares it with this home's executable.
   */
  nativeOwnership?: () => "owned" | "foreign" | "unknown";
  uninstallNative: () => void;
  removeInstallState: () => void;
  launchdPlistPath?: () => string;
  uninstallLaunchd?: () => void;
};

let uninstallServiceHooksForTests: UninstallServiceHooksForTests | null = null;

/** Test-only hooks for full-uninstall service removal. */
export function setUninstallServiceHooksForTests(hooks: UninstallServiceHooksForTests | null): void {
  uninstallServiceHooksForTests = hooks;
}

/**
 * Best-effort service removal for full uninstall. Unlike `ocx service uninstall`, this is quiet
 * when no service exists or the platform has no service manager. An installed native Windows
 * service or scheduler task that cannot be removed throws so the caller cannot erase state and
 * report success.
 */
/**
 * Outcome of removing an installed manager.
 *
 * `false` used to mean both "nothing was installed" and "removal failed" on darwin and
 * linux, so a failed removal was reported as absence and authorized the shared teardown
 * while the service assets were still there (#3008).
 */
export type ServiceUninstallOutcome = "absent" | "removed" | "failed";

/**
 * Does the registered WinSW service run this home's executable?
 *
 * The same proof the guarded manager and Part A use (`sc qc` `BINARY_PATH_NAME`), reduced to
 * the three answers removal needs: this home's (`owned`), another's (`foreign`), or one that
 * could not be read (`unknown`, which refuses).
 */
function winswOwnershipOfThisHome(
  query: () => string | null = queryWinswBinaryPathName,
): "owned" | "foreign" | "unknown" {
  let binaryPathName: string | null;
  try {
    binaryPathName = query();
  } catch {
    return "unknown";
  }
  if (binaryPathName === null) return "unknown";
  return scBinaryPathNamesExecutable(binaryPathName, winswExePath()) ? "owned" : "foreign";
}

/**
 * Remove installed manager assets, including orphaned launchd recovery files.
 * Keep install state on removal failure; Windows refusal and unknown probes may throw.
 */
export function uninstallServiceDetailed(): ServiceUninstallOutcome {
  const hooks = uninstallServiceHooksForTests;
  (hooks?.assertEnvironment ?? assertServiceEnvironmentMatchesInstall)();
  const platform = hooks?.platform ?? process.platform;
  if (platform === "darwin") {
    const p = (hooks?.launchdPlistPath ?? plistPath)();
    if ([p, `${p}.prev`, `${p}.pending`].some(path => existsSync(path))) {
      try {
        (hooks?.uninstallLaunchd ?? uninstallLaunchd)();
        (hooks?.removeInstallState ?? removeServiceInstallState)();
        return "removed";
      } catch { return "failed"; }
    }
  } else if (platform === "win32") {
    let removed = false;
    const scheduler = (hooks?.probeWindowsTask ?? probeWindowsSchedulerTask)();
    if (scheduler.status === "unknown") {
      throw new Error(`Could not determine Task Scheduler state: ${scheduler.detail}`);
    }
    // Every probe runs before the first destructive step. The task used to be deleted first,
    // so an unreadable `sc qc` left a half-removed install: no scheduler task to retry from,
    // native registration still on disk, and no way back (#7771 round 9).
    const nativeStatus = (hooks?.nativeStatus ?? statusWinswRaw)();
    if (nativeStatus === "unknown") {
      throw new Error("Native service status could not be verified.");
    }
    let ownership: "owned" | "foreign" | "unknown" | null = null;
    if (nativeStatus !== "nonexistent") {
      // Re-prove ownership right before the destructive step: `sc qc` may have changed
      // since the install-state read, and a foreign registration must survive an uninstall
      // of this home. Unreadable is not a licence to delete — fail closed and keep state.
      ownership = (hooks?.nativeOwnership ?? winswOwnershipOfThisHome)();
      if (ownership === "unknown") {
        throw new Error(
          `The native service registration's ownership could not be verified (sc qc ${WINSW_SERVICE_ID}); refusing to remove it. Check 'sc query ${WINSW_SERVICE_ID}' and retry.`,
        );
      }
    }
    if (scheduler.status === "present") {
      (hooks?.uninstallWindowsTask ?? uninstallWindows)();
      removed = true;
    }
    if (ownership === "owned") {
      (hooks?.uninstallNative ?? uninstallWinswService)();
      removed = true;
    }
    if (removed) { (hooks?.removeInstallState ?? removeServiceInstallState)(); return "removed"; }
  } else if (platform === "linux" && existsSync(unitPath())) {
    try { uninstallSystemd(); removeServiceInstallState(); return "removed"; } catch {
      try { unlinkSync(unitPath()); removeServiceInstallState(); return "removed"; } catch { return "failed"; }
    }
  }
  return "absent";
}

/** Boolean form for callers that only distinguish "something was removed". */
export function uninstallServiceIfInstalled(): boolean {
  const outcome = uninstallServiceDetailed();
  if (outcome === "failed") throw new Error("the installed service could not be removed");
  return outcome === "removed";
}

/** True if a background service (launchd/systemd/Task Scheduler) is installed. */
export function isServiceInstalled(): boolean {
  return diagnoseService().installed;
}

/**
 * True when an installed background service can actually supervise the proxy.
 * Presence alone is not enough: stale/missing assets, conflicts, and disabled
 * registrations report `installed` but will not bring the proxy back after exit.
 */
export function isServiceViable(): boolean {
  return diagnoseService().viable;
}
