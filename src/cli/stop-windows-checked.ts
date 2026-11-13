/**
 * ocx stop's side of the checked Windows service stop (#7771, 030 "Two parts").
 *
 * handleStopUnlocked in src/cli/index.ts keeps its structure; the Windows-specific
 * decisions live here so that file does not grow:
 *
 * - snapshotless: Part A runs as the service stop, with admission against the stop
 *   deadline. A result other than stopped/absent holds the child stop (no POST), and a
 *   stopped result makes Part B replace the old respawn re-poll;
 * - guarded: the manager inspection reads the evidence snapshot (windowsProcessSnapshot,
 *   native creation times on x64) once per inspection, and Part A binds against the
 *   revalidation's snapshot; Part B runs after settle on the approved endpoint, and its
 *   final enumeration is the one the manager-state checks share;
 * - the teardown receipt carries the Part A record, so /api/stop skips a second Part A.
 *
 * Off Windows every function keeps today's behavior and timing.
 */
import { recordPendingTeardownPartA, type PendingTeardownPartA } from "../config/pending-teardown";
import { readPid } from "../config/process-state";
import { observeGuardedManagerStopped, inspectGuardedManagerTarget, type GuardedManagerTarget } from "../service/guarded-manager-target";
// Through the barrel, like every other stop-path call, so the parent-stop fixtures can see it.
import { proxyStillLiveAfterStop, stopServiceIfInstalledDetailed, stopServiceIfInstalledReport } from "../service";
import type { ServiceStopOutcome } from "../service/orchestration";
import type { WindowsCheckedStopResult } from "../service/windows-checked-stop";
import { readScheduleServicePid, windowsProcessSnapshot, type WindowsStopProcessEntry } from "../service/windows-process-evidence";
import {
  confirmWindowsServiceStop,
  describeWindowsPartA,
  describeWindowsPartB,
  windowsPartARecord,
  windowsServiceStopHooks,
  windowsServiceStopPort,
  windowsStopAdmission,
  windowsStopReason,
  windowsStopRemainingMs,
} from "../service/windows-service-stop";
import { WINDOWS_STOP_CAPS } from "../service/windows-stop-budget";
import type { StopRunRecord } from "./stop-report";

const EVIDENCE_SNAPSHOT_TIMEOUT_MS = 5_000;
const SCHEDULE_PID_TIMEOUT_MS = 2_000;
const ORPHAN_DISCOVERY_CAP_MS = WINDOWS_STOP_CAPS.orphanDiscovery;

interface WindowsStopState {
  platform: NodeJS.Platform;
  result: WindowsCheckedStopResult | null;
  snapshotless: boolean;
  port: number | null;
  /** The evidence the last guarded inspection read; the bind reuses it. */
  evidence: { snapshot: readonly WindowsStopProcessEntry[] | null; schedulePid: number | null } | null;
  /** Part B's final enumeration, which the guarded manager-state checks share. */
  partBSnapshot: readonly WindowsStopProcessEntry[] | null;
}

const state: WindowsStopState = {
  platform: process.platform, result: null, snapshotless: false, port: null, evidence: null, partBSnapshot: null,
};

/** Test-only: simulate the platform the stop wiring acts for, and start from a clean run. */
export function resetOcxWindowsStopForTests(platform: NodeJS.Platform | null = null): void {
  state.platform = platform ?? process.platform;
  state.result = null;
  state.snapshotless = false;
  state.port = null;
  state.evidence = null;
  state.partBSnapshot = null;
}

function windows(): boolean {
  return state.platform === "win32";
}

export function windowsStopRequiresReceipt(): boolean {
  return windows();
}

function begin(snapshotless: boolean): void {
  state.result = null;
  state.snapshotless = snapshotless;
  state.port = null;
  state.partBSnapshot = null;
}

function annotate(nonce: string | undefined): void {
  const record = state.result ? windowsPartARecord(state.result) : null;
  if (!nonce || !record) return;
  try {
    recordPendingTeardownPartA(nonce, record);
  } catch {
    // Without the record the route runs its own capped Part A, which is today's behavior.
  }
}

/** A stop that never reaches the service manager (a sibling, an already-stopped client). */
export function noServiceStop(): ServiceStopOutcome {
  begin(false);
  return "absent";
}

