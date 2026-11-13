import { randomBytes } from "node:crypto";
import { parseStrictSemver } from "../lib/strict-semver";
import type { ChildObservation, ChildOperationSummary } from "./child-observations";
import { CHILD_JOB_SCHEMA, type ChildJob, type ChildJobItem, type ChildOp, type ChildOpsEnv, type ChildRestart,
  type ChildTrigger, type ItemOutcome, type ItemRunner } from "./child-ops-types";
import { runObserveItem, runRestartCodexItem, runSyncItem, runUpdateItem } from "./child-ops-runners";
import type { LinkRecord } from "./store";

export { CHILD_JOB_SCHEMA } from "./child-ops-types";
export const CHILD_OPS_CONCURRENCY = 3;
/** Update items run one at a time across the engine; each also takes one of the CHILD_OPS_CONCURRENCY places. */
export const CHILD_OPS_UPDATE_CONCURRENCY = 1;
export const CHILD_JOB_RETENTION_MS = 60 * 60 * 1000;
export const CHILD_JOB_RETENTION_COUNT = 32;
/** The CLI's job validator keeps strings up to this length; a longer hint would make the whole document unreadable. */
const HINT_MAX = 256;

/** ignoreActivity (D8) is honoured only on a manual request; the route accepts it only with one link and a restart. */
export interface ChildOpRequest { op: ChildOp; linkIds: readonly string[] | "all"; restart: ChildRestart; trigger: ChildTrigger; ignoreActivity?: true }
export type SubmitRefusal = "link_not_found" | "link_not_home_initiated" | "link_operation_in_progress" | "no_eligible_links";
export type SubmitResult = { ok: true; job: ChildJob } | { ok: false; code: SubmitRefusal; linkId: string | null };
export interface ChildJobHold { jobId: string; op: ChildOp; state: "queued" | "running" }

export interface ChildOpsEngine {
  /** Synchronous admission: locks are taken before it returns, so a DELETE racing it sees them. */
  submit(request: ChildOpRequest, env: ChildOpsEnv): SubmitResult;
  /** A structuredClone snapshot. */
  job(jobId: string): ChildJob | undefined;
  activeJob(linkId: string): ChildJobHold | null;
  /**
   * Take the link's admission lock for a non-job holder (link removal). Returns null when a job holds the link;
   * otherwise a release function. While reserved, a single-link submit answers link_operation_in_progress and a
   * multi-link item for the link ends busy, exactly as for a link a job holds. Synchronous, like submit.
   */
  reserve(linkId: string): (() => void) | null;
  /** Resolves with a clone of the finished job, or null when the id is unknown or already pruned (wp5 scheduler). */
  whenDone(jobId: string): Promise<ChildJob | null>;
  /** Resolves once no job of this engine is queued or running. Tests and shutdown only. */
  settled(): Promise<void>;
}

export interface ChildOpsEngineOptions {
  runners?: Partial<Record<ChildOp, ItemRunner>>;
  jobId?: () => string;
  /** Default and maximum CHILD_OPS_CONCURRENCY. */
  concurrency?: number;
}

const DONE: ReadonlySet<string> = new Set(["succeeded", "up-to-date", "busy", "offline", "refused", "owner-action", "unsupported", "failed", "uncertain"]);
const errorName = (error: unknown): string => error instanceof Error ? error.name : "unknown";
const iso = (env: ChildOpsEnv): string => new Date(env.now()).toISOString();
const strictVersion = (value: string | undefined): value is string => typeof value === "string" && value.length <= 128 && parseStrictSemver(value) !== null;

/** 010's persisted slice; called after finishedAt is set. A version the cache would refuse ("unknown") is left out. */
export function summarize(job: ChildJob, item: ChildJobItem): ChildOperationSummary {
  return { op: job.op, jobId: job.jobId, state: item.state, reason: item.reason, finishedAt: item.finishedAt!,
    ...(strictVersion(item.fromVersion) ? { fromVersion: item.fromVersion } : {}),
    ...(strictVersion(item.toVersion) ? { toVersion: item.toVersion } : {}) };
}

/**
 * The D11 job model: one in-memory registry, one lock per link per Home process, at most three items running across
 * every job and at most one of them an update, finished jobs kept one hour and at most 32. A Home restart loses the
 * jobs only; the observation cache keeps each Child's last result. Items carry closed tokens, never remote text.
 * No timers: retention is applied on each submit and read, on each job's own env clock.
 */
