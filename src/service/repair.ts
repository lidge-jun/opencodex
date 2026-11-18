import { existsSync } from "node:fs";
import { getConfigDir } from "../config";
import { durableBunRuntime, type DurableBunRuntime } from "../lib/bun-runtime";
import { assertSelectedRuntimeWritable, type RuntimePreflightDeps } from "../lib/bun-runtime-preflight";
import { randomUUID } from "node:crypto";
import { defaultWinswEntry, installWinswService } from "../lib/winsw";
import { resolveWindowsTaskDiagnosticUserId, diagnoseService } from "./diagnostics";
import type { ServiceDiagnostic } from "./diagnostics";
import { assertServiceAuthEnvironment } from "./auth-preflight";
import { assertServiceEnvironmentMatchesInstall } from "./guards";
import { installLaunchd, restartLaunchdJob } from "./launchd";
import type { LaunchdInstallOutcome } from "./launchd";
import { TASK, writeServiceInstallState, serviceSourceDir, resolveServiceOwnership, serviceLauncherPathDiagnostic, windowsLauncherVbsPath, windowsServiceScriptPath } from "./state";
import type { ServiceOwnership, ServiceOwnershipResolution } from "./state";
import { installSystemd } from "./systemd";
import { writeWindowsSchedulerAssets, reregisterWindowsSchedulerTask, windowsSchedulerRegistrationMatchesSnapshot, restoreWindowsSchedulerTaskIfAbsent, startWindows, stopWindows, statusWindowsXml, snapshotWindowsSchedulerAssets } from "./windows-ops";
import { probeWindowsSchedulerTask, SCHEDULER_SETTLE_DELAYS_MS, settleDelay } from "./windows-scheduler";
import type { WindowsSchedulerTaskProbe } from "./windows-scheduler";
import { taskXmlSection, taskXmlWithoutCommentsAndCdata, taskXmlElementCount, taskXmlOptionalValueEquals, windowsTaskRegistrationOwnedByAttempt, windowsTaskHasSessionRecoveryTriggers, windowsTaskRegistrationHealthy, windowsTaskRegistrationRefreshableLegacy } from "./windows-taskxml";
import type { ExpectedWindowsTaskUserId } from "./windows-taskxml";
import { win32 } from "node:path";
import { assertNoDesktopSupervision, createSupervisionLatch, type SupervisionInspector, type SupervisionLatch } from "./desktop-command-guard";
import { prepareDisconnectedClientServiceRestart } from "./disconnected-client-restart";
import type { HeldRestartReceipt } from "./restart-proxy-stop";
import { killWindowsSchedulerWrappers } from "../lib/windows-service-wrappers";
import { clearPendingTeardown, pendingTeardownPathFor } from "../config/pending-teardown";

/** Append what the caller's state means to an error, keeping the error itself (its class and code). */
function withContext(error: unknown, context: string): unknown {
  if (error instanceof Error) { error.message = `${error.message} ${context}`; return error; }
  return new Error(`${String(error)} ${context}`);
}

/**
 * Release the deferred-teardown receipts a scheduler restart kept, each once a replacement serves
 * the endpoint it names. Returns the receipts kept: client routing still names those endpoints,
 * and `ocx stop` finishes an abandoned receipt by restoring native client routing.
 */
async function releaseRestartReceipts(
  held: readonly HeldRestartReceipt[],
  confirm?: (receipt: HeldRestartReceipt, stoppedPids: readonly number[]) => Promise<boolean>,
): Promise<HeldRestartReceipt[]> {
  const stoppedPids = held.map(receipt => receipt.pid);
  const kept: HeldRestartReceipt[] = [];
  for (const receipt of held) {
    const serving = await (confirm ?? (async (target: HeldRestartReceipt, pids: readonly number[]) => {
      const { schedulerReplacementServing } = await import("./orchestration");
      return schedulerReplacementServing(target.endpoint, pids);
    }))(receipt, stoppedPids);
    if (!serving) { kept.push(receipt); continue; }
    if (!clearPendingTeardown(receipt.nonce)) {
      console.warn(`⚠️  Could not remove the restart's teardown receipt ${pendingTeardownPathFor(receipt.nonce)}; the next 'ocx stop' finishes it.`);
    }
  }
  return kept;
}

