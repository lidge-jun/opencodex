import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { winswXmlPath } from "../lib/winsw";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import { parseBakedListenPort } from "./health";
import { windowsServiceScriptPath } from "./state";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";
import { runWindowsElevatedScheduledTaskRegistration, WindowsSchtasksError } from "../lib/windows-elevation";
import { defaultWinswEntry, installWinswService, statusWinswRaw, uninstallWinswService, WINSW_SERVICE_ID, type WinswStatus } from "../lib/winsw";
import { forgetEphemeralSecretDir, forgetEphemeralSecretPath, hardenSecretDir } from "../lib/windows-secret-acl";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { killWindowsSchedulerWrappers } from "../lib/windows-service-wrappers";
import { isTestHomeGuardArmed } from "../lib/test-home-guard";
import { writeServiceApiTokenFile } from "./guards";
import type { ServiceStopOutcome } from "./orchestration";
import { TASK, windowsLauncherVbsPath, windowsTaskXmlPath, serviceStatePath, writeServiceInstallState, serviceSourceDir } from "./state";
import { decodeSchtasksOutput, querySchtasks, schtasks, type WindowsSchedulerTaskProbe, schtasksErrorDetail, probeWindowsSchedulerTask, rollbackWindowsSchedulerTaskOwnedByAttempt } from "./windows-scheduler";
import { buildWindowsServiceScript, buildWindowsSchtasksCreateArgs, buildWindowsSchtasksCreateArgsForXml, buildWindowsLauncherVbs, resolvedWindowsTaskSid, buildWindowsTaskXmlDocument, windowsTaskRegistrationOwnedByAttempt, windowsTaskRegistrationHealthy } from "./windows-taskxml";

/** The `--port <n>` baked into the Task Scheduler wrapper. Windows scheduler backend. */
export function windowsListenPort(deps: { readScript?: () => string } = {}): number | null {
  return parseBakedListenPort(deps.readScript ?? (() => readFileSync(windowsServiceScriptPath(), "utf8")));
}

/**
 * The `--port <n>` baked into the WinSW XML's `<arguments>`. Windows native backend.
 *
 * Separate from {@link windowsListenPort} rather than one function branching on
 * `readServiceBackend()`: the recorded backend can disagree with what is actually on
 * disk (the `stale` / `backendStateMismatch` cases `deriveWindowsServiceDiagnostic`
 * exists to catch), and a reader that trusted it would then read the wrong file.
 * Each returns null when its own artifact is absent, so the chain needs no branch.
 */
export function winswListenPort(deps: { readXml?: () => string } = {}): number | null {
  return parseBakedListenPort(deps.readXml ?? (() => readFileSync(winswXmlPath(), "utf8")));
}

/**
 * Write a service definition with owner-only permissions.
 *
 * These files carry the outbound proxy environment (#2107), and a proxy URL routinely
 * carries `user:password`. `writeFileSync` without a mode lands at 0644 under the default
 * umask, so the credential would be world-readable on a shared host. Every other
 * secret-bearing write in this file already uses 0600 — the service API token and the
 * install state — and a service definition holding a proxy credential belongs in the same
 * class.
 *
 * The explicit `chmodSync` is not redundant: `mode` only applies when the file is
 * created, so an install over a definition left at 0644 by an earlier version would keep
 * the loose mode.
 *
 * On Windows the POSIX bits are advisory, so the ACL is the real boundary — and whether it
 * may soft-fail depends on what the definition actually contains. A definition carrying a
 * proxy credential is a secret publication and fails closed like the API token and the
 * install state do; one carrying only paths and a port is not worth refusing an install
 * over, since before #2107 these files had no hardening at all and a failure here would
 * regress a user who has no credential to protect.
 */