export function createChildOpsEngine(options: ChildOpsEngineOptions = {}): ChildOpsEngine {
  const runners: Record<ChildOp, ItemRunner> = { observe: runObserveItem, sync: runSyncItem, "restart-codex": runRestartCodexItem,
    update: runUpdateItem, ...options.runners };
  const newJobId = options.jobId ?? (() => `ljob_${randomBytes(8).toString("hex")}`);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? CHILD_OPS_CONCURRENCY, CHILD_OPS_CONCURRENCY));
  const jobs = new Map<string, { job: ChildJob; env: ChildOpsEnv }>();
  const locks = new Map<string, string>();           // linkId -> jobId
  const idle = new Set<() => void>();
  // A running job is never pruned (prune drops done jobs only), so every waiter is resolved by finishJob.
  const waiters = new Map<string, Array<(job: ChildJob) => void>>();
  // One engine-wide FIFO: the bound is on SSH sessions from this Home, not per job.
  const pending: Array<{ job: ChildJob; item: ChildJobItem; env: ChildOpsEnv }> = [];
  let active = 0;
  let activeUpdates = 0;
  let reservations = 0;

  const write = (env: ChildOpsEnv, linkId: string, patch: Partial<ChildObservation>): void => {
    try { env.writeObservation(linkId, patch); } catch (error) {
      // The env contract is "never throws"; this guards an env that breaks it. The job document carries the result.
      console.warn(`[link] child observation write failed linkId=${linkId} error=${errorName(error)}`);
    }
  };
  const running = (): boolean => [...jobs.values()].some(({ job }) => job.state !== "done");
  const prune = (): void => {
    const finished = [...jobs.values()].filter(({ job }) => job.state === "done");
    for (const { job, env } of finished) if (Date.parse(job.finishedAt!) < env.now() - CHILD_JOB_RETENTION_MS) jobs.delete(job.jobId);
    const kept = finished.filter(({ job }) => jobs.has(job.jobId)).sort((a, b) => Date.parse(a.job.finishedAt!) - Date.parse(b.job.finishedAt!));
    for (const { job } of kept.slice(0, Math.max(0, kept.length - CHILD_JOB_RETENTION_COUNT))) jobs.delete(job.jobId);
  };
  /** ran = false: the item never touched its link (busy, child-initiated), so it writes no lastOperation. */
  const finishItem = (job: ChildJob, item: ChildJobItem, env: ChildOpsEnv, outcome: ItemOutcome, ran = true): void => {
    Object.assign(item, outcome);
    if (item.hint !== undefined && item.hint.length > HINT_MAX) item.hint = item.hint.slice(0, HINT_MAX);
    item.finishedAt = iso(env);
    if (!ran) return;
    if (locks.get(item.linkId) === job.jobId) locks.delete(item.linkId);
    write(env, item.linkId, { lastOperation: summarize(job, item) });
  };
  const finishJob = (job: ChildJob, env: ChildOpsEnv): void => {
    if (job.state === "done" || job.items.some(item => item.state === "queued" || item.state === "running")) return;
    job.state = "done";
    job.finishedAt = iso(env);
    const resolvers = waiters.get(job.jobId);
    if (resolvers) { waiters.delete(job.jobId); for (const resolve of resolvers) resolve(structuredClone(job)); }
    if (!running()) { for (const resolve of idle) resolve(); idle.clear(); }
  };
  const runItem = async (job: ChildJob, item: ChildJobItem, env: ChildOpsEnv): Promise<void> => {
    item.state = "running";
    item.startedAt = iso(env);
    if (job.state === "queued") job.state = "running";
    let record: LinkRecord | undefined;
    try { record = env.readStore().links.find(link => link.id === item.linkId); } catch { record = undefined; }
    if (!record) { finishItem(job, item, env, { state: "refused", reason: "link-removed" }); return; }
    let outcome: ItemOutcome;
    try { outcome = await runners[job.op](record, job, env); } catch (error) {
      console.warn(`[link] child ${job.op} failed linkId=${item.linkId} error=${errorName(error)}`);
      outcome = { state: "failed", reason: "internal-error" };
    }
    finishItem(job, item, env, DONE.has(outcome.state) ? outcome : { state: "failed", reason: "internal-error" });
  };
  const pump = (): void => {
    // FIFO across jobs; an update waiting for the update place does not hold up the items behind it.
    for (let index = 0; index < pending.length && active < concurrency;) {
      const entry = pending[index]!;
      const update = entry.job.op === "update";
      if (update && activeUpdates >= CHILD_OPS_UPDATE_CONCURRENCY) { index += 1; continue; }
      pending.splice(index, 1);
      active += 1;
      if (update) activeUpdates += 1;
      void runItem(entry.job, entry.item, entry.env).finally(() => {
        active -= 1;
        if (update) activeUpdates -= 1;
        finishJob(entry.job, entry.env);
        pump();
      });
    }
  };

  return {
    submit(request, env) {
      prune();
      const store = env.readStore();
      let records: LinkRecord[];
      if (request.linkIds === "all") {
        records = store.links;
        if (records.length === 0) return { ok: false, code: "no_eligible_links", linkId: null };
      } else {
        records = [];
        for (const linkId of request.linkIds) {
          const record = store.links.find(link => link.id === linkId);
          if (!record) return { ok: false, code: "link_not_found", linkId };
          records.push(record);
        }
        const only = records.length === 1 ? records[0]! : null;
        // observe answers a client-initiated link itself without SSH (020); the other ops need the Home's SSH trust.
        if (only && request.op !== "observe" && only.direction === "client-initiated") return { ok: false, code: "link_not_home_initiated", linkId: only.id };
        if (only && locks.has(only.id)) return { ok: false, code: "link_operation_in_progress", linkId: only.id };
      }
      const job: ChildJob = { schema: CHILD_JOB_SCHEMA, jobId: newJobId(), op: request.op, trigger: request.trigger,
        restart: request.restart, ...(request.ignoreActivity === true && request.trigger === "manual" ? { ignoreActivity: true as const } : {}),
        state: "queued", createdAt: iso(env), finishedAt: null,
        items: records.map(record => ({ linkId: record.id, alias: record.alias, state: "queued" as const, reason: null,
          startedAt: null, finishedAt: null })) };
      jobs.set(job.jobId, { job, env });
      job.items.forEach((item, index) => {
        if (locks.has(item.linkId)) finishItem(job, item, env, { state: "busy", reason: "link-operation-in-progress" }, false);
        else if (request.op !== "observe" && records[index]!.direction === "client-initiated") {
          finishItem(job, item, env, { state: "unsupported", reason: "child-initiated" }, false);
        } else { locks.set(item.linkId, job.jobId); pending.push({ job, item, env }); }
      });
      pump();
      finishJob(job, env);
      return { ok: true, job: structuredClone(job) };
    },
    job(jobId) {
      prune();
      const entry = jobs.get(jobId);
      return entry ? structuredClone(entry.job) : undefined;
    },
    activeJob(linkId) {
      const jobId = locks.get(linkId);
      const job = jobId ? jobs.get(jobId)?.job : undefined;
      if (!job || job.state === "done") return null;
      return { jobId: job.jobId, op: job.op, state: job.state };
    },
    reserve(linkId) {
      if (locks.has(linkId)) return null;
      // Never a job id (those start ljob_), so activeJob reads null and no job finish releases it.
      const token = `reservation:${++reservations}`;
      locks.set(linkId, token);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (locks.get(linkId) === token) locks.delete(linkId);
      };
    },
    whenDone(jobId) {
      const entry = jobs.get(jobId);
      if (!entry) return Promise.resolve(null);
      if (entry.job.state === "done") return Promise.resolve(structuredClone(entry.job));
      return new Promise<ChildJob | null>(resolve => {
        const list = waiters.get(jobId) ?? [];
        list.push(resolve);
        waiters.set(jobId, list);
      });
    },
    settled() {
      if (!running()) return Promise.resolve();
      return new Promise<void>(resolve => { idle.add(resolve); });
    },
  };
}

let shared: ChildOpsEngine | null = null;
/** One engine per Home process, shared by the routes (wp3) and the scheduler (wp5, wp7). */
export function sharedChildOpsEngine(): ChildOpsEngine {
  return shared ??= createChildOpsEngine();
}
/** Tests that reach the routes through handleManagementAPI cannot set LinkRouteState.childOps; they await
 *  sharedChildOpsEngine().settled() and call this in afterEach. Precedent: resetQuotaResetActivationForTests. */
export function resetSharedChildOpsEngineForTests(): void {
  shared = null;
}
