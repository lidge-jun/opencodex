import { findLiveProxy, SERVICE_STOP_LIVENESS } from "../server/proxy-liveness";
import { existsSync, unlinkSync } from "node:fs";
import { getConfigDir } from "../config";
import { readPid, removePid, removeRuntimePort, verifyPidIdentity } from "../config/process-state";
import { isWslRuntime } from "../codex/home";
import { isProcessAlive, stopProxy } from "../lib/process-control";
import { randomUUID } from "node:crypto";
import { startWinswService, stopWinswService, statusWinswRaw, uninstallWinswService, winswStatusSummary, type WinswStatus } from "../lib/winsw";
import { diagnoseService } from "./diagnostics";
import type { ServiceDiagnostic } from "./diagnostics";
import { assertServiceEnvironmentMatchesInstall } from "./guards";
import { runLaunchctl, launchdEvictionTargets, launchctlBootoutBenign, probeLaunchdLoadState, installLaunchd, startLaunchd, stopLaunchd, statusLaunchd, uninstallLaunchd } from "./launchd";
import { assertSchedulerRegistrationBeforeStart } from "./repair";
import { SERVICE_MANAGED_ENV, TASK, plistPath, serviceStatePaths, writeServiceInstallState } from "./state";
import type { ServiceBackend } from "./state";
import { unitPath, isSystemd, installSystemd, startSystemd, stopSystemd, statusSystemd, uninstallSystemd, systemdServiceInstallCleanupOps } from "./systemd";
import { writeWindowsSchedulerAssets, stageWindowsSchedulerRegistrationXml, removeWindowsSchedulerRegistrationStage, registerFreshWindowsSchedulerTask, recordWindowsSchedulerOwnership, removeNativeWindowsServiceForScheduler, installWindows, installWindowsNative, startWindows, isWindowsSchedulerEndBenign, stopWindows, stopWindowsChecked, statusWindows, statusWindowsXml, killWindowsServiceWrapperProcesses, uninstallWindows, classifyWindowsServiceStop } from "./windows-ops";
import { schtasks, probeWindowsSchedulerTask, rollbackWindowsSchedulerTaskOwnedByAttempt, settleDelay } from "./windows-scheduler";
import type { WindowsSchedulerTaskProbe } from "./windows-scheduler";
import { windowsTaskRegistrationOwnedByAttempt, windowsTaskRegistrationHealthy } from "./windows-taskxml";
import { win32 } from "node:path";
import { launchdGuiDomain } from "./launchd";
import { LABEL } from "./state";

type ServiceOps = {
  install: () => void | Promise<void>; start: () => void; stop: () => void;
  status: () => string; uninstall: () => void;
};

export type ServiceInstallCleanupOps = {
  status: () => string | null;
  stop: () => void;
};