export function writeServiceDefinitionFile(path: string, content: string, encoding: "utf8" | "utf16le"): void {
  writeFileSync(path, content, { encoding, mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* superseded by the Windows ACL below */ }
  if (process.platform === "win32") {
    hardenSecretPath(path, { required: definitionCarriesCredential(content) });
  }
}

/**
 * Does this service definition embed a credential-bearing proxy URL?
 *
 * Only the userinfo form leaks something: `http://user:pass@host` in any of the four proxy
 * variables. A bare `http://127.0.0.1:7890` is not a secret, and treating it as one would
 * make an icacls stall fail an install that had nothing to protect.
 *
 * The scan is over any URL in the rendered definition rather than over a `KEY=value` shape,
 * because the three formats render differently — systemd writes `Environment="K=V"`, the
 * plist writes `<key>K</key><string>V</string>`, and the Windows wrapper writes
 * `set "K=V"`. Keying on the assignment syntax silently missed the plist.
 */
export function definitionCarriesCredential(content: string): boolean {
  // A userinfo authority: scheme, then anything that is not a delimiter, then '@'.
  return /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>/@]+@/i.test(content);
}

// ── Windows (Task Scheduler) ──
/**
 * In-place service-asset write that tolerates the transient EBUSY/EPERM/EACCES Windows
 * throws while the just-ended task's cmd.exe (or an AV scanner) still holds the file.
 */
function writeServiceAssetWithRetry(path: string, content: string, encoding: "utf8" | "utf16le"): void {
  for (let attempt = 0; ; attempt++) {
    try {
      writeServiceDefinitionFile(path, content, encoding);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 2 || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw err;
      Bun.sleepSync(150);
    }
  }
}

/**
 * Rewrite on-disk scheduler assets (script/VBS/XML) without itself registering the task.
 * Fresh install creates it afterwards; repair does so only when the live definition is stale.
 */
export function writeWindowsSchedulerAssets(): void {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  const script = windowsServiceScriptPath();
  writeServiceAssetWithRetry(script, buildWindowsServiceScript(), "utf8");
  // UTF-16LE + BOM: a BOM-less UTF-8 VBS mis-decodes non-ASCII (e.g. Korean) profile
  // paths on some WSH/codepage combinations — same contract as the task XML below.
  writeServiceAssetWithRetry(windowsLauncherVbsPath(), `\uFEFF${buildWindowsLauncherVbs(script)}`, "utf16le");
  writeServiceAssetWithRetry(
    windowsTaskXmlPath(),
    buildWindowsTaskXmlDocument(script, windowsLauncherVbsPath()),
    "utf16le",
  );
}

const WINDOWS_SCHEDULER_STAGE_PREFIX = "opencodex-service-stage-";

const ownedWindowsSchedulerStages = new Set<string>();

export interface WindowsSchedulerRegistrationStageDeps {
  createStageDir?: () => string;
  hardenDir?: (path: string) => void;
  writeXml?: (path: string, contents: string) => void;
  hardenPath?: (path: string) => void;
  removeStageDir?: (path: string) => void;
}