const RESTART_RECEIPT_KEPT = "The restart kept its teardown receipt, because client routing still points at the stopped proxy's port and no replacement was proven to serve it. "
  + "Once a proxy serves there, run 'ocx stop' and then 'ocx service start'; if none does, 'ocx stop' restores native client routing.";

/** What a scheduler restart's stops kept, shared with the wrapper that settles it on failure. */
type RestartReceiptState = { held: HeldRestartReceipt[]; startIssued: boolean };
/**
 * The two CLI verbs `repairService` serves. They differ on ONE platform and ONE case: a
 * macOS job that is already loaded from the current plist, which `repair` must not touch and
 * `restart` must restart.
 */
export type ServiceRepairVerb = "repair" | "restart";

export interface RepairServiceDeps extends RuntimePreflightDeps {
  inspectSupervision?: SupervisionInspector;
  supervisionLatch?: SupervisionLatch;
  diagnose?: () => ServiceDiagnostic;
  assertEnv?: () => void;
  assertAuth?: () => void;
  writeSchedulerAssets?: (runtime: DurableBunRuntime) => void;
  /** Captures the current scheduler assets and returns their restore; see snapshotWindowsSchedulerAssets. */
  snapshotSchedulerAssets?: () => () => void;
  stopScheduler?: () => void;
  /** Same installation-scoped wrapper cleanup used by service stop/install. */
  killServiceWrappers?: () => void;
  /** Bounded post-stop respawn verification; null proves no proxy answered. */
  schedulerProxyStillLive?: () => Promise<{ port: number } | null>;
  /**
   * Stops the home-verified tracked proxy with a receipt-backed deferred stop, and throws for a proxy
   * that still answers but cannot be verified (stopTrackedProxyForServiceRestart); failures propagate.
   */
  stopTrackedProxy?: () => Promise<unknown>;
  /**
   * After the scheduler start, whether a replacement other than the stopped pids serves; only then
   * does the restart release the deferred-teardown receipts its stops kept (schedulerReplacementServing).
   */
  confirmSchedulerReplacement?: (receipt: HeldRestartReceipt, stoppedPids: readonly number[]) => Promise<boolean>;
  /** Refuses a restart that must not stop this home's live proxy (assertSchedulerRestartTargetAllowed). */
  assertSchedulerRestartTarget?: () => Promise<void>;
  startScheduler?: () => void;
  writeSchedulerState?: (runtime: DurableBunRuntime) => void;
  writeNativeState?: (runtime: DurableBunRuntime) => void;
  repairNative?: (runtime: DurableBunRuntime) => void | Promise<void>;
  repairLaunchd?: () => LaunchdInstallOutcome | void;
  repairSystemd?: () => void;
  /** Restarts a launchd job the install path deliberately left alone. `restart` only. */
  restartLaunchd?: () => void;
  /** Resolves the recorded runtime owner across every state path. */
  readOwnership?: () => ServiceOwnershipResolution;
  /**
   * Which CLI verb is being served. `repair` must leave a healthy service alone — that no-op
   * IS the #4236 fix — while `restart` promises a new process, so on darwin it kicks the job
   * the no-op path did not touch. Windows (stop + start) and Linux
   * (`systemctl --user restart`) already restart unconditionally, so neither reads this.
   */
  verb?: ServiceRepairVerb;
  /** Reads live registered task XML; may be called again after failure, empty when unreadable. */
  readSchedulerXml?: () => string;
  /** Bounded wait before retrying an unreadable live registration snapshot. */
  settleSchedulerRead?: (delayMs: number) => void | Promise<void>;
  /** Proves fixed-name task presence when its live XML is empty or unreadable. */
  probeScheduler?: () => WindowsSchedulerTaskProbe;
  /** Re-registers the task from freshly staged XML. Used only when the definition is stale. */
  reregisterScheduler?: (attemptNonce: string, expectedExistingXml: string) => Promise<void>;
  /** Publishes the captured registration only when the fixed task name remains absent. */
  restoreSchedulerIfAbsent?: (registeredXml: string) => Promise<void>;
  /** Resolves the account the registered triggers must match; null when it cannot be resolved. */
  resolveExpectedUserId?: (registeredXml: string) => ExpectedWindowsTaskUserId | null;
  /** Exact scheduler action values used by validation; defaults to the installed paths. */
  schedulerWscript?: string;
  schedulerLauncher?: string;
  /** Test seam — defaults to process.platform so Linux CI cannot hit real installSystemd. */
  platform?: NodeJS.Platform;
  prepareDisconnectedClientRestart?: () => Promise<void>;
  /** Test seam for a recorded temporary launcher. */
  launcherPathDiagnostic?: () => string | null;
}

