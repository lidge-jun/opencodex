import { randomBytes } from "node:crypto";
import { withoutCarriedFields, type ChildObservation, type ChildOp, type ChildOperationSummary } from "./child-observations";
import type { ObserveOutcome } from "./child-observe";
import type { LinkRecord, LinkStore } from "./store";

// ChildOp is declared once, in child-observations.ts; wp2 admits "observe" only. 030 moves the job types to
// child-ops-types.ts and extends this engine with its runners.
export type ChildItemState = "queued" | "running" | "succeeded" | "up-to-date" | "busy" | "offline" | "refused"
  | "owner-action" | "unsupported" | "failed" | "uncertain";
export interface ChildJobItem {
  linkId: string; alias: string; state: ChildItemState; reason: string | null; hint?: string;
  fromVersion?: string; toVersion?: string; startedAt: string | null; finishedAt: string | null;
}
export interface ChildJob {
  schema: "ocx.link.child-job/1"; jobId: string; op: ChildOp; trigger: "manual" | "auto";
  restart: "none" | "app-server" | "codex"; state: "queued" | "running" | "done"; createdAt: string; finishedAt: string | null; items: ChildJobItem[];
}
export type SubmitResult = { ok: true; job: ChildJob } | { ok: false; code: "link_not_found" | "link_operation_in_progress" | "no_eligible_links" };
export interface ChildOpsEngine {
  submit(request: { op: "observe"; linkIds: readonly string[] | "all"; trigger: "manual" | "auto" }): SubmitResult;
  /** A structuredClone snapshot. */
  job(jobId: string): ChildJob | undefined;
  activeJob(linkId: string): { jobId: string; op: ChildOp; state: "queued" | "running" } | null;
  /** Resolves once no job of this engine is queued or running. */
  settled(): Promise<void>;
}

export const CHILD_JOB_SCHEMA = "ocx.link.child-job/1";
export const CHILD_OPS_CONCURRENCY = 3;
export const CHILD_JOB_RETENTION_MS = 60 * 60 * 1000;
export const CHILD_JOB_RETENTION_COUNT = 32;

const errorName = (error: unknown): string => error instanceof Error ? error.name : "unknown";

/**
 * The D11 job model: one in-memory registry, one engine-wide lock per link, at most 3 items running across every job
 * of the engine, finished jobs kept one hour and at most 32. A Home restart loses the jobs only; the observation cache
 * keeps each Child's last result. Items carry closed tokens, never remote text. No timers: retention is applied on
 * each submit and read.
 */