function cleanupWindowsSchedulerStage(
  stageDir: string,
  xmlPath: string,
  removeStageDir: (path: string) => void,
): void {
  let cleanupError: unknown;
  try {
    unlinkSync(xmlPath);
    forgetEphemeralSecretPath(xmlPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      forgetEphemeralSecretPath(xmlPath);
    } else {
      cleanupError = error;
    }
  }
  try {
    removeStageDir(stageDir);
    forgetEphemeralSecretDir(stageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      forgetEphemeralSecretDir(stageDir);
    } else if (cleanupError) {
      throw new AggregateError([cleanupError, error], "Task Scheduler staging cleanup failed.");
    } else {
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
}

export function stageWindowsSchedulerRegistrationXml(
  attemptNonce: string,
  deps: WindowsSchedulerRegistrationStageDeps = {},
): string {
  const createStageDir = deps.createStageDir
    ?? (() => mkdtempSync(join(tmpdir(), WINDOWS_SCHEDULER_STAGE_PREFIX)));
  const hardenDir = deps.hardenDir
    ?? ((path: string) => { hardenSecretDir(path, { required: true }); });
  const writeXml = deps.writeXml ?? ((path: string, contents: string) => {
    writeFileSync(path, contents, { encoding: "utf16le", flag: "wx", mode: 0o600 });
  });
  const hardenPath = deps.hardenPath
    ?? ((path: string) => { hardenSecretPath(path, { required: true }); });
  const removeStageDir = deps.removeStageDir
    ?? ((path: string) => { rmdirSync(path); });

  let stageDir: string | null = null;
  let xmlPath: string | null = null;
  try {
    stageDir = createStageDir();
    try { chmodSync(stageDir, 0o700); } catch { /* required Windows ACL is authoritative */ }
    hardenDir(stageDir);
    xmlPath = join(stageDir, "task.xml");
    // This document points at the canonical launcher but does not publish or rewrite it.
    // The hardened private directory prevents another local account from replacing the
    // document while UAC is pending; the file harden independently proves its identity.
    writeXml(
      xmlPath,
      buildWindowsTaskXmlDocument(
        windowsServiceScriptPath(),
        windowsLauncherVbsPath(),
        attemptNonce,
        resolvedWindowsTaskSid(),
      ),
    );
    hardenPath(xmlPath);
    ownedWindowsSchedulerStages.add(xmlPath);
    return xmlPath;
  } catch (error) {
    if (stageDir) {
      try {
        cleanupWindowsSchedulerStage(stageDir, xmlPath ?? join(stageDir, "task.xml"), removeStageDir);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Task Scheduler staging failed and its private temporary directory could not be removed.",
        );
      }
    }
    throw error;
  }
}

export function removeWindowsSchedulerRegistrationStage(xmlPath: string): void {
  if (!ownedWindowsSchedulerStages.has(xmlPath)) {
    throw new Error("Refusing to remove an unrecognized Task Scheduler staging path.");
  }
  const stageDir = dirname(xmlPath);
  cleanupWindowsSchedulerStage(
    stageDir,
    xmlPath,
    path => { rmdirSync(path); },
  );
  if (existsSync(stageDir)) {
    throw new Error("The private Task Scheduler staging directory still exists after cleanup.");
  }
  ownedWindowsSchedulerStages.delete(xmlPath);
}

export interface FreshWindowsSchedulerRegistrationDeps {
  create?: (args: string[]) => void;
  elevate?: (
    taskName: string,
    xml: string,
    replace: boolean,
    expectedExistingXml?: string,
  ) => Promise<void>;
  probe?: () => WindowsSchedulerTaskProbe;
  queryXml?: () => string;
  readExistingXml?: () => string;
  rollback?: () => Promise<string | null>;
}

export async function registerFreshWindowsSchedulerTask(
  xmlPath: string,
  attemptNonce: string,
  deps: FreshWindowsSchedulerRegistrationDeps = {},
  expectedExistingXml?: string,
): Promise<void> {
  const replace = expectedExistingXml !== undefined;
  const readExistingXml = deps.readExistingXml ?? statusWindowsXml;
  const assertReplacementPrecondition = (): void => {
    if (!replace) return;
    if (!expectedExistingXml?.trim()) {
      throw new Error("Task Scheduler replacement requires a non-empty captured registration.");
    }
    let currentXml = "";
    try {
      currentXml = readExistingXml();
    } catch {
      throw new Error("Task Scheduler replacement was refused because the current registration could not be read.");
    }
    if (!windowsSchedulerRegistrationMatchesSnapshot(currentXml, expectedExistingXml)) {
      throw new Error("Task Scheduler replacement was refused because the current registration changed.");
    }
  };
  assertReplacementPrecondition();
  const args = buildWindowsSchtasksCreateArgsForXml(xmlPath, replace);
  // Capture and validate the exact definition before an access-denied attempt can
  // cross the UAC boundary. The elevated fallback receives these immutable bytes,
  // never the caller-writable staging pathname.
  const expectedXml = decodeSchtasksOutput(readFileSync(xmlPath));
  if (
    !windowsTaskRegistrationHealthy(expectedXml)
    || !windowsTaskRegistrationOwnedByAttempt(expectedXml, attemptNonce)
  ) {
    throw new Error("The staged Task Scheduler registration failed OpenCodex ownership or shape validation.");
  }
  try {
    (deps.create ?? schtasks)(args);
  } catch (error) {
    if (
      !(error instanceof WindowsSchtasksError)
      || error.operation !== "create"
      || error.reason !== "access-denied"
    ) {
      throw error;
    }
    // Register from the captured XML string inside the elevated process. Another
    // same-user process can mutate its own temp files, but cannot change this command.
    // UAC can remain open for an arbitrary amount of time. Recheck the captured predecessor
    // before launch; the elevated helper repeats the same check after consent and before Force.
    assertReplacementPrecondition();
    const elevate = deps.elevate ?? (async (
      taskName: string,
      xml: string,
      replaceCurrent: boolean,
      previousXml?: string,
    ) => {
      const exitCode = await runWindowsElevatedScheduledTaskRegistration(
        taskName,
        xml,
        replaceCurrent,
        previousXml,
      );
      if (exitCode !== 0) throw new Error(`Background service install failed with exit code ${exitCode}.`);
    });
    await elevate(TASK, expectedXml, replace, expectedExistingXml);
  }

  const rollbackTask = deps.rollback ?? (() => rollbackWindowsSchedulerTaskOwnedByAttempt(attemptNonce, TASK));
  const probe = (deps.probe ?? (() => probeWindowsSchedulerTask(TASK)))();
  if (probe.status === "absent") {
    throw new Error("Task Scheduler reported success, but the new registration is absent; no service cleanup was started.");
  }
  if (probe.status === "unknown") {
    const rollback = await rollbackTask();
    throw new Error(
      `Task Scheduler registration was not verifiably present after create (${probe.detail}).`
      + (rollback ? ` Cleanup also failed: ${rollback}` : " The unverified registration was rolled back."),
    );
  }

  let registeredXml = "";
  let queryDetail: string | null = null;
  try {
    registeredXml = (deps.queryXml ?? (() => querySchtasks(["/query", "/tn", TASK, "/xml"])))();
  } catch (error) {
    queryDetail = error instanceof Error ? error.message : String(error);
  }
  if (!registeredXml.trim()) {
    const rollback = await rollbackTask();
    throw new Error(
      "Task Scheduler registration was created, but its live XML could not be verified."
      + (queryDetail ? ` Query failed: ${queryDetail}` : " The query returned an empty document.")
      + (rollback ? ` Cleanup also failed: ${rollback}` : " The unverified registration was rolled back."),
    );
  }
  if (
    !windowsTaskRegistrationHealthy(registeredXml)
    || !windowsTaskRegistrationOwnedByAttempt(registeredXml, attemptNonce)
  ) {
    const rollback = await rollbackTask();
    throw new Error(
      "Task Scheduler registration was created but failed the OpenCodex action/trigger or attempt-ownership verification."
      + (rollback ? ` Cleanup also failed: ${rollback}` : " The invalid registration was rolled back."),
    );
  }
}

export function recordWindowsSchedulerOwnership(): boolean {
  // Ownership claiming is deliberately conservative: a legacy non-empty config root
  // without metadata stays unclaimed, but that must not turn a service reinstall into
  // an outage after prepareServiceInstall has stopped the previous manager.
  return recordOwnedConfigPath(getConfigDir(), serviceStatePath());
}

export interface RemoveNativeWindowsServiceDeps {
  status?: () => WinswStatus;
  uninstall?: () => void;
  sleep?: (ms: number) => void;
  settleChecks?: number;
}

export function removeNativeWindowsServiceForScheduler(
  deps: RemoveNativeWindowsServiceDeps = {},
): void {
  const uninstall = deps.uninstall ?? uninstallWinswService;
  // The test home cannot contain SCM. A partially mocked scheduler install must inject
  // the native-service mutation too; otherwise it can stop/delete the user's live WinSW
  // registration even though every filesystem path points at the isolated test home.
  if (isTestHomeGuardArmed() && uninstall === uninstallWinswService) {
    throw new Error(
      "refusing to mutate the machine-global Windows native service from an armed test process; "
      + "inject the native-service removal instead of calling the live manager.",
    );
  }
  const status = deps.status ?? statusWinswRaw;
  const sleep = deps.sleep ?? Bun.sleepSync;
  const settleChecks = Math.max(1, deps.settleChecks ?? 20);
  // Transactional backend switch: installing the scheduler backend removes a native
  // service first — two live managers would both respawn the proxy (conflict).
  if (status() !== "nonexistent") {
    console.log("🔁 Removing the native (WinSW) service before installing the Task Scheduler backend...");
    try {
      uninstall();
    } catch (err) {
      throw new Error(`Cannot remove the native service before switching to Task Scheduler: ${err instanceof Error ? err.message : String(err)}. Remove it manually with 'sc delete ${WINSW_SERVICE_ID}' or retry.`);
    }
    for (let check = 0; check < settleChecks; check++) {
      if (status() === "nonexistent") return;
      if (check + 1 < settleChecks) sleep(250);
    }
    throw new Error(`Native service registration could not be re-verified after the removal attempt — aborting switch. Check 'sc.exe query ${WINSW_SERVICE_ID}' and remove it manually if present.`);
  }
}

export function installWindows(): void {
  recordWindowsSchedulerOwnership();
  removeNativeWindowsServiceForScheduler();
  // End a running task BEFORE rewriting the assets it is executing — cmd.exe reading the
  // script mid-rewrite runs a torn batch file, and its open handle can fail the write.
  try { stopWindows(); } catch { /* not running */ }
  writeWindowsSchedulerAssets();
  schtasks(buildWindowsSchtasksCreateArgs(windowsServiceScriptPath()));
  schtasks(["/run", "/tn", TASK]);
  writeServiceInstallState("scheduler");
}

/**
 * Re-register an already-installed scheduler task from a freshly staged definition.
 *
 * Reuses the fresh-install staging and registration path, so the same ownership and shape
 * validation applies and an access-denied `schtasks /create` still escalates through the
 * existing elevated fallback. The staged XML is removed on every exit.
 */
export async function reregisterWindowsSchedulerTask(
  attemptNonce: string,
  expectedExistingXml: string,
): Promise<void> {
  const stagedXml = stageWindowsSchedulerRegistrationXml(attemptNonce);
  try {
    await registerFreshWindowsSchedulerTask(stagedXml, attemptNonce, {}, expectedExistingXml);
  } finally {
    removeWindowsSchedulerRegistrationStage(stagedXml);
  }
}

function stageWindowsSchedulerRestoreXml(registeredXml: string): string {
  if (!registeredXml.trim()) {
    throw new Error("Cannot restore an empty Task Scheduler registration.");
  }
  const stageDir = mkdtempSync(join(tmpdir(), WINDOWS_SCHEDULER_STAGE_PREFIX));
  const xmlPath = join(stageDir, "task.xml");
  try {
    try { chmodSync(stageDir, 0o700); } catch { /* required Windows ACL is authoritative */ }
    hardenSecretDir(stageDir, { required: true });
    writeFileSync(
      xmlPath,
      `\uFEFF${registeredXml.replace(/^\uFEFF/, "")}`,
      { encoding: "utf16le", flag: "wx", mode: 0o600 },
    );
    hardenSecretPath(xmlPath, { required: true });
    ownedWindowsSchedulerStages.add(xmlPath);
    return xmlPath;
  } catch (error) {
    try {
      cleanupWindowsSchedulerStage(stageDir, xmlPath, path => { rmdirSync(path); });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Task Scheduler rollback staging failed and could not be cleaned up.",
      );
    }
    throw error;
  }
}