/**
 * Why a repair stops when something other than this CLI owns the runtime.
 *
 * The npm service registration is KEPT — the maintainer's decision is that a user's install
 * is never deleted — so the recorded owner is the only thing standing between a takeover the
 * user consented to and the next `ocx service repair`, which would re-enable and restart the
 * npm launcher without mentioning it. Repair runs incidentally: a tray helper, `ocx update`,
 * a doctor suggestion. `install` is the deliberate act, so `install` is the verb that takes
 * ownership back.
 */
export function foreignServiceOwnerRefusal(ownership: ServiceOwnership, action = "repair"): string {
  return `Background service ${action} stopped: the desktop app owns the runtime `
    + `(install ${ownership.installId}, consent generation ${ownership.consentGeneration}).\n`
    + "The service registration was left exactly as it is — not re-enabled, not rewritten and not restarted.\n"
    + "Quit the desktop app and run 'ocx service install' to hand the runtime back to this CLI.";
}

/**
 * Why an unreadable or contradictory record stops a repair too.
 *
 * Collapsing "I could not read the claim" into "there is no claim" is how a consented
 * takeover gets reactivated by a permissions error. `ocx service install` is deliberately
 * not gated, so this never leaves an operator without a way forward.
 */
export function unknownServiceOwnerRefusal(reason: string, action = "repair"): string {
  return `Background service ${action} stopped: ${reason}, so the runtime's recorded owner could `
    + "not be determined.\n"
    + "The service registration was left exactly as it is — not re-enabled, not rewritten and not restarted.\n"
    + "Repair the service-state file or its permissions, then run 'ocx service install' to take the runtime back.";
}

async function assertSchedulerSnapshotBeforeStart(
  readSchedulerXml: () => string,
  expectedXml: string,
  settle: (delayMs: number) => void | Promise<void>,
  changedMessage: string,
  unreadableMessage: string,
): Promise<void> {
  await assertSchedulerRegistrationBeforeStart(
    readSchedulerXml,
    settle,
    currentXml => windowsSchedulerRegistrationMatchesSnapshot(currentXml, expectedXml),
    changedMessage,
    unreadableMessage,
  );
}

export async function assertSchedulerRegistrationBeforeStart(
  readSchedulerXml: () => string,
  settle: (delayMs: number) => void | Promise<void>,
  matchesExpected: (currentXml: string) => boolean,
  changedMessage: string,
  unreadableMessage: string,
): Promise<void> {
  for (let attempt = 0; attempt <= SCHEDULER_SETTLE_DELAYS_MS.length; attempt += 1) {
    let beforeStartXml = "";
    try {
      beforeStartXml = readSchedulerXml();
    } catch {
      // Treat query errors like the default reader's empty result and retry below.
    }
    if (beforeStartXml.trim()) {
      if (!matchesExpected(beforeStartXml)) {
        throw new Error(changedMessage);
      }
      return;
    }
    const delayMs = SCHEDULER_SETTLE_DELAYS_MS[attempt];
    if (delayMs === undefined) break;
    await settle(delayMs);
  }
  throw new Error(unreadableMessage);
}

/**
 * Repair the already-installed background-service backend without switching managers.
 *
 * Windows scheduler: rewrite assets + stop/start; stale definitions are refreshed and may elevate.
 * Windows native: WinSW asset rewrite + restart (skips `install /p` when present).
 * macOS/Linux: re-run the user-level install/reload path.
 */
