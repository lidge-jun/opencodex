import { execFileSync } from "node:child_process";
import { findLiveProxy } from "../server/proxy-liveness";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ELEVATION_REQUEST_TIMEOUT_MS, OCX_ELEVATED_PROTOCOL_FAILED, raceWithTimeout, resolveTrustedWindowsSchtasksExe, startElevatedSchtasksCreateAndRun, runWindowsElevated, toWindowsSchtasksError, WindowsElevationError, type ElevatedSchedulerOutcome, type ElevatedSchtasksCreateAndRunExecution, type ElevatedSchtasksCreateAndRunResult } from "../lib/windows-elevation";
import { statusWinswRaw } from "../lib/winsw";
import { isTestHomeGuardArmed } from "../lib/test-home-guard";
import { TASK, windowsServiceScriptPath, windowsLauncherVbsPath, windowsTaskXmlPath, writeServiceInstallState } from "./state";
import { buildWindowsSchtasksCreateArgs, windowsTaskRegistrationOwnedByAttempt, windowsTaskRegistrationHealthy } from "./windows-taskxml";
import type { ExpectedWindowsTaskUserId } from "./windows-taskxml";
import { win32 } from "node:path";
import { WINSW_SERVICE_ID } from "../lib/winsw";

/**
 * Decode schtasks stdout. `/query /xml` emits UTF-16LE (often with BOM) because the
 * registered task document is UTF-16; reading that as UTF-8 makes every health check
 * fail ("registration present but unhealthy") and rolls back a successful elevated create.
 */
export function decodeSchtasksOutput(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  const bomUtf16Le = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const bomUtf16Be = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;
  const looksUtf16Le = buffer.length >= 4
    && buffer[1] === 0x00
    && buffer[3] === 0x00
    && buffer[0] !== 0x00;
  if (bomUtf16Le || looksUtf16Le) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "").trim();
  }
  if (bomUtf16Be) {
    // Swap pairs then decode as utf16le.
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1]!;
      swapped[i - 1] = buffer[i]!;
    }
    return swapped.toString("utf16le").trim();
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
}