/** Compare two live scheduler snapshots conservatively without treating formatting as mutation. */
export function windowsSchedulerRegistrationMatchesSnapshot(currentXml: string, previousXml: string): boolean {
  const normalize = (xml: string) => xml
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  const current = normalize(currentXml);
  const previous = normalize(previousXml);
  return current.length > 0 && previous.length > 0 && current === previous;
}

/**
 * Restore the captured registration only while the fixed task name is still absent.
 *
 * Both publication paths deliberately omit force: another writer appearing after the
 * absence probe must make this operation fail instead of being overwritten. Exact live
 * XML readback is required before the caller may restart the recovered task.
 */
export async function restoreWindowsSchedulerTaskIfAbsent(registeredXml: string): Promise<void> {
  const before = probeWindowsSchedulerTask(TASK);
  if (before.status !== "absent") {
    throw new Error(before.status === "present"
      ? "A Task Scheduler registration appeared before recovery and was preserved."
      : `Task Scheduler absence could not be re-verified before recovery (${before.detail}).`);
  }
  const stagedXml = stageWindowsSchedulerRestoreXml(registeredXml);
  try {
    const args = buildWindowsSchtasksCreateArgsForXml(stagedXml, false);
    try {
      schtasks(args);
    } catch (error) {
      if (
        !(error instanceof WindowsSchtasksError)
        || error.operation !== "create"
        || error.reason !== "access-denied"
      ) {
        throw error;
      }
      const exitCode = await runWindowsElevatedScheduledTaskRegistration(TASK, registeredXml, false);
      if (exitCode !== 0) {
        throw new Error(`Task Scheduler rollback failed with exit code ${exitCode}.`);
      }
    }
    const recoveredXml = statusWindowsXml();
    if (!windowsSchedulerRegistrationMatchesSnapshot(recoveredXml, registeredXml)) {
      throw new Error("The recovered Task Scheduler registration did not match the captured definition.");
    }
  } finally {
    removeWindowsSchedulerRegistrationStage(stagedXml);
  }
}