/** The snapshotless service stop: Part A on Windows, today's manager stop elsewhere. */
export async function stopServiceForOcxStop(io: {
  receiptNonce: () => string | undefined;
  inheritedReceipts: number;
}): Promise<ServiceStopOutcome> {
  begin(true);
  if (!windows()) return stopServiceIfInstalledDetailed();
  state.port = windowsServiceStopPort();
  const report = await stopServiceIfInstalledReport({
    admission: windowsStopAdmission({ orphanDiscovery: readPid() === null, inheritedReceipts: io.inheritedReceipts }),
  }, state.platform);
  state.result = report.windows;
  annotate(io.receiptNonce());
  return report.outcome;
}

/** The record a receipt claimed after Part A carries (null before Part A or off Windows). */
export function windowsPartAReceiptRecord(): PendingTeardownPartA | null {
  return state.result ? windowsPartARecord(state.result) : null;
}

/** Part A held the child stop; handleStopUnlocked skips the POST branch entirely. */
export function windowsChildStopHeld(): boolean {
  const outcome = state.result?.outcome;
  return windows() && state.snapshotless && outcome !== "stopped" && outcome !== "absent";
}

/** ocx uninstall's service stop: Part A on Windows (60 s deadline), today's stop elsewhere. */
export async function stopServiceForUninstall(): Promise<ServiceStopOutcome> {
  begin(true);
  if (!windows()) return stopServiceIfInstalledDetailed();
  state.port = windowsServiceStopPort();
  const report = await stopServiceIfInstalledReport({
    admission: windowsStopAdmission({ orphanDiscovery: readPid() === null }),
  }, state.platform);
  state.result = report.windows;
  return report.outcome;
}

/**
 * ocx uninstall's restart-window check after the service was removed: Part B on Windows
 * after a Part A stopped, the legacy re-poll otherwise. Throws when the window fails; a
 * port held by another program does not stop an uninstall.
 */
export async function verifyUninstallStopWindow(): Promise<void> {
  if (!windowsPartBDue()) {
    const survivor = await proxyStillLiveAfterStop({ canRespawn: true });
    if (survivor) throw new Error(`a proxy is still listening on port ${survivor.port} after the service was removed; it is being respawned`);
    return;
  }
  const result = await confirmWindowsServiceStop({ port: state.port ?? windowsServiceStopPort(), remainingMs: windowsStopRemainingMs() });
  if (result.outcome === "freed") return;
  if (result.outcome === "port-held-by-foreign") {
    console.warn("⚠️  " + describeWindowsPartB(result));
    return;
  }
  throw new Error(describeWindowsPartB(result));
}

/** Snapshotless Windows only: Part A stopped, so Part B confirms the port afterwards. */
export function windowsPartBDue(): boolean {
  return windows() && state.snapshotless && state.result?.outcome === "stopped";
}

/**
 * Part B owns the port wait after a stopped Part A on BOTH Windows paths (#7771).
 *
 * `windowsPartBDue` stays snapshotless-only because it also gates the legacy respawn
 * re-poll (`schedulerCanRespawn`). This predicate is only about the port wait: on the
 * guarded path Part B runs after `settle`, so `stopProxy`'s legacy 15 s
 * `waitForStoppedPort` must not run on top of it.
 */
export function windowsPartBOwnsPortWait(): boolean {
  return windows() && state.result?.outcome === "stopped";
}

/**
 * A Part A result other than stopped/absent holds the child stop (030 "Two parts"): no
 * POST, the shared teardown skipped, proxy unknown. Records the additive reason.
 */
export function windowsPartAHolds(record: StopRunRecord): boolean {
  const result = state.result;
  if (!windows() || !result || result.outcome === "stopped" || result.outcome === "absent") return false;
  const reason = windowsStopReason(result);
  if (reason) record.serviceStopReason = reason;
  console.error("   " + describeWindowsPartA(result));
  if (!state.snapshotless) return true;
  record.proxy = "unknown";
  console.error("   The proxy was left running and the shared teardown skipped: the service could relaunch it.");
  return true;
}

/** Orphan discovery after a checked Windows stop is capped at 3 s (030 "Time budget"). */
export function orphanDiscoveryCap(): { deadlineAt?: number } {
  return windowsPartBDue() ? { deadlineAt: Date.now() + ORPHAN_DISCOVERY_CAP_MS } : {};
}

/**
 * After the child stop: true when the stop has to fail and hold the shared teardown.
 * Windows runs Part B; a legacy respawnable stop keeps the old re-poll.
 */