export function platformOps(backend: ServiceBackend = "scheduler"): ServiceOps | null {
  if (process.platform === "darwin")
    // Wrapped, not passed: `installLaunchd` reports whether it reloaded launchd, and only
    // `repairService` (for the `restart` verb) has any use for that. `ServiceOps.install` is
    // the generic install seam and deliberately promises nothing about a return value.
    return { install: () => { installLaunchd(); }, start: startLaunchd, stop: stopLaunchd, status: statusLaunchd, uninstall: uninstallLaunchd };
  if (process.platform === "win32") {
    if (backend === "native")
      return { install: installWindowsNative, start: startWinswService, stop: stopWinswService, status: winswStatusSummary, uninstall: uninstallWinswService };
    return { install: installWindows, start: startWindows, stop: stopWindows, status: statusWindows, uninstall: uninstallWindows };
  }
  if (process.platform === "linux") {
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
    return findLiveProxy({ ...SERVICE_STOP_LIVENESS, deadlineAt: probeDeadline, nowFn: now });
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

async function stopTrackedProxyIfRunning(): Promise<TrackedProxyCleanupResult> {
  let stopped = false;
  const pid = readPid();
  const trackedKillPid = verifiedKillTarget(pid);
  if (trackedKillPid !== null && isProcessAlive(trackedKillPid)) {
    await stopProxy(trackedKillPid);
    removePid(trackedKillPid);
    removeRuntimePort(trackedKillPid);
    stopped = true;
  } else if (pid) {
    removePid(pid);
    removeRuntimePort(pid);
  }
  // Orphan recovery: the pid file can be missing/stale while the service wrapper keeps
  // a live proxy running — mirror `ocx stop`'s identity-checked findLiveProxy fallback.
  // Cap multi-candidate discovery so stop cleanup cannot hang for three full retry budgets.
  const live = await findLiveProxy({
    ...SERVICE_STOP_LIVENESS,
    deadlineAt: Date.now() + 7000,
  });
  const liveKillPid = verifiedKillTarget(live?.pid);
  if (liveKillPid !== null) {
    await stopProxy(liveKillPid);
    removePid(liveKillPid);
    removeRuntimePort(liveKillPid);
    stopped = true;
  }
  if (stopped) return "stopped";
  if (pid) return "stale";
  return "none";
}

export async function stopTrackedProxyForServiceCommand(): Promise<TrackedProxyCleanupResult> {
  try {
    return await stopTrackedProxyIfRunning();
  } catch (err) {
    console.error(`⚠️  Failed to stop proxy: ${err instanceof Error ? err.message : String(err)}`);
    return "none";
  }
}

export interface ServiceInstallPreparationDeps {
  diagnose?: () => ServiceDiagnostic;
  managerOps?: (backend: ServiceBackend) => ServiceInstallCleanupOps | null;
  stopTrackedProxy?: () => Promise<unknown>;
  platform?: NodeJS.Platform;
}

/**
 * Stop every manager that could own the install port, then stop the tracked
 * standalone listener. Any unknown status or cleanup failure rejects, so callers
 * cannot write assets or report success over a surviving old listener.
 */
export async function prepareServiceInstall(
  requestedBackend: ServiceBackend,
  deps: ServiceInstallPreparationDeps = {},
): Promise<void> {
  const diagnostic = (deps.diagnose ?? diagnoseService)();
  const platform = deps.platform ?? process.platform;
  const resolveOps = deps.managerOps ?? platformServiceInstallCleanupOps;
  const backends: ServiceBackend[] = [];
  const addBackend = (backend: ServiceBackend) => {
    if (!backends.includes(backend)) backends.push(backend);
  };

  if (platform === "win32") {
    // The recorded backend owns the old installation and must be stopped first.
    // A conflicting diagnostic means both managers exist, so stop both even when
    // the requested backend happens to match the recorded one.
    if (diagnostic.backend === "scheduler" || diagnostic.backend === "native") {
      addBackend(diagnostic.backend);
      if (diagnostic.conflict) addBackend(diagnostic.backend === "scheduler" ? "native" : "scheduler");
    }
    addBackend(requestedBackend);
  } else {
    addBackend(requestedBackend);
  }

  for (const backend of backends) {
    const manager = resolveOps(backend);
    if (!manager) throw new Error(`Background service manager is unavailable for ${backend}.`);
    if (manager.status() !== null) manager.stop();
  }
  await (deps.stopTrackedProxy ?? stopTrackedProxyIfRunning)();
}

export async function installServiceSafely(
  requestedBackend: ServiceBackend,
  install: () => void | Promise<void>,
  deps: ServiceInstallPreparationDeps = {},
): Promise<void> {
  await prepareServiceInstall(requestedBackend, deps);
  await install();
}

export interface FreshWindowsSchedulerInstallDeps {
  stageRegistrationXml?: (attemptNonce: string) => string;
  register?: (xmlPath: string, attemptNonce: string) => Promise<void>;
  recordOwnership?: () => boolean;
  prepare?: () => Promise<void>;
  removeNativeService?: () => void;
  publishAssets?: () => void;
  verifyBeforeRun?: (attemptNonce: string) => void | Promise<void>;
  /** Reads the newly registered task; empty or throwing reads are retried before rollback. */
  readSchedulerXml?: () => string;
  /** Bounded wait before retrying an unreadable fresh-install registration. */
  settleSchedulerRead?: (delayMs: number) => void | Promise<void>;
  runTask?: () => void;
  writeState?: () => void;
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
  const stage = deps.stageRegistrationXml ?? stageWindowsSchedulerRegistrationXml;
  const register = deps.register ?? registerFreshWindowsSchedulerTask;
  const recordOwnership = deps.recordOwnership ?? recordWindowsSchedulerOwnership;
  const prepare = deps.prepare ?? (() => prepareServiceInstall("scheduler"));
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
  const writeState = deps.writeState ?? (() => writeServiceInstallState("scheduler"));
  const rollbackTask = deps.rollbackTask ?? ((attemptNonce: string) => (
    rollbackWindowsSchedulerTaskOwnedByAttempt(attemptNonce, TASK)
  ));
  const removeStagedXml = deps.removeStagedXml ?? ((path: string) => {
    removeWindowsSchedulerRegistrationStage(path);
  });

  let stagedXml: string | null = null;
  const attemptNonce = randomUUID();
  const configRootWasAbsent = !existsSync(getConfigDir());
  let registered = false;
  let started = false;
  try {
    stagedXml = stage(attemptNonce);
    await register(stagedXml, attemptNonce);
    registered = true;

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
    await prepare();
    removeNativeService();
    publishAssets();
    await verifyBeforeRun(attemptNonce);
    runTask();
    started = true;
    writeState();
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
 * `stopped-respawnable` is Task Scheduler specifically: `schtasks /end` ends the task
 * instance while the `cmd :loop` wrapper survives and respawns its child seconds later
 * (#764). Only that backend needs the restart-window wait — launchd, systemd and WinSW
 * are down when they report stopped, and making them pay a seven-second poll would be a
 * regression in every ordinary `ocx stop`.
 */
/**
 * `state-unknown` is kept apart from `failed` because the remedies differ. A manager that
 * refused to stop is a stop failure the operator can retry; a scheduler whose state cannot
 * be READ is a broken query, and telling that operator "the manager did not stop" sends
 * them looking for the wrong thing (#3008).
 */
export type ServiceStopOutcome = "absent" | "stopped" | "stopped-respawnable" | "failed" | "state-unknown";

export function stopServiceIfInstalledDetailed(): ServiceStopOutcome {
  assertServiceEnvironmentMatchesInstall();
  if (process.platform === "darwin") {
    if (existsSync(plistPath())) {
      try { stopLaunchd(); return "stopped"; } catch { return "failed"; }
    }
  } else if (process.platform === "win32") {
    // Query BOTH backends regardless of state: a failed switch or stale state can leave
    // two managers installed, and either one would respawn the proxy after `ocx stop`.
    let stopped = false;
    let failed = false;
    let schedulerStopped = false;
    let stateUnknown = false;
    // `probeWindowsSchedulerTask` is tri-state on purpose: a query that THROWS is not the
    // same as a task that is absent, and treating it as absent lets a live scheduler
    // survive a "successful" stop.
    const probe = probeWindowsSchedulerTask();
    if (probe.status === "present") {
      if (stopWindowsChecked()) { stopped = true; schedulerStopped = true; }
      else failed = true;
    } else if (probe.status === "unknown") {
      // Not "failed": nothing refused to stop. The query itself could not answer, which is
      // a different problem with a different fix.
      stateUnknown = true;
    }
    if (statusWinswRaw() !== "nonexistent") {
      try { stopWinswService(); stopped = true; } catch { failed = true; }
    }
    // `schtasks /end` ends the task instance but the cmd `:loop` wrapper survives and
    // respawns its child seconds later (issue #764), resurrecting the proxy during a
    // stop or a tray restart. Kill the launcher/wrapper processes outright.
    killWindowsServiceWrapperProcesses();
    // A failure on either backend wins: the other one stopping does not make the live one
    // safe to update over.
    const outcome = classifyWindowsServiceStop({ stopped, failed, schedulerStopped, stateUnknown });
    if (outcome !== "absent") return outcome;
  } else if (process.platform === "linux" && isSystemd() && existsSync(unitPath())) {
    try { stopSystemd(); return "stopped"; } catch { return "failed"; }
  }
  return "absent";
}

/** Delete install-state files; stale state would make `ocx update` "reinstall" a service that no longer exists. */
export function removeServiceInstallState(): void {
  for (const path of serviceStatePaths()) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
  }
}

type UninstallServiceHooksForTests = {
  platform: typeof process.platform;
  assertEnvironment: () => void;
  probeWindowsTask: () => WindowsSchedulerTaskProbe;
  uninstallWindowsTask: () => void;
  nativeStatus: () => WinswStatus;
  uninstallNative: () => void;
  removeInstallState: () => void;
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

export function uninstallServiceDetailed(): ServiceUninstallOutcome {
  const hooks = uninstallServiceHooksForTests;
  (hooks?.assertEnvironment ?? assertServiceEnvironmentMatchesInstall)();
  const platform = hooks?.platform ?? process.platform;
  if (platform === "darwin") {
    if (existsSync(plistPath())) {
      try { uninstallLaunchd(); removeServiceInstallState(); return "removed"; } catch { return "failed"; }
    }
  } else if (platform === "win32") {
    let removed = false;
    const scheduler = (hooks?.probeWindowsTask ?? probeWindowsSchedulerTask)();
    if (scheduler.status === "unknown") {
      throw new Error(`Could not determine Task Scheduler state: ${scheduler.detail}`);
    }
    if (scheduler.status === "present") {
      (hooks?.uninstallWindowsTask ?? uninstallWindows)();
      removed = true;
    }
    if ((hooks?.nativeStatus ?? statusWinswRaw)() !== "nonexistent") {
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