/**
 * Opt-in native backend (`ocx service install --native`). Transactional: removes the
 * scheduler backend first; on failure the machine is left with NO service (explicitly
 * reported) — never a silent fallback to the scheduler.
 */
/** Refuse WinSW when the interactive user is a Microsoft account (SCM cannot authenticate it). */
export function assertWindowsNativeServiceAccountSupported(): void {
  if (process.platform !== "win32") return;
  const source = readWindowsPrincipalSource();
  if (source?.toLowerCase() === "microsoftaccount") {
    throw new Error(
      "The native (WinSW) service backend cannot run under a Microsoft-account Windows login. "
        + "Keep the Task Scheduler backend (`ocx service install`) or sign in with a local/domain account before `ocx service install --native`.",
    );
  }
}

function readWindowsPrincipalSource(): string | null {
  if (process.platform !== "win32") return null;
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(ps)) return null;
  try {
    const out = execFileSync(ps, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-LocalUser -Name $env:USERNAME -ErrorAction SilentlyContinue).PrincipalSource",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export async function installWindowsNative(): Promise<void> {
  assertWindowsNativeServiceAccountSupported();
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  let hadScheduler = false;
  try {
    hadScheduler = schtasks(["/query", "/tn", TASK]).includes(TASK);
  } catch { /* task absent */ }
  if (hadScheduler) {
    console.log("🔁 Removing the Task Scheduler backend before installing the native (WinSW) service...");
    try { stopWindows(); } catch { /* not running */ }
    try {
      uninstallWindows();
    } catch (err) {
      throw new Error(`Cannot remove the Task Scheduler backend before switching to native: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Verify removal — schtasks /delete can silently fail if UAC or policy blocks it.
    try {
      if (schtasks(["/query", "/tn", TASK]).includes(TASK)) {
        throw new Error("Task Scheduler backend still present after removal — aborting switch.");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("still present")) throw e;
      /* query failure = task absent, which is what we want */
    }
  }
  try {
    await installWinswService(defaultWinswEntry(serviceSourceDir));
  } catch (err) {
    if (hadScheduler) console.error("⚠️  Native install failed AFTER removing the Task Scheduler backend — no service is installed now. Run `ocx service install` to restore the scheduler backend, or retry `--native`.");
    throw err;
  }
  writeServiceInstallState("native");
}

export function startWindows(): void { schtasks(["/run", "/tn", TASK]); }

export function isWindowsSchedulerEndBenign(error: unknown): boolean {
  const detail = schtasksErrorDetail(error).toLowerCase();
  return detail.includes("no running instance")
    || detail.includes("not currently running")
    || detail.includes("0x41330");
}

/**
 * End the scheduler task. "Already stopped" is success; other `/end` failures are
 * swallowed so callers can still run tracked-proxy + live-proxy cleanup.
 *
 * Do not key a restart-window wait on `/end` failure: the #764 case is an `/end`
 * that *succeeds* while the wrapper survives and respawns. That verification lives
 * on the stop-verification path (poll across the restart window), not here.
 */
export function stopWindows(): void {
  try {
    schtasks(["/end", "/tn", TASK]);
  } catch (error) {
    if (isWindowsSchedulerEndBenign(error)) return;
  }
}

/**
 * `stopWindows` for callers that need to know whether it worked.
 *
 * The void form swallows a non-benign `/end` failure, which is right for best-effort
 * teardown and wrong for deciding whether an update may replace files: a scheduler that
 * refused to stop can respawn the proxy on top of a half-written install (#3008).
 */
export function stopWindowsChecked(): boolean {
  try {
    schtasks(["/end", "/tn", TASK]);
    return true;
  } catch (error) {
    return isWindowsSchedulerEndBenign(error);
  }
}

export function statusWindows(): string { try { return schtasks(["/query", "/tn", TASK]); } catch { return ""; } }

export function statusWindowsXml(): string { try { return schtasks(["/query", "/tn", TASK, "/xml"]); } catch { return ""; } }

/**
 * Best-effort termination of surviving Windows scheduler launcher/wrapper processes.
 * `schtasks /end` ends the task instance but often leaves wscript/cmd running the
 * `:loop` batch, which brings the proxy back during a stop or restart.
 *
 * The matching rule — canonical paths of THIS installation, as complete
 * command-line tokens — lives in lib/windows-service-wrappers so the update job
 * cannot drift away from it again.
 */
export function killWindowsServiceWrapperProcesses(): void {
  killWindowsSchedulerWrappers({
    scriptPath: windowsServiceScriptPath(),
    launcherPath: windowsLauncherVbsPath(),
  });
}

export function uninstallWindows(): void {
  const probe = probeWindowsSchedulerTask(TASK);
  if (probe.status === "present") {
    try {
      schtasks(["/delete", "/tn", TASK, "/f"]);
    } catch (error) {
      throw new Error(`Failed to delete Task Scheduler task ${TASK}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const afterDelete = probeWindowsSchedulerTask(TASK);
    if (afterDelete.status === "present") {
      throw new Error(`Task Scheduler task ${TASK} is still present after delete — refusing to remove service assets. Retry from an elevated shell.`);
    }
    if (afterDelete.status === "unknown") {
      throw new Error(`Task Scheduler task ${TASK} presence could not be verified after delete — refusing to remove service assets.`);
    }
  } else if (probe.status === "unknown") {
    throw new Error(`Task Scheduler task ${TASK} presence could not be verified — refusing to remove service assets.`);
  }
  if (existsSync(windowsServiceScriptPath())) unlinkSync(windowsServiceScriptPath());
  if (existsSync(windowsLauncherVbsPath())) unlinkSync(windowsLauncherVbsPath());
  if (existsSync(windowsTaskXmlPath())) unlinkSync(windowsTaskXmlPath());
}

/**
 * Collapse the Windows backend observations into one outcome.
 *
 * Extracted so the precedence is testable by calling it. The rule that matters: a readable
 * failure outranks an unreadable state, and an unreadable state outranks success — a
 * scheduler we cannot see may still respawn the proxy.
 */
export function classifyWindowsServiceStop(o: {
  stopped: boolean;
  failed: boolean;
  schedulerStopped: boolean;
  stateUnknown: boolean;
}): ServiceStopOutcome {
  if (o.failed) return "failed";
  if (o.stateUnknown) return "state-unknown";
  if (o.stopped) return o.schedulerStopped ? "stopped-respawnable" : "stopped";
  return "absent";
}
