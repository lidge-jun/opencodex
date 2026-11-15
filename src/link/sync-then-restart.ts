import type { ChildRestart, ChildRestartOutcome } from "./child-ops-types";
import type { LinkRecord } from "./store";

/**
 * "Sync then guarded restart" (A2, 040 decision 7): the one implementation used by the Child operation runners
 * (child-ops-runners.ts) and by ocx sync --restart-children (src/cli/sync-command.ts). Type-only imports, so the CLI
 * pulls nothing else in. The caller supplies the pinned sync and the activity read.
 */

/** Revision 6 F2 (030): a restarting sync that may have run but whose result is unknown. */
export const RESTART_RESULT_UNKNOWN = "restart-result-unknown";

type Verdict = { state: string; reason: string | null; executable?: "ocx-child" };
/** One pinned sync: its verdict and whether it certainly ran nothing on the Child (F2). */
export interface PinnedRun<S extends Verdict> { sync: S; notRun: boolean }
/** Why no restart went out. In process only; never serialized into a job or ocx.sync.fanout/1. */
export type RestartWithheld = "platform" | "ocx-child" | "sync-failed" | "activity-unknown" | "link-active" | "second-not-run";

export interface SyncThenRestart<S extends Verdict> {
  /** The plain sync's verdict, or the restarting sync's when restartUnknown. */
  sync: S;
  restart?: { requested: "app-server" | "codex"; outcome: ChildRestartOutcome };
  restartUnknown?: true;
  withheld?: RestartWithheld;
  /** The restarting sync's verdict whenever one ran. */
  second?: S;
}

/**
 * F2: the gate refused before selecting an ocx (121, 125, 126, 127 without the selection marker), or the Child's sync
 * declined (skipped). A dropped channel (255), a failure after selection or a timeout may have restarted Codex.
 */
export function pinnedSyncRanNothing(verdict: Verdict, result: { code: number; stderr: string }): boolean {
  const selected = /^ocx-fanout:selected:/m.test(result.stderr);
  return verdict.state === "skipped" || (verdict.state === "failed" && !selected && [121, 125, 126, 127].includes(result.code));
}

/**
 * Revision 4 (4529521916): the catalog sync runs first without a restart; activity is read after it; the restart then
 * goes out as a second pinned sync, which is close to a no-op sync. The gap between the activity read and the restart is
 * one SSH round trip instead of a whole sync. It cannot be closed from the Home: the restart executes on the Child.
 */
export async function syncThenRestart<S extends Verdict>(input: {
  requested: ChildRestart; platform: "posix" | "windows"; childKind: LinkRecord["childKind"];
  runPinned: (restart: ChildRestart) => Promise<PinnedRun<S>>;
  /** Read after the plain sync, immediately before the restart. null is unknown and counts as in flight (D5). */
  readActivity: () => Promise<{ inFlight: number } | null>;
}): Promise<SyncThenRestart<S>> {
  const { requested } = input;
  const first = (await input.runPinned("none")).sync;
  if (requested === "none") return { sync: first };
  if (input.platform !== "posix") return { sync: first, restart: { requested, outcome: "unsupported" }, withheld: "platform" };
  if (input.childKind === "ephemeral") return { sync: first, restart: { requested, outcome: "unsupported" }, withheld: "ocx-child" };
  if (first.state !== "synced") return { sync: first, restart: { requested, outcome: "not-run" }, withheld: "sync-failed" };
  const activity = await input.readActivity();
  if (activity === null) return { sync: first, restart: { requested, outcome: "skipped" }, withheld: "activity-unknown" };
  if (activity.inFlight > 0) return { sync: first, restart: { requested, outcome: "skipped" }, withheld: "link-active" };
  const second = await input.runPinned(requested);
  // 4529521993: a record without childKind can still select ocx-child, which ignores the flag (010 selected-kind marker).
  if (second.sync.executable === "ocx-child") return { sync: first, restart: { requested, outcome: "unsupported" }, withheld: "ocx-child", second: second.sync };
  if (second.sync.state === "synced") return { sync: first, restart: { requested, outcome: "requested" }, second: second.sync };
  if (second.notRun) return { sync: first, restart: { requested, outcome: "not-run" }, withheld: "second-not-run", second: second.sync };
  // F2: the restart was sent and its result is unknown; the caller reports the second sync beside it.
  return { sync: second.sync, restart: { requested, outcome: "requested" }, restartUnknown: true, second: second.sync };
}