export async function stopWindowFailed(record: StopRunRecord): Promise<boolean> {
  if (!windowsPartBDue()) {
    const survivor = await proxyStillLiveAfterStop({ canRespawn: true });
    if (!survivor) return false;
    record.proxy = "respawned";
    console.error("❌ A proxy is still listening on port " + survivor.port + " after the service stop; it is being respawned.");
    console.error("   Skipping shared teardown: restoring client config while the proxy runs leaves both pointing at each other.");
    return true;
  }
  const result = await confirmWindowsServiceStop({ port: state.port ?? windowsServiceStopPort(), remainingMs: windowsStopRemainingMs() });
  record.portHeldByForeign = result.portHeldByForeign;
  if (result.outcome === "freed") return false;
  if (result.outcome === "port-held-by-foreign") {
    console.warn("⚠️  " + describeWindowsPartB(result));
    return false;
  }
  if (result.outcome === "survived") record.proxy = "respawned";
  else {
    record.proxy = "unknown";
    record.serviceStopReason = "evidence-unreadable";
  }
  console.error("❌ " + describeWindowsPartB(result));
  console.error("   Skipping shared teardown: restoring client config while the proxy runs leaves both pointing at each other.");
  return true;
}

async function readEvidence(): Promise<NonNullable<WindowsStopState["evidence"]>> {
  const hooks = windowsServiceStopHooks();
  const [snapshot, schedulePid] = await Promise.all([
    hooks?.snapshot ? hooks.snapshot() : windowsProcessSnapshot({ timeoutMs: EVIDENCE_SNAPSHOT_TIMEOUT_MS }),
    hooks?.schedulePid ? hooks.schedulePid() : readScheduleServicePid({ timeoutMs: SCHEDULE_PID_TIMEOUT_MS }),
  ]);
  return { snapshot, schedulePid };
}

/**
 * The guarded manager inspection. On Windows the process table is the evidence snapshot
 * with creation times, read once here and kept: Part A binds against exactly this table.
 */
export async function inspectGuardedTarget(
  approvedPid: number,
  approvedPort: number,
  inspect: typeof inspectGuardedManagerTarget = inspectGuardedManagerTarget,
): Promise<GuardedManagerTarget> {
  if (!windows()) return inspect(approvedPid, approvedPort);
  const evidence = await readEvidence();
  state.evidence = evidence;
  return inspect(approvedPid, approvedPort, {
    win: {
      winProcs: () => (evidence.snapshot ? [...evidence.snapshot] : null),
      winSchedulePid: () => evidence.schedulePid,
    },
  });
}

/** The guarded stopManager: Part A on Windows, binding on the revalidation's snapshot. */
export async function stopGuardedManager(io: {
  approvedPort: number;
  receiptNonce: () => string | undefined;
  inheritedReceipts: number;
}): Promise<ServiceStopOutcome> {
  begin(false);
  if (!windows()) return stopServiceIfInstalledDetailed();
  state.port = io.approvedPort;
  const report = await stopServiceIfInstalledReport({
    admission: windowsStopAdmission({ orphanDiscovery: false, inheritedReceipts: io.inheritedReceipts }),
    ...(state.evidence?.snapshot ? { bindSnapshot: state.evidence.snapshot } : {}),
  }, state.platform);
  state.result = report.windows;
  annotate(io.receiptNonce());
  return report.outcome;
}

/** The guarded Part B, after settle, on the approved endpoint. Off Windows: nothing to do. */
export async function confirmGuardedFreed(record: StopRunRecord): Promise<boolean> {
  if (!windows() || state.snapshotless || state.result?.outcome !== "stopped" || state.port === null) return true;
  const result = await confirmWindowsServiceStop({
    port: state.port,
    remainingMs: windowsStopRemainingMs(),
    snapshot: async timeoutMs => {
      const snapshot = await windowsProcessSnapshot({ timeoutMs });
      state.partBSnapshot = snapshot;
      return snapshot;
    },
  });
  record.portHeldByForeign = result.portHeldByForeign;
  if (result.outcome === "freed") return true;
  if (result.outcome === "port-held-by-foreign") {
    console.warn("⚠️  " + describeWindowsPartB(result));
    return true;
  }
  if (result.outcome !== "survived") record.serviceStopReason = "evidence-unreadable";
  console.error("❌ " + describeWindowsPartB(result));
  return false;
}

/** The guarded manager-state checks; on Windows they share Part B's final enumeration. */
export function observeGuardedStopped(
  manager: Exclude<GuardedManagerTarget, { kind: "unknown" }>,
  observe: typeof observeGuardedManagerStopped = observeGuardedManagerStopped,
): ReturnType<typeof observeGuardedManagerStopped> {
  const snapshot = windows() ? state.partBSnapshot : null;
  return snapshot ? observe(manager, { win: { winProcs: () => [...snapshot] } }) : observe(manager);
}
