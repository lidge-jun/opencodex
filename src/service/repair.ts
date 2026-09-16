import { randomUUID } from "node:crypto";
import { defaultWinswEntry, installWinswService } from "../lib/winsw";
import { resolveWindowsTaskDiagnosticUserId, diagnoseService } from "./diagnostics";
import type { ServiceDiagnostic } from "./diagnostics";
import { assertServiceEnvironmentMatchesInstall, assertServiceAuthEnvironment } from "./guards";
import { installLaunchd, restartLaunchdJob } from "./launchd";
import type { LaunchdInstallOutcome } from "./launchd";
import { TASK, writeServiceInstallState, serviceSourceDir } from "./state";
import { installSystemd } from "./systemd";
import { writeWindowsSchedulerAssets, reregisterWindowsSchedulerTask, windowsSchedulerRegistrationMatchesSnapshot, restoreWindowsSchedulerTaskIfAbsent, startWindows, stopWindows, statusWindowsXml } from "./windows-ops";
import { probeWindowsSchedulerTask, SCHEDULER_SETTLE_DELAYS_MS, settleDelay } from "./windows-scheduler";
import type { WindowsSchedulerTaskProbe } from "./windows-scheduler";
import { taskXmlSection, taskXmlWithoutCommentsAndCdata, taskXmlElementCount, taskXmlOptionalValueEquals, windowsTaskRegistrationOwnedByAttempt, windowsTaskHasSessionRecoveryTriggers, windowsTaskRegistrationHealthy, windowsTaskRegistrationRefreshableLegacy } from "./windows-taskxml";
import type { ExpectedWindowsTaskUserId } from "./windows-taskxml";
import { win32 } from "node:path";

/**
 * The two CLI verbs `repairService` serves. They differ on ONE platform and ONE case: a
 * macOS job that is already loaded from the current plist, which `repair` must not touch and
 * `restart` must restart.
 */
export type ServiceRepairVerb = "repair" | "restart";

export interface RepairServiceDeps {
  diagnose?: () => ServiceDiagnostic;
  assertEnv?: () => void;
  assertAuth?: () => void;
  writeSchedulerAssets?: () => void;
  stopScheduler?: () => void;
  startScheduler?: () => void;
  writeSchedulerState?: () => void;
  writeNativeState?: () => void;
  repairNative?: () => void | Promise<void>;
  repairLaunchd?: () => LaunchdInstallOutcome | void;
  repairSystemd?: () => void;
  /** Restarts a launchd job the install path deliberately left alone. `restart` only. */
  restartLaunchd?: () => void;
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

  (deps.assertEnv ?? assertServiceEnvironmentMatchesInstall)();
  (deps.assertAuth ?? assertServiceAuthEnvironment)();

  if (platform === "win32") {
    if (diag.backend === "native") {
      await (deps.repairNative ?? (() => installWinswService(defaultWinswEntry(serviceSourceDir))))();
      (deps.writeNativeState ?? (() => writeServiceInstallState("native")))();
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
    try { (deps.stopScheduler ?? stopWindows)(); } catch { /* not running */ }
    (deps.writeSchedulerAssets ?? writeWindowsSchedulerAssets)();
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
            (deps.startScheduler ?? startWindows)();
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
    (deps.startScheduler ?? startWindows)();
    (deps.writeSchedulerState ?? (() => writeServiceInstallState("scheduler")))();
    return;
  }
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
