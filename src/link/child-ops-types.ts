import type { LinkRecord, LinkStore } from "./store";
import type { SshRunner } from "./ssh-runner";
import type { LinkWireState } from "./status-projection";
import type { ChildObservation, ChildOp } from "./child-observations";
import type { ObserveOutcome } from "./child-observe";

/**
 * The ocx.link.child-job/1 vocabulary (030 2.1). ChildOp is declared once, in child-observations.ts; the GUI keeps its
 * own wire mirror. Item states and reasons are closed tokens produced by this Home, never remote text.
 */
export type { ChildOp } from "./child-observations";
export const CHILD_JOB_SCHEMA = "ocx.link.child-job/1" as const;
export const CHILD_OPS = ["observe", "sync", "restart-codex", "update"] as const satisfies readonly ChildOp[];
/** The most link ids one operations request may name; the dashboard splits a larger bulk list into groups of this size. */
export const CHILD_OPS_MAX_LINK_IDS = 64;
export type ChildRestart = "none" | "app-server" | "codex";
export type ChildTrigger = "manual" | "auto";
export const CHILD_ITEM_STATES = ["queued", "running", "succeeded", "up-to-date", "busy", "offline",
  "refused", "owner-action", "unsupported", "failed", "uncertain"] as const;
export type ChildItemState = typeof CHILD_ITEM_STATES[number];
/**
 * requested: the restart went out (its effect is not confirmed). unsupported: Windows, ocx-child or an ephemeral Child.
 * not-run: the sync before it did not reach synced, or the restarting call was refused before an ocx was selected.
 * skipped: withheld because a relayed model request was in flight (A2, reason restart-skipped:link-active).
 */
export type ChildRestartOutcome = "requested" | "unsupported" | "not-run" | "skipped";
export const RESTART_SKIPPED = "restart-skipped:link-active";

export interface ChildJobItem {
  linkId: string;
  alias: string;
  state: ChildItemState;
  /** Closed reason vocabulary (030 Section 4). Never remote output. */
  reason: string | null;
  hint?: string;
  fromVersion?: string;
  toVersion?: string;
  /** executable: set only when 010's selected-kind marker reported ocx-child (Revision 4). */
  sync?: { state: "synced" | "skipped" | "failed" | "timed-out"; reason: string | null; executable?: "ocx-child" };
  restart?: { requested: "app-server" | "codex"; outcome: ChildRestartOutcome };
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChildJob {
  schema: typeof CHILD_JOB_SCHEMA;
  /** "ljob_" + 16 lowercase hex. */
  jobId: string;
  op: ChildOp;
  trigger: ChildTrigger;
  restart: ChildRestart;
  /** D8: present only on a manual restart the operator sent past activity (--ignore-activity); never on an automatic job. */
  ignoreActivity?: true;
  state: "queued" | "running" | "done";
  createdAt: string;
  finishedAt: string | null;
  items: ChildJobItem[];
}

export type ItemOutcome = Omit<ChildJobItem, "linkId" | "alias" | "startedAt" | "finishedAt">;

/** Everything an item needs from the Home process; built per submit by the route (030 2.4) or the wp5 host. */
export interface ChildOpsEnv {
  readStore(): LinkStore;
  runner: Pick<SshRunner, "run">;
  knownHostsFile: string;
  wireState(linkId: string): LinkWireState | null;
  /** idle = isLinkIdle(snapshot, now, idleAfterMs); null when the listener has no activity book (never idle). */
  activity(linkId: string): { idle: boolean; inFlight: number } | null;
  homeVersion: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** observeChild(record, ObserveDeps) bound to this env's runner, known hosts, Home version and peer reports. */
  observe(record: LinkRecord): Promise<ObserveOutcome>;
  readObservation(linkId: string): ChildObservation | null;
  /**
   * updateChildObservations(file => patchChildObservation(file, linkId, patch, new Date(now()))). Never throws: the
   * file is a cache and the job document already carries the result, so a failed write is logged by error name and
   * dropped. Every runner relies on this contract.
   */
  writeObservation(linkId: string, patch: Partial<ChildObservation>): void;
  /** Revision 4: the Home catalog etag now (020 monitor); a synced item records it as catalogSyncedEtag. */
  catalogEtag(): string | null;
  /** Revision 4: 050's host sets it for automatic jobs; a sync item re-asks it when the item starts. Absent ⇒ allowed. */
  autoSyncAllowed?(linkId: string): boolean;
}

export type ItemRunner = (record: LinkRecord, job: Readonly<Pick<ChildJob, "op" | "trigger" | "restart" | "ignoreActivity">>,
  env: ChildOpsEnv) => Promise<ItemOutcome>;