function runFile(file: string, args: string[]): string {
  const buffer = execFileSync(file, args, {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as Buffer;
  return decodeSchtasksOutput(buffer);
}

function windowsSchtasks(): string {
  return resolveTrustedWindowsSchtasksExe();
}

export function windowsWscript(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return existsSync(candidate) ? candidate : "wscript.exe";
}

let querySchtasksForTests: ((args: string[]) => string) | null = null;

export function querySchtasks(args: string[]): string {
  // The repository preload isolates HOME and OPENCODEX_HOME, but Task Scheduler is
  // machine-global. A partially-faked service test once fell through here and replaced the
  // user's real `opencodex-proxy` task with a launcher inside its temporary test home; the
  // test passed and cleanup deleted that launcher. Queries are observation-only, but every
  // other operation must be injected while the explicit test-home guard is armed.
  if (
    isTestHomeGuardArmed()
    && args[0]?.trim().toLowerCase() !== "/query"
  ) {
    throw new Error(
      "refusing to mutate the machine-global Windows Task Scheduler from an armed test process; "
      + "inject the scheduler operation instead of calling the live manager.",
    );
  }
  if (querySchtasksForTests) return querySchtasksForTests(args);
  return runFile(windowsSchtasks(), args);
}

/** Test-only seam for Task Scheduler query used by presence probes. */
export function setQuerySchtasksForTests(next: ((args: string[]) => string) | null): void {
  querySchtasksForTests = next;
}

export function schtasks(args: string[]): string {
  try {
    return querySchtasks(args);
  } catch (error) {
    throw toWindowsSchtasksError(error, args);
  }
}

/** Tri-state Task Scheduler presence: never treat a failed query as proven absence. */
export type WindowsSchedulerTaskProbe =
  | { status: "present" }
  | { status: "absent" }
  | { status: "unknown"; detail: string };

export type WindowsSchedulerProxyProbe =
  | { status: "running"; port: number }
  | { status: "not-running" }
  | { status: "unknown" };

/**
 * Render Task Scheduler status without exposing localized `schtasks` table output.
 * The task probe answers installation state; the identity-checked health probe answers
 * runtime state. Keep probe details out of this user-facing line because they can contain
 * incorrectly decoded, locale-specific command output.
 */
export function formatWindowsSchedulerServiceStatus(
  task: WindowsSchedulerTaskProbe,
  proxy: WindowsSchedulerProxyProbe,
): string {
  if (task.status === "present") {
    if (proxy.status === "running") {
      return `✅ service installed (Task Scheduler); OpenCodex proxy running on port ${proxy.port}.`;
    }
    if (proxy.status === "not-running") {
      return "⚠️  service installed (Task Scheduler); OpenCodex proxy not running.";
    }
    return "⚠️  service installed (Task Scheduler); OpenCodex proxy status unknown.";
  }
  if (task.status === "absent") {
    if (proxy.status === "running") {
      return `❌ service not installed (Task Scheduler); OpenCodex proxy is running independently on port ${proxy.port}.`;
    }
    if (proxy.status === "unknown") {
      return "❌ service not installed (Task Scheduler); OpenCodex proxy status unknown.";
    }
    return "❌ service not installed (Task Scheduler).";
  }
  if (proxy.status === "running") {
    return `⚠️  Task Scheduler registration unknown; OpenCodex proxy running on port ${proxy.port}.`;
  }
  if (proxy.status === "not-running") {
    return "⚠️  service status unknown (Task Scheduler query failed); OpenCodex proxy not running.";
  }
  return "⚠️  service status unknown (Task Scheduler and proxy checks failed).";
}

export async function inspectWindowsSchedulerServiceStatus(io: {
  probeTask?: () => WindowsSchedulerTaskProbe;
  findProxy?: () => Promise<{ port: number } | null>;
} = {}): Promise<string> {
  let task: WindowsSchedulerTaskProbe;
  try {
    task = (io.probeTask ?? probeWindowsSchedulerTask)();
  } catch (error) {
    task = { status: "unknown", detail: schtasksErrorDetail(error) };
  }

  let proxy: WindowsSchedulerProxyProbe;
  try {
    const live = await (io.findProxy ?? findLiveProxy)();
    proxy = live ? { status: "running", port: live.port } : { status: "not-running" };
  } catch {
    proxy = { status: "unknown" };
  }

  return formatWindowsSchedulerServiceStatus(task, proxy);
}

export function schtasksErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a schtasks CSV listing line refers to the given task name. */
export function windowsSchedulerCsvIncludesTask(csv: string, taskName: string): boolean {
  const needle = taskName.toLowerCase();
  for (const line of csv.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (!lower.includes(needle)) continue;
    // Prefer exact CSV field matches ("\TaskName" / "TaskName") before a substring hit.
    if (
      lower.includes(`"\\${needle}"`)
      || lower.includes(`"${needle}"`)
      || new RegExp(`(^|[,\\\\])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([,"]|$)`).test(lower)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Probe whether the OpenCodex Task Scheduler task exists.
 * Query failures fall back to a CSV listing before concluding absence; if both
 * fail, returns `unknown` so callers can fail closed instead of releasing locks.
 */
export function probeWindowsSchedulerTask(taskName = TASK): WindowsSchedulerTaskProbe {
  if (process.platform !== "win32") return { status: "absent" };

  let queryFailure: string | null = null;
  try {
    const out = querySchtasks(["/query", "/tn", taskName]);
    if (out.includes(taskName)) return { status: "present" };
  } catch (error) {
    queryFailure = schtasksErrorDetail(error);
  }

  try {
    const csv = querySchtasks(["/query", "/fo", "CSV"]);
    if (windowsSchedulerCsvIncludesTask(csv, taskName)) return { status: "present" };
    return { status: "absent" };
  } catch (error) {
    const listDetail = schtasksErrorDetail(error);
    const detail = queryFailure
      ? `Specific query failed (${queryFailure}); CSV listing also failed (${listDetail}).`
      : `Task query did not confirm presence and CSV listing failed (${listDetail}).`;
    return { status: "unknown", detail };
  }
}

/** True when the Task Scheduler registration for the default proxy task is proven present. */
export function windowsSchedulerTaskInstalled(taskName = TASK): boolean {
  return probeWindowsSchedulerTask(taskName).status === "present";
}

export interface WindowsSchedulerInstallVerification {
  taskInstalled: boolean;
  registrationHealthy: boolean;
  /** Well-formed XML that is PUBLISHED but policy-violating — permanent, never
   * worth a settle retry (vs an empty/unreadable view, which is publication
   * lag and transient). */
  registrationInvalid: boolean;
  assetsHealthy: boolean;
  nativeServiceAbsent: boolean;
  /** True when SCM probe failed; not a proven WinSW presence. */
  nativeStatusUnknown: boolean;
  conflict: boolean;
  ok: boolean;
  detail: string;
}

/** Pure postcondition evaluation for an elevated scheduler install. */
export function evaluateWindowsSchedulerInstallVerification(inputs: {
  taskInstalled: boolean;
  xml: string;
  assetsExist: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  wscript?: string;
  launcher?: string;
  expectedUserId?: ExpectedWindowsTaskUserId | null;
}): WindowsSchedulerInstallVerification {
  const registrationHealthy = inputs.xml.length > 0
    && windowsTaskRegistrationHealthy(inputs.xml, inputs.wscript, inputs.launcher, inputs.expectedUserId);
  // Permanent invalidity: the XML IS published but violates the registration
  // contract — no amount of settling changes it. Empty/unreadable XML stays
  // transient (publication lag).
  const registrationInvalid = inputs.taskInstalled && inputs.xml.length > 0 && !registrationHealthy;
  const assetsHealthy = inputs.assetsExist;
  const nativeServiceAbsent = inputs.nativeStatus === "nonexistent";
  const nativeStatusUnknown = inputs.nativeStatus === "unknown";
  // Only treat proven WinSW presence as a backend conflict — never "unknown".
  const conflict = inputs.taskInstalled
    && (inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  const ok = inputs.taskInstalled && registrationHealthy && assetsHealthy && nativeServiceAbsent && !conflict;
  const detail = !inputs.taskInstalled
    ? "Task Scheduler task is not installed."
    : conflict
      ? `CONFLICT: Task Scheduler and native WinSW (${WINSW_SERVICE_ID}) are both present.`
      : !assetsHealthy
        ? "Required scheduler service assets are missing."
        : !registrationHealthy
          ? (inputs.xml.trim()
            ? "Task Scheduler registration is present but unhealthy."
            : "Task Scheduler task is present but its XML could not be read.")
          : nativeStatusUnknown
            ? "The Task Scheduler task was created, but OpenCodex could not verify that the native WinSW service is absent."
            : "ok";
  return {
    taskInstalled: inputs.taskInstalled,
    registrationHealthy,
    registrationInvalid,
    assetsHealthy,
    nativeServiceAbsent,
    nativeStatusUnknown,
    conflict,
    ok,
    detail,
  };
}

/** Conflict-free postcondition check for an elevated scheduler install. */
export function verifyWindowsSchedulerInstall(taskName = TASK): WindowsSchedulerInstallVerification {
  const taskInstalled = windowsSchedulerTaskInstalled(taskName);
  let xml = "";
  if (taskInstalled) {
    try { xml = querySchtasks(["/query", "/tn", taskName, "/xml"]); } catch { xml = ""; }
  }
  // After elevated create, non-elevated `/query /xml` can fail or return empty while the
  // task is still listed. Fall back to the on-disk document we registered.
  if (taskInstalled && !xml.trim()) {
    const diskPath = windowsTaskXmlPath();
    if (existsSync(diskPath)) {
      try { xml = decodeSchtasksOutput(readFileSync(diskPath)); } catch { /* keep empty */ }
    }
  }
  return evaluateWindowsSchedulerInstallVerification({
    taskInstalled,
    xml,
    assetsExist: [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()].every(existsSync),
    nativeStatus: statusWinswRaw(),
  });
}

async function elevateSchtasks(args: string[]): Promise<void> {
  const exitCode = await runWindowsElevated(windowsSchtasks(), args);
  if (exitCode !== 0) {
    throw new Error(`Background service install failed with exit code ${exitCode}.`);
  }
}

export interface WindowsSchedulerRollbackDeps {
  queryXml?: () => string;
  deleteTask?: () => Promise<void>;
  probe?: () => WindowsSchedulerTaskProbe;
}

export async function rollbackWindowsSchedulerTaskOwnedByAttempt(
  attemptNonce: string,
  taskName = TASK,
  deps: WindowsSchedulerRollbackDeps = {},
): Promise<string | null> {
  let registeredXml = "";
  try {
    registeredXml = (deps.queryXml ?? (() => querySchtasks(["/query", "/tn", taskName, "/xml"])))();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Task Scheduler task ${taskName} ownership could not be proven: ${detail}. Residual scheduler state: task ${taskName} presence is unknown; no rollback deletion was attempted.`;
  }
  if (!registeredXml.trim()) {
    return `Task Scheduler task ${taskName} ownership could not be proven because its live XML was empty. Residual scheduler state: task ${taskName} presence is unknown; no rollback deletion was attempted.`;
  }
  if (!windowsTaskRegistrationOwnedByAttempt(registeredXml, attemptNonce)) {
    return `Task Scheduler task ${taskName} ownership could not be proven because its attempt nonce does not match. Residual scheduler state: task ${taskName} remains registered; no rollback deletion was attempted.`;
  }

  try {
    await (deps.deleteTask ?? (() => elevateSchtasks(["/delete", "/tn", taskName, "/f"])))();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Rollback deletion failed: ${detail}. Residual scheduler state: task ${taskName} may remain registered.`;
  }
  const probe = (deps.probe ?? (() => resolveWindowsSchedulerTaskProbe(taskName)))();
  if (probe.status === "absent") return null;
  if (probe.status === "unknown") {
    return `Task Scheduler task ${taskName} presence could not be verified after rollback: ${probe.detail}. Residual scheduler state: task presence is unknown.`;
  }
  return `Residual scheduler state: task ${taskName} is still present after rollback.`;
}

// Legacy dashboard finalization creates and runs in one elevated child, whose protocol
// performs its own rollback before returning. This fallback remains for indeterminate
// protocol outcomes that predate the staged CLI transaction.
async function rollbackElevatedSchedulerTask(taskName = TASK): Promise<string | null> {
  try {
    await elevateSchtasks(["/delete", "/tn", taskName, "/f"]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const probe = resolveWindowsSchedulerTaskProbe(taskName);
  if (probe.status === "absent") return null;
  if (probe.status === "unknown") {
    return `Task Scheduler task ${taskName} presence could not be verified after rollback: ${probe.detail}`;
  }
  return `Task Scheduler task ${taskName} is still present after rollback.`;
}

type ElevateCreateAndRunStart = (
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
) => ElevatedSchtasksCreateAndRunExecution;

type FinalizeHooks = {
  startElevateCreateAndRun?: ElevateCreateAndRunStart;
  /** Legacy sync hook used by older tests — wraps a resolved result as an execution. */
  elevateCreateAndRun?: (
    schtasksPath: string,
    createArgs: string[],
    runArgs: string[],
    deleteArgs: string[],
  ) => Promise<ElevatedSchtasksCreateAndRunResult>;
  verify?: () => WindowsSchedulerInstallVerification;
  writeInstallState?: () => void;
  /** Preferred tri-state probe for security-sensitive reconciliation. */
  probeTask?: () => WindowsSchedulerTaskProbe;
  /** Legacy boolean hook; mapped to present/absent when probeTask is unset. */
  taskInstalled?: () => boolean;
  /** Defense-in-depth: late reconciliation must still own this attempt. */
  stillOwnsAttempt?: (attemptId: string) => boolean;
  requestTimeoutMs?: number;
  /** Test-only seam for the post-create settle backoff; real installs use a timer. */
  settleDelay?: (ms: number) => Promise<void>;
};

let finalizeHooks: FinalizeHooks | null = null;

function resolveWindowsSchedulerTaskProbe(taskName = TASK): WindowsSchedulerTaskProbe {
  if (finalizeHooks?.probeTask) return finalizeHooks.probeTask();
  if (finalizeHooks?.taskInstalled) {
    return finalizeHooks.taskInstalled() ? { status: "present" } : { status: "absent" };
  }
  return probeWindowsSchedulerTask(taskName);
}

/** Test-only hooks for elevated create+run finalization. */
export function setFinalizeWindowsSchedulerHooksForTests(hooks: FinalizeHooks | null): void {
  finalizeHooks = hooks;
}

function throwPartialInstall(parts: string[]): never {
  throw new Error(parts.filter(Boolean).join(" "));
}

/**
 * Reconcile an unrecognized elevated exit when we cannot trust the phase code.
 * Never invent a create-vs-run classification; inspect actual task state first.
 * An unverifiable probe must fail closed (partial / blocked), never release.
 */
async function reconcileUnknownElevatedOutcome(exitCode: number): Promise<void> {
  const probe = resolveWindowsSchedulerTaskProbe();
  const parts = [
    "The elevated Task Scheduler operation returned an unknown result.",
    `Exit code: ${exitCode}.`,
    "OpenCodex could not prove whether task creation completed, so installation state was not written.",
  ];
  if (probe.status === "unknown") {
    parts.push(`Task Scheduler presence could not be verified: ${probe.detail}`);
    parts.push("A partial Task Scheduler backend may remain.");
    throwPartialInstall(parts);
  }
  if (probe.status === "absent") {
    parts.push("No OpenCodex Task Scheduler task was found after the elevated operation.");
    throwPartialInstall(parts);
  }
  parts.push("A Task Scheduler task is present; attempting cleanup.");
  const rollbackError = await rollbackElevatedSchedulerTask();
  if (rollbackError) {
    parts.push(`Cleanup also failed: ${rollbackError}`);
    parts.push(`Remove the task manually with 'schtasks /delete /tn ${TASK} /f' if it remains.`);
  } else {
    parts.push("The elevated Task Scheduler task was removed.");
  }
  throwPartialInstall(parts);
}

type ApplyElevatedOptions = {
  attemptId: string;
  writeOnSuccess: boolean;
  stillOwnsAttempt?: (attemptId: string) => boolean;
};

function attemptStillOwned(options: ApplyElevatedOptions): boolean {
  const check = options.stillOwnsAttempt ?? finalizeHooks?.stillOwnsAttempt;
  return !check || check(options.attemptId);
}

/**
 * Bounded post-create backoff, 1.1s total. Task Scheduler's non-elevated view can
 * lag an elevated `/create` by a few hundred milliseconds, so a single verification
 * would roll back a task that is merely not visible yet.
 */
export const SCHEDULER_SETTLE_DELAYS_MS = [50, 150, 300, 600] as const;

/**
 * Whether a failed verification is still worth re-checking after a short delay.
 *
 * Retrying is confined to states that a lagging scheduler view actually produces:
 * the task is not visible yet, or it is visible but its registration has not been
 * published in full. Everything else keeps its existing fail-closed meaning and is
 * rejected here so no delay can turn it into a pass:
 *
 * - a proven conflict (both backends present) is a real dual-backend install;
 * - missing assets are missing on disk, which no amount of waiting creates;
 * - a WinSW service that is proven present (`started`/`stopped`) is never absent
 *   later. This is checked independently of `conflict`, which only becomes true
 *   once the task itself is visible — while the task is still invisible the pair
 *   is `conflict: false` with `nativeServiceAbsent: false`, and that must not retry;
 * - unknown SCM status is unproven rather than transient, and has its own
 *   task-preserving branch below.
 */
/** Exported for tests: the transient-vs-permanent settle decision. */
export function schedulerVerificationMaySettle(v: WindowsSchedulerInstallVerification): boolean {
  if (v.ok) return false;
  if (v.conflict) return false;
  if (!v.assetsHealthy) return false;
  if (!v.nativeServiceAbsent) return false;
  // A published-but-invalid registration is permanent: no delay repairs it.
  if (v.registrationInvalid) return false;
  return !v.taskInstalled || !v.registrationHealthy;
}

export function settleDelay(ms: number): Promise<void> {
  const hook = finalizeHooks?.settleDelay;
  if (hook) return hook(ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Verify the elevated install, re-checking only while the failure looks like a
 * scheduler view that has not caught up yet. Returns `null` when this attempt lost
 * ownership mid-settle: a newer attempt owns the task, so this one must neither
 * write install state nor roll anything back.
 */
async function verifyWindowsSchedulerInstallAfterSettle(
  options: ApplyElevatedOptions,
): Promise<WindowsSchedulerInstallVerification | null> {
  const verify = finalizeHooks?.verify ?? verifyWindowsSchedulerInstall;
  let verification = verify();
  for (const delayMs of SCHEDULER_SETTLE_DELAYS_MS) {
    if (!schedulerVerificationMaySettle(verification)) break;
    if (!attemptStillOwned(options)) return null;
    await settleDelay(delayMs);
    if (!attemptStillOwned(options)) return null;
    verification = verify();
  }
  return verification;
}

async function applyElevatedSchedulerResult(
  result: ElevatedSchtasksCreateAndRunResult,
  options: ApplyElevatedOptions,
): Promise<void> {
  if (!attemptStillOwned(options)) {
    return;
  }
  const outcome: ElevatedSchedulerOutcome = result.outcome;

  if (outcome === "create-failed") {
    throw new Error("Elevated schtasks /create failed. The Task Scheduler task was not registered.");
  }
  if (outcome === "run-failed-rolled-back") {
    throw new Error(
      "Elevated schtasks /run failed after the task was registered. The elevated process rolled the task back. Installation state was not written.",
    );
  }
  if (outcome === "run-failed-rollback-failed") {
    throwPartialInstall([
      "Elevated schtasks /run failed after the task was registered, and elevated rollback also failed.",
      "A partial Task Scheduler backend may remain.",
      `Remove the task manually with 'schtasks /delete /tn ${TASK} /f' if present.`,
      "Installation state was not written.",
    ]);
  }
  if (outcome !== "success") {
    await reconcileUnknownElevatedOutcome(result.exitCode);
  }

  const verification = await verifyWindowsSchedulerInstallAfterSettle(options);
  // Ownership moved to a newer attempt while settling; that attempt owns the outcome.
  if (!verification) return;
  if (!verification.ok) {
    // Preserve a healthy elevated task when WinSW absence cannot be proven (unknown SCM status).
    // Unknown is not a confirmed dual-backend conflict; install state is still withheld.
    const preserveElevatedTask = verification.taskInstalled
      && verification.registrationHealthy
      && verification.assetsHealthy
      && !verification.conflict
      && verification.nativeStatusUnknown;
    if (preserveElevatedTask) {
      throwPartialInstall([
        "Elevated Task Scheduler registration did not produce a conflict-free install.",
        verification.detail,
        "The elevated Task Scheduler task was left in place because native WinSW status could not be verified.",
        "Installation state was not written.",
      ]);
    }
    // Rollback deletes a real task, so it needs the same ownership fence as the
    // state write below: a stale attempt must never delete a newer attempt's task.
    if (!attemptStillOwned(options)) return;
    const rollbackError = await rollbackElevatedSchedulerTask();
    const parts = [
      "Elevated Task Scheduler registration did not produce a conflict-free install.",
      verification.detail,
    ];
    if (rollbackError) {
      parts.push(`Rollback also failed: ${rollbackError}`);
      parts.push(`Remove the task manually with 'schtasks /delete /tn ${TASK} /f' and the native service with 'sc delete ${WINSW_SERVICE_ID}' if present.`);
    } else {
      parts.push("The elevated Task Scheduler task was rolled back.");
    }
    parts.push("Installation state was not written.");
    throwPartialInstall(parts);
  }
  if (options.writeOnSuccess) {
    if (!attemptStillOwned(options)) {
      return;
    }
    (finalizeHooks?.writeInstallState ?? (() => writeServiceInstallState("scheduler")))();
  }
}

/** Outcome of late reconciliation after a request-level elevation timeout. */
export type ElevatedReconciliationOutcome =
  | "released"
  | "blocked-partial";

export type FinalizeWindowsSchedulerResult =
  | { kind: "done" }
  | {
      kind: "indeterminate";
      attemptId: string;
      /** Settles after the elevated transaction finishes and late reconciliation runs. */
      reconciliation: Promise<ElevatedReconciliationOutcome>;
    };

export type FinalizeWindowsSchedulerOptions = {
  attemptId?: string;
  stillOwnsAttempt?: (attemptId: string) => boolean;
  requestTimeoutMs?: number;
};

function startElevateExecution(
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
): ElevatedSchtasksCreateAndRunExecution {
  if (finalizeHooks?.startElevateCreateAndRun) {
    return finalizeHooks.startElevateCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
  }
  if (finalizeHooks?.elevateCreateAndRun) {
    const completion = finalizeHooks.elevateCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
    return { completion, launcherPid: null };
  }
  return startElevatedSchtasksCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
}

function isPartialInstallError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /partial Task Scheduler/i.test(error.message)
    || /Cleanup also failed/i.test(error.message)
    || /left in place because native WinSW status could not be verified/i.test(error.message)
    || /Task Scheduler presence could not be verified/i.test(error.message);
}

/**
 * Re-register the scheduler task with elevation after a non-elevated install wrote assets.
 *
 * Request timeout does not kill the elevated launcher. On timeout this returns
 * `indeterminate` and keeps reconciling the eventual protocol result.
 */
export async function finalizeWindowsSchedulerServiceRegistration(
  script = windowsServiceScriptPath(),
  options?: FinalizeWindowsSchedulerOptions,
): Promise<FinalizeWindowsSchedulerResult> {
  if (process.platform !== "win32") {
    throw new Error("Windows scheduler registration is only supported on Windows.");
  }
  const attemptId = options?.attemptId ?? randomUUID();
  const stillOwnsAttempt = options?.stillOwnsAttempt ?? finalizeHooks?.stillOwnsAttempt;
  const createArgs = buildWindowsSchtasksCreateArgs(script);
  const runArgs = ["/run", "/tn", TASK];
  const deleteArgs = ["/delete", "/tn", TASK, "/f"];
  const started = startElevateExecution(windowsSchtasks(), createArgs, runArgs, deleteArgs);
  const timeoutMs = options?.requestTimeoutMs
    ?? finalizeHooks?.requestTimeoutMs
    ?? ELEVATION_REQUEST_TIMEOUT_MS;
  const applyOpts: ApplyElevatedOptions = { attemptId, writeOnSuccess: true, stillOwnsAttempt };

  let raced: { status: "completed"; value: ElevatedSchtasksCreateAndRunResult } | { status: "timed-out" };
  try {
    raced = await raceWithTimeout(started.completion, timeoutMs);
  } catch (error) {
    // Cancellation / launch failure / signal before or instead of a protocol result.
    // Signal after Start-Process may leave an elevated child; reconcile conservatively.
    if (error instanceof WindowsElevationError && error.reason === "terminated") {
      try {
        await reconcileUnknownElevatedOutcome(OCX_ELEVATED_PROTOCOL_FAILED);
      } catch (reconcileError) {
        // Prefer the reconciliation detail (partial install / cleanup guidance) over the
        // generic signal message so callers can block retries when a task remains.
        throw reconcileError;
      }
    }
    throw error;
  }

  if (raced.status === "completed") {
    await applyElevatedSchedulerResult(raced.value, applyOpts);
    return { kind: "done" };
  }

  const reconciliation = (async (): Promise<ElevatedReconciliationOutcome> => {
    try {
      const result = await started.completion;
      await applyElevatedSchedulerResult(result, applyOpts);
      return "released";
    } catch (error) {
      if (error instanceof WindowsElevationError && error.reason === "cancelled") {
        return "released";
      }
      if (error instanceof WindowsElevationError && error.reason === "launch-failed") {
        return "released";
      }
      if (error instanceof WindowsElevationError && error.reason === "terminated") {
        try {
          await reconcileUnknownElevatedOutcome(OCX_ELEVATED_PROTOCOL_FAILED);
          return "released";
        } catch (reconcileError) {
          return isPartialInstallError(reconcileError) ? "blocked-partial" : "released";
        }
      }
      // applyElevatedSchedulerResult failures are expected (create/run/conflict); swallow for background.
      if (isPartialInstallError(error)) {
        return "blocked-partial";
      }
      return "released";
    }
  })();

  return { kind: "indeterminate", attemptId, reconciliation };
}

/**
 * Pure post-restart / pre-install advisory check. Does not mutate state.
 * A process-local indeterminate lock cannot survive restart — callers must inspect reality.
 */
export function evaluateSchedulerInstallRestartReconciliation(inputs: {
  taskInstalled: boolean;
  registrationHealthy: boolean;
  assetsHealthy: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  installStateBackend: "scheduler" | "native" | null;
}): {
  status: "healthy" | "orphan-task" | "stale-install-state" | "conflict" | "unhealthy" | "unverified";
  detail: string;
} {
  const conflict = inputs.taskInstalled
    && (inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  if (conflict) {
    return {
      status: "conflict",
      detail: `CONFLICT: Task Scheduler and native WinSW (${WINSW_SERVICE_ID}) are both present.`,
    };
  }
  if (inputs.taskInstalled && inputs.nativeStatus === "unknown") {
    return {
      status: "unverified",
      detail: "The Task Scheduler task exists, but native WinSW status could not be verified.",
    };
  }
  if (inputs.taskInstalled && (!inputs.registrationHealthy || !inputs.assetsHealthy)) {
    return {
      status: "unhealthy",
      detail: !inputs.assetsHealthy
        ? "Required scheduler service assets are missing."
        : "Task Scheduler registration is present but unhealthy.",
    };
  }
  if (inputs.taskInstalled && inputs.installStateBackend !== "scheduler") {
    return {
      status: "orphan-task",
      detail: "A Task Scheduler task is present without matching scheduler install state.",
    };
  }
  if (!inputs.taskInstalled && inputs.installStateBackend === "scheduler") {
    return {
      status: "stale-install-state",
      detail: "Scheduler install state is present but the Task Scheduler task is absent.",
    };
  }
  return { status: "healthy", detail: "ok" };
}