export function createChildOpsEngine(deps: {
  readStore: () => LinkStore; observe: (record: LinkRecord) => Promise<ObserveOutcome>;
  /** Production: updateChildObservations(file => patchChildObservation(file, linkId, patch, now())). */
  writeObservation: (linkId: string, patch: Partial<ChildObservation>) => void;
  now?: () => Date; jobId?: () => string; concurrency?: number;
}): ChildOpsEngine {
  const now = deps.now ?? (() => new Date());
  const newJobId = deps.jobId ?? (() => `ljob_${randomBytes(8).toString("hex")}`);
  const concurrency = Math.max(1, deps.concurrency ?? CHILD_OPS_CONCURRENCY);
  const jobs = new Map<string, ChildJob>();
  const locks = new Map<string, string>();
  const idle = new Set<() => void>();
  // One engine-wide queue: the concurrency limit bounds SSH sessions across jobs, not per job.
  const pending: Array<{ job: ChildJob; item: ChildJobItem }> = [];
  let active = 0;

  const write = (linkId: string, patch: Partial<ChildObservation>): void => {
    try { deps.writeObservation(linkId, patch); } catch (error) {
      // The file is a cache and the job document already carries the result.
      console.warn(`[link] child observation write failed linkId=${linkId} error=${errorName(error)}`);
    }
  };
  const running = (): boolean => [...jobs.values()].some(job => job.state !== "done");
  const prune = (): void => {
    const cutoff = now().getTime() - CHILD_JOB_RETENTION_MS;
    const finished = [...jobs.values()].filter(job => job.state === "done");
    for (const job of finished) if (Date.parse(job.finishedAt!) < cutoff) jobs.delete(job.jobId);
    const kept = finished.filter(job => jobs.has(job.jobId)).sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));
    for (const job of kept.slice(0, Math.max(0, kept.length - CHILD_JOB_RETENTION_COUNT))) jobs.delete(job.jobId);
  };
  /** `ran` is false for an item that never touched its link (busy): the link's lastOperation belongs to its holder. */
  const finishItem = (job: ChildJob, item: ChildJobItem, state: ChildItemState, reason: string | null, ran = true): void => {
    item.state = state;
    item.reason = reason;
    item.finishedAt = now().toISOString();
    if (!ran) return;
    if (locks.get(item.linkId) === job.jobId) locks.delete(item.linkId);
    const summary: ChildOperationSummary = { op: job.op, jobId: job.jobId, state, reason, finishedAt: item.finishedAt };
    write(item.linkId, { lastOperation: summary });
  };
  const finishJob = (job: ChildJob): void => {
    if (job.state === "done" || job.items.some(item => item.state === "queued" || item.state === "running")) return;
    job.state = "done";
    job.finishedAt = now().toISOString();
    if (!running()) { for (const resolve of idle) resolve(); idle.clear(); }
  };
  const runItem = async (job: ChildJob, item: ChildJobItem): Promise<void> => {
    item.state = "running";
    item.startedAt = now().toISOString();
    if (job.state === "queued") job.state = "running";
    let record: LinkRecord | undefined;
    try { record = deps.readStore().links.find(link => link.id === item.linkId); } catch { record = undefined; }
    if (!record) { finishItem(job, item, "refused", "link-removed"); return; }
    let outcome: ObserveOutcome;
    try { outcome = await deps.observe(record); } catch (error) {
      console.warn(`[link] child observe failed linkId=${item.linkId} error=${errorName(error)}`);
      finishItem(job, item, "failed", "observe-error");
      return;
    }
    if (outcome.observation) write(item.linkId, withoutCarriedFields(outcome.observation));
    finishItem(job, item, outcome.state, outcome.reason);
  };
  const pump = (): void => {
    while (active < concurrency && pending.length > 0) {
      const { job, item } = pending.shift()!;
      active += 1;
      void runItem(job, item).finally(() => {
        active -= 1;
        finishJob(job);
        pump();
      });
    }
  };

  return {
    submit(request) {
      prune();
      const store = deps.readStore();
      let records: LinkRecord[];
      if (request.linkIds === "all") {
        records = store.links;
        if (records.length === 0) return { ok: false, code: "no_eligible_links" };
      } else {
        records = [];
        for (const linkId of request.linkIds) {
          const record = store.links.find(link => link.id === linkId);
          if (!record) return { ok: false, code: "link_not_found" };
          records.push(record);
        }
        if (records.length === 1 && locks.has(records[0]!.id)) return { ok: false, code: "link_operation_in_progress" };
      }
      const jobId = newJobId();
      const createdAt = now().toISOString();
      const job: ChildJob = { schema: CHILD_JOB_SCHEMA, jobId, op: request.op, trigger: request.trigger, restart: "none", state: "queued",
        createdAt, finishedAt: null, items: records.map(record => ({ linkId: record.id, alias: record.alias, state: "queued" as const, reason: null,
          startedAt: null, finishedAt: null })) };
      jobs.set(jobId, job);
      for (const item of job.items) {
        if (locks.has(item.linkId)) finishItem(job, item, "busy", "link-operation-in-progress", false);
        else { locks.set(item.linkId, jobId); pending.push({ job, item }); }
      }
      pump();
      finishJob(job);
      return { ok: true, job: structuredClone(job) };
    },
    job(jobId) {
      prune();
      const job = jobs.get(jobId);
      return job ? structuredClone(job) : undefined;
    },
    activeJob(linkId) {
      const jobId = locks.get(linkId);
      const job = jobId ? jobs.get(jobId) : undefined;
      if (!job || job.state === "done") return null;
      return { jobId: job.jobId, op: job.op, state: job.state };
    },
    settled() {
      if (!running()) return Promise.resolve();
      return new Promise<void>(resolve => { idle.add(resolve); });
    },
  };
}
