/**
 * Time budget of the checked Windows stop (#7771, 030 "Time budget").
 *
 * One deadline governs the whole stop. Admission runs after Part A's registration probe
 * and before anything changes: it adds up the worst case of every step still to come and
 * refuses (unverified-budget, nothing changed) when the time left cannot hold it. Every
 * step after admission that waits on the machine has a cap, and these constants are those
 * caps. Opening the bind-time watches and the caller's authorizer are not capped; the
 * authorizer runs inside the terminateAndWait window and is bounded by its caller.
 *
 * Pure arithmetic; the callers own the clock.
 */

/** Caps of the individual steps, in ms. Part A and Part B enforce exactly these. */
export const WINDOWS_STOP_CAPS = {
  registrationProbe: 2_000,
  enumeration: 5_000,
  scheduleServicePid: 2_000,
  taskEnd: 2_000,
  winswStopCommand: 2_000,
  winswPollMargin: 2_000,
  /** Terminate calls and the bind-time handle wait share this window. */
  terminateAndWait: 3_000,
  managerState: 1_000,
  orphanDiscovery: 3_000,
  postAnswer: 10_000,
  forcedKill: 5_000,
  forcedExitWait: 5_000,
  childExitMargin: 3_000,
  inheritedReceiptProbe: 3_000,
  partBHoldFloor: 6_000,
  partBWindowCeiling: 12_000,
  /**
   * A port sample may start at the very end of the window (the hold is measured between
   * sample starts), so the closing sample can run this long past it. 030 did not count it.
   */
  partBClosingSample: 500,
  partBFinalEnumeration: 5_000,
  reserve: 3_000,
} as const;

/** The <stoptimeout> of the generated WinSW definition. */
export const DEFAULT_WINSW_STOP_TIMEOUT_MS = 20_000;
/** shutdownTimeoutMs default the child exit row is computed from. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
/** Deadline of a caller that passes none (a terminal, a script, an older Desktop). */
export const DEFAULT_WINDOWS_STOP_DEADLINE_MS = 60_000;

export interface WindowsStopBudgetInput {
  /** What Part A's registration probe found. */
  managers: { scheduler: boolean; winsw: boolean; stray: boolean };
  /** The bind reuses an enumeration that already ran (guarded: revalidateManager's). */
  enumerationReused: boolean;
  /** Snapshotless stop without a PID file, or after WinSW stopped the proxy. */
  orphanDiscovery: boolean;
  shutdownTimeoutMs?: number;
  /** Abandoned teardown receipts whose endpoints are probed (two hosts each). */
  inheritedReceipts?: number;
  winswStopTimeoutMs?: number;
  /** Part B runs after Part A (false only where 030 skips it, such as the route). */
  partB?: boolean;
}

export interface WindowsStopBudgetRow {
  step: "part-a" | "orphan-discovery" | "post-answer" | "child-exit" | "inherited-receipts" | "part-b" | "reserve";
  ms: number;
}

export interface WindowsStopBudget {
  rows: WindowsStopBudgetRow[];
  totalMs: number;
}

const C = WINDOWS_STOP_CAPS;

/** Worst case of Part A still to come after its registration probe. */
export function windowsPartAWorstCaseMs(input: Pick<WindowsStopBudgetInput, "managers" | "enumerationReused" | "winswStopTimeoutMs">): number {
  const { scheduler, winsw, stray } = input.managers;
  const enumeration = input.enumerationReused ? 0 : C.enumeration;
  let ms = 0;
  if (scheduler) ms += enumeration + C.taskEnd + C.terminateAndWait + C.managerState;
  if (winsw) {
    const stopTimeout = input.winswStopTimeoutMs ?? DEFAULT_WINSW_STOP_TIMEOUT_MS;
    // WinSW has no wrapper: no bind, no terminate. Its own stop ends the proxy within
    // <stoptimeout>, so the SCM poll is capped at that plus a margin.
    ms += C.winswStopCommand + stopTimeout + C.winswPollMargin + C.managerState;
  }
  // Nothing registered: the stray enumeration already ran in the registration step.
  if (!scheduler && !winsw && stray) ms += C.terminateAndWait + C.managerState;
  return ms;
}

/**
 * Part B's sampling window: min(12 s, remaining - closing sample - final enumeration -
 * reserve), floor 6 s.
 */
export function windowsPartBWindowMs(remainingMs: number, reserveMs: number = C.reserve): number {
  const room = remainingMs - C.partBClosingSample - C.partBFinalEnumeration - reserveMs;
  return Math.max(C.partBHoldFloor, Math.min(C.partBWindowCeiling, room));
}

/** The worst case of everything still to come at admission, row by row. */
export function windowsStopWorstCase(input: WindowsStopBudgetInput): WindowsStopBudget {
  const { scheduler, winsw, stray } = input.managers;
  // WinSW stops the proxy itself, so the POST and the child exit ladder do not apply to it.
  const winswOnly = winsw && !scheduler && !stray;
  const shutdown = input.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const rows: WindowsStopBudgetRow[] = [
    { step: "part-a", ms: windowsPartAWorstCaseMs(input) },
  ];
  if (input.orphanDiscovery) rows.push({ step: "orphan-discovery", ms: C.orphanDiscovery });
  if (!winswOnly) {
    rows.push({ step: "post-answer", ms: C.postAnswer });
    rows.push({ step: "child-exit", ms: shutdown + C.childExitMargin + C.forcedKill + C.forcedExitWait });
  }
  const receipts = input.inheritedReceipts ?? 0;
  if (receipts > 0) rows.push({ step: "inherited-receipts", ms: receipts * C.inheritedReceiptProbe });
  if (input.partB ?? true) {
    rows.push({ step: "part-b", ms: C.partBHoldFloor + C.partBClosingSample + C.partBFinalEnumeration });
  }
  rows.push({ step: "reserve", ms: C.reserve });
  return { rows, totalMs: rows.reduce((sum, row) => sum + row.ms, 0) };
}