export async function repairService(deps: RepairServiceDeps = {}): Promise<void> {
  const restart: RestartReceiptState = { held: [], startIssued: false };
  try {
    await repairServiceWith(deps, restart);
  } catch (error) {
    if (restart.held.length === 0) throw error;
    // A recovery start may have brought a proxy back on the stopped endpoint; only then may the
    // receipt go. Otherwise the error names what was kept and how to finish it.
    const kept = restart.startIssued ? await releaseRestartReceipts(restart.held, deps.confirmSchedulerReplacement) : restart.held;
    throw kept.length > 0 ? withContext(error, RESTART_RECEIPT_KEPT) : error;
  }
}

async function repairServiceWith(deps: RepairServiceDeps, restart: RestartReceiptState): Promise<void> {
  const latch = deps.supervisionLatch ?? createSupervisionLatch();
  assertNoDesktopSupervision(deps.inspectSupervision, latch);
  const diagnose = deps.diagnose ?? diagnoseService;
  const platform = deps.platform ?? process.platform;
  const diag = diagnose();
  if (!diag.supported) {
    throw new Error(`Background service is unsupported (${diag.summary}).`);
  }
  if (diag.conflict) {
    throw new Error(
      "Cannot repair while Task Scheduler and native WinSW are both present. "
        + "Run 'ocx service uninstall' then reinstall one backend with 'ocx service install'.",
    );
  }
  if (!diag.installed) {
    throw new Error("Background service is not installed. Run 'ocx service install' first.");
  }

  // Before anything is asserted, written, stopped or started. A repair that has already
  // rewritten the assets has changed the thing it was supposed to leave alone.
  const ownership = (deps.readOwnership ?? resolveServiceOwnership)();
  if (ownership.kind === "unknown") throw new Error(unknownServiceOwnerRefusal(ownership.reason));
  // `!== "cli"` rather than `=== "desktop"`: this is the CLI's own repair path, so any owner
  // that is not this CLI is one whose runtime it must not touch.
  if (ownership.kind === "owned" && ownership.ownership.owner !== "cli") {
    throw new Error(foreignServiceOwnerRefusal(ownership.ownership));
  }

  (deps.assertEnv ?? assertServiceEnvironmentMatchesInstall)();
  (deps.assertAuth ?? assertServiceAuthEnvironment)();
  const runtime = Object.freeze({ ...(deps.selectRuntime ?? durableBunRuntime)() });
  const configDir = (deps.configDir ?? getConfigDir)();
  (deps.assertRuntimeWritable ?? assertSelectedRuntimeWritable)(runtime, configDir, { platform, rootWasAbsent: !existsSync(configDir) });

  const temporaryLauncher = (deps.launcherPathDiagnostic ?? (() => serviceLauncherPathDiagnostic(undefined, platform, true)))();
  if (temporaryLauncher) console.warn(`⚠️ ${temporaryLauncher}`);

  const assertRestartOwnership = () => {
    assertNoDesktopSupervision(deps.inspectSupervision, latch);
    (deps.assertEnv ?? assertServiceEnvironmentMatchesInstall)();
    const current = (deps.readOwnership ?? resolveServiceOwnership)();
    if (!Bun.deepEquals(current, ownership, true)) throw new Error("Service ownership changed during restart.");
  };
  // Ends the task instance only. The wrappers it leaves running still supervise the proxy, so they
  // are cleaned up after that proxy accepted its stop (below): removing them first left a survivor
  // whose stop was refused or unverifiable with nothing to restart it (#8416).
  let schedulerStopped = false;
  // Deferred-teardown receipts the scheduler restart's stops kept: client routing still names the
  // stopped endpoints, so they are released only once a replacement serves (end of the scheduler path).
  const holdRestartReceipt = (receipt: HeldRestartReceipt) => { restart.held.push(receipt); };
  const stopSchedulerForRestart = (beforeStop: () => void) => {
    if (schedulerStopped) return;
    beforeStop();
    (deps.stopScheduler ?? stopWindows)();
    schedulerStopped = true;
  };
  // Defer cleanup until the selected backend's registration has been verified.
  const prepareDisconnectedRestart = async (verifyRegistration?: () => void) => {
    if (deps.verb !== "restart") return;
    const beforeStop = () => { assertRestartOwnership(); verifyRegistration?.(); };
    beforeStop();
    const schedulerBackend = platform === "win32" && diag.backend !== "native";
    await (deps.prepareDisconnectedClientRestart ?? (() => prepareDisconnectedClientServiceRestart({
      beforeStop,
      ...(schedulerBackend ? { stop: async (pid: number) => {
        const { stopProxyForServiceRestart } = await import("./restart-proxy-stop");
        return stopProxyForServiceRestart(pid, holdRestartReceipt);
      } } : {}),
      stopManager: async () => {
        const { platformOps } = await import("./orchestration");
        const ops = platformOps(diag.backend === "native" ? "native" : "scheduler", { platform });
        if (!ops) throw new Error("Service manager is unavailable; restart stopped.");
        // The import yields; repeat ownership and registration proof immediately before stop.
        beforeStop();
        if (platform === "win32" && diag.backend !== "native") {
          stopSchedulerForRestart(beforeStop);
          return;
        }
        ops.stop();
      },
    })))();
  };

  if (platform === "win32") {
    if (diag.backend === "native") {
      if (deps.verb === "restart") await prepareDisconnectedRestart();
      await (deps.repairNative ?? ((selected: DurableBunRuntime) => installWinswService(defaultWinswEntry(serviceSourceDir, selected))))(runtime);
      assertNoDesktopSupervision(deps.inspectSupervision, latch);
      (deps.writeNativeState ?? ((selected: DurableBunRuntime) => writeServiceInstallState("native", undefined, {}, selected)))(runtime);
      return;
    }
    const readSchedulerXml = deps.readSchedulerXml ?? statusWindowsXml;
    let registeredXml = "";
    try {
      registeredXml = readSchedulerXml();
    } catch {
      throw new Error(
        "Task Scheduler registration could not be read; repair stopped before changing or starting the service.",
      );
    }
    if (!registeredXml.trim()) {
      throw new Error(
        "Task Scheduler registration is empty or unreadable; repair stopped before changing or starting the service.",
      );
    }
    // Judge the definition against the same effective account the diagnostic uses. Relying on
    // the cached identity alone would make a scoped task this very version wrote look foreign
    // in a fresh process, and the message below would then name the wrong cause.
    const expectedUserId = (deps.resolveExpectedUserId ?? resolveWindowsTaskDiagnosticUserId)(registeredXml);
    const registrationHealthy = windowsTaskRegistrationHealthy(
      registeredXml,
      deps.schedulerWscript,
      deps.schedulerLauncher,
      expectedUserId,
    );
    const expectedValues = expectedUserId === null
      ? []
      : typeof expectedUserId === "string" ? [expectedUserId] : expectedUserId;
    const preferredSid = expectedValues[0];
    const triggers = taskXmlSection(taskXmlWithoutCommentsAndCdata(registeredXml), "Triggers");
    // An exact legacy account name is safe to recognize, but rewrite it to the
    // locale-independent SID while repair already owns the mutation boundary.
    const identityUpgradeNeeded = registrationHealthy
      && preferredSid !== undefined
      && !windowsTaskHasSessionRecoveryTriggers(triggers, preferredSid);
    // Omitted Priority also defaults to 7; background priority can starve health probes under CPU load.
    const priorityUpgradeNeeded = registrationHealthy && taskXmlOptionalValueEquals(
      taskXmlSection(taskXmlWithoutCommentsAndCdata(registeredXml), "Settings"), "Priority", "7",
    );
    const refreshableLegacy = windowsTaskRegistrationRefreshableLegacy(
      registeredXml,
      deps.schedulerWscript,
      deps.schedulerLauncher,
    );
    if (!registrationHealthy && !refreshableLegacy) {
      const scopedButUnresolved = expectedUserId === null
        && taskXmlElementCount(
          taskXmlSection(taskXmlWithoutCommentsAndCdata(registeredXml), "Triggers"),
          "UserId",
        ) > 0;
      throw new Error(
        scopedButUnresolved
          ? "The registered Task Scheduler triggers name an account, but the current Windows identity could not be resolved, so the registration could not be verified. "
            + "It was preserved and not replaced; re-run repair once the account can be resolved."
          : "Task Scheduler registration is not a recognized legacy OpenCodex definition; it was preserved for manual review.",
      );
    }
    const verifyRegistrationBeforeStop = () => {
      let currentXml = "";
      try { currentXml = readSchedulerXml(); } catch { /* Refuse unreadable registration below. */ }
      if (!currentXml.trim()) throw new Error("Task Scheduler registration became unreadable before stop; it was preserved and not stopped.");
      if (!windowsSchedulerRegistrationMatchesSnapshot(currentXml, registeredXml)) {
        throw new Error("Task Scheduler registration changed before stop; it was preserved and not stopped.");
      }
    };
    // Capture the assets the verified registration runs before anything is stopped. A snapshot that
    // cannot be read (an ACL refusal) then refuses while the service is still running, rather than
    // after the stop, where the failed-rewrite recovery below could never start it again.
    const restoreAssets = (deps.snapshotSchedulerAssets ?? snapshotWindowsSchedulerAssets)();
    if (deps.verb === "restart") {
      await (deps.assertSchedulerRestartTarget ?? (async () => {
        const { assertSchedulerRestartTargetAllowed } = await import("./orchestration");
        return assertSchedulerRestartTargetAllowed();
      }))();
      await prepareDisconnectedRestart(verifyRegistrationBeforeStop);
      assertRestartOwnership();
      verifyRegistrationBeforeStop();
      stopSchedulerForRestart(() => { assertRestartOwnership(); verifyRegistrationBeforeStop(); });
      // `schtasks /end` does not reach the wrapper's child, so a Home or a connected Child proxy
      // survives it. Stop that home-verified proxy with a receipt-backed deferred stop: the task is
      // still registered, so a bare /api/stop is refused as respawnable, and this restart is what
      // verifies the respawn window below. A refused stop propagates with the wrappers untouched.
      const stopTracked = deps.stopTrackedProxy ?? (async () => {
        const { stopTrackedProxyForServiceRestart } = await import("./orchestration");
        return stopTrackedProxyForServiceRestart(holdRestartReceipt);
      });
      const stillLive = deps.schedulerProxyStillLive ?? (async () => {
        const { proxyStillLiveAfterStop } = await import("./orchestration");
        return proxyStillLiveAfterStop({ canRespawn: true });
      });
      assertRestartOwnership();
      verifyRegistrationBeforeStop();
      try {
        await stopTracked();
      } catch (error) {
        throw withContext(error, "The scheduler wrappers that supervise it were left in place.");
      }
      assertRestartOwnership();
      verifyRegistrationBeforeStop();
      (deps.killServiceWrappers ?? (() => killWindowsSchedulerWrappers({
        scriptPath: windowsServiceScriptPath(),
        launcherPath: windowsLauncherVbsPath(),
      })))();
      let live = await stillLive();
      if (live) {
        // A wrapper can respawn its child between the proxy's exit and the cleanup above. Nothing
        // brings it back once the wrappers are gone, so stop that one the same way and look again.
        // The wrappers are already gone here: a stop that fails now leaves that proxy unsupervised,
        // and the restart says so instead of implying anything still watches it.
        const unsupervised = "A proxy a scheduler wrapper restarted before the wrapper cleanup is still running, and the wrappers that supervised it were already removed, so nothing restarts it if it exits. "
          + "Stop it with 'ocx stop', then run 'ocx service restart' again.";
        assertRestartOwnership();
        verifyRegistrationBeforeStop();
        try {
          await stopTracked();
          live = await stillLive();
        } catch (error) {
          throw withContext(error, unsupervised);
        }
        if (live) throw new Error(unsupervised);
      }
      assertRestartOwnership();
      verifyRegistrationBeforeStop();
    } else {
      try { (deps.stopScheduler ?? stopWindows)(); } catch { /* not running */ }
    }
    // The proxy is stopped now. A rewrite that fails (a read-only asset, an ACL refusal) must not
    // leave it stopped: put the previous assets back and start the registration verified above,
    // which still runs them (the snapshot above), then report the original failure.
    try {
      (deps.writeSchedulerAssets ?? writeWindowsSchedulerAssets)(runtime);
    } catch (err) {
      const recoveryErrors: unknown[] = [];
      try { restoreAssets(); } catch (error) { recoveryErrors.push(error); }
      if (recoveryErrors.length === 0) {
        try {
          await assertSchedulerSnapshotBeforeStart(
            readSchedulerXml,
            registeredXml,
            deps.settleSchedulerRead ?? settleDelay,
            "Task Scheduler registration changed after the failed asset write; it was preserved and not started.",
            "Task Scheduler registration became unreadable after the failed asset write; it was preserved and not started.",
          );
          assertNoDesktopSupervision(deps.inspectSupervision, latch);
          (deps.startScheduler ?? startWindows)(); restart.startIssued = true;
        } catch (error) {
          recoveryErrors.push(error);
        }
      }
      if (recoveryErrors.length > 0) {
        throw new AggregateError([err, ...recoveryErrors], "Scheduler assets could not be written, and the previous registration was not restarted.");
      }
      throw err;
    }
    // Rewriting the on-disk assets does not touch the definition Task Scheduler holds, so a
    // task registered by an older version keeps its old triggers forever: status reports it
    // stale, tells the user to run repair, and repair changes nothing it complains about.
    // Re-register only when the registered XML is actually stale, so the ordinary repair
    // stays free of `schtasks /create` and its UAC prompt.
    let startExpectedXml = registeredXml;
    if (!registrationHealthy || identityUpgradeNeeded || priorityUpgradeNeeded) {
      // The task was stopped above, so a failed replacement must not exit here: `/create /f`
      // can be rejected, elevation can be cancelled, and staging or verification can fail.
      // Any of those would leave a previously runnable proxy stopped and the user worse off
      // than before the repair. Restart the definition still registered and surface the
      // original failure instead.
      const attemptNonce = randomUUID();
      try {
        await (deps.reregisterScheduler ?? reregisterWindowsSchedulerTask)(attemptNonce, registeredXml);
        let replacementXml = "";
        try {
          replacementXml = readSchedulerXml();
        } catch {
          throw new Error("The refreshed Task Scheduler registration could not be read back.");
        }
        if (
          !windowsTaskRegistrationHealthy(replacementXml)
          || !windowsTaskRegistrationOwnedByAttempt(replacementXml, attemptNonce)
        ) {
          throw new Error(
            "The refreshed Task Scheduler registration failed live shape or attempt-ownership verification.",
          );
        }
        startExpectedXml = replacementXml;
      } catch (err) {
        const recoveryErrors: unknown[] = [];
        let restartExpectedXml: string | null = null;
        let currentXml: string | null = null;
        try {
          currentXml = readSchedulerXml();
        } catch {
          recoveryErrors.push(new Error(
            "Task Scheduler state became unreadable after the failed replacement; it was preserved and not started.",
          ));
        }

        if (currentXml !== null) {
          if (windowsSchedulerRegistrationMatchesSnapshot(currentXml, registeredXml)) {
            restartExpectedXml = registeredXml;
          } else if (currentXml.trim()) {
            const attemptOwned = windowsTaskRegistrationOwnedByAttempt(currentXml, attemptNonce);
            if (attemptOwned && windowsTaskRegistrationHealthy(currentXml)) {
              restartExpectedXml = currentXml;
            } else {
              recoveryErrors.push(new Error(
                attemptOwned
                  ? "The failed repair left an unhealthy attempt-owned registration; it was preserved and not started."
                  : windowsTaskRegistrationHealthy(currentXml)
                    ? "A different healthy OpenCodex Task Scheduler registration appeared during repair; it was preserved and not started."
                    : "A different or unhealthy Task Scheduler registration appeared during repair; it was preserved and not started.",
              ));
            }
          } else {
            let probe: WindowsSchedulerTaskProbe;
            try {
              probe = (deps.probeScheduler ?? (() => probeWindowsSchedulerTask(TASK)))();
            } catch {
              probe = { status: "unknown", detail: "presence probe failed" };
            }
            if (probe.status === "absent") {
              try {
                assertNoDesktopSupervision(deps.inspectSupervision, latch);
                await (deps.restoreSchedulerIfAbsent ?? restoreWindowsSchedulerTaskIfAbsent)(registeredXml);
                restartExpectedXml = registeredXml;
              } catch (error) {
                recoveryErrors.push(error);
              }
            } else {
              recoveryErrors.push(new Error(probe.status === "present"
                ? "A Task Scheduler registration is present but its XML is unreadable; it was preserved and not started."
                : `Task Scheduler state is unknown after the failed replacement (${probe.detail}); no registration was overwritten or started.`));
            }
          }
        }

        if (restartExpectedXml !== null) {
          try {
            await assertSchedulerSnapshotBeforeStart(
              readSchedulerXml,
              restartExpectedXml,
              deps.settleSchedulerRead ?? settleDelay,
              "The Task Scheduler registration changed again before restart; the newer definition was preserved and not started.",
              "Task Scheduler state remained unreadable before restart; the registration was preserved and not started.",
            );
            assertNoDesktopSupervision(deps.inspectSupervision, latch);
            (deps.startScheduler ?? startWindows)(); restart.startIssued = true;
          } catch (error) {
            recoveryErrors.push(error);
          }
        }
        if (recoveryErrors.length > 0) {
          throw new AggregateError(
            [err, ...recoveryErrors],
            "Task Scheduler repair failed; concurrent or unverified scheduler state was preserved.",
          );
        }
        throw err;
      }
    }
    // The final live read is the proof that `/run` still targets the definition this repair
    // verified. A failed `schtasks /query` becomes an empty string, so allow only a bounded
    // retry for that unreadable state. A readable mismatch is authoritative and fails
    // immediately; presence alone cannot prove that the fixed-name task still has our XML.
    await assertSchedulerSnapshotBeforeStart(
      readSchedulerXml,
      startExpectedXml,
      deps.settleSchedulerRead ?? settleDelay,
      "Task Scheduler registration changed before restart; the current definition was preserved and not started.",
      "Task Scheduler registration became unreadable before restart; it was preserved and not started.",
    );
    assertNoDesktopSupervision(deps.inspectSupervision, latch);
    (deps.startScheduler ?? startWindows)(); restart.startIssued = true;
    (deps.writeSchedulerState ?? ((selected: DurableBunRuntime) => writeServiceInstallState("scheduler", undefined, {}, selected)))(runtime);
    const kept = await releaseRestartReceipts(restart.held, deps.confirmSchedulerReplacement);
    restart.held = [];
    if (kept.length > 0) console.warn(`⚠️  ${RESTART_RECEIPT_KEPT}`);
    return;
  }
  if (deps.verb === "restart") await prepareDisconnectedRestart();
  if (platform === "darwin") {
    const outcome = (deps.repairLaunchd ?? installLaunchd)();
    // `installLaunchd` is the only function that knows whether it published anything, and its
    // no-op path leaves the live process running on purpose. `repair` wants exactly that;
    // `restart` would otherwise restart NOTHING on a healthy hub and send the operator to run
    // `launchctl kickstart -k` by hand, which is the opposite of what these verbs are for.
    if ((deps.verb ?? "repair") === "restart" && outcome?.reloaded === false) {
      (deps.restartLaunchd ?? restartLaunchdJob)();
    }
    return;
  }
  if (platform === "linux") {
    // `installSystemd` ends in `systemctl --user restart`, unconditionally, so the unit is
    // restarted whichever verb asked — there is no no-op path here to compensate for.
    (deps.repairSystemd ?? installSystemd)();
    return;
  }
  throw new Error(`Background service repair is unsupported on ${platform}.`);
}
