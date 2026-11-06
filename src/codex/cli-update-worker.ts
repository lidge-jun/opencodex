/**
 * Worker-thread entry for one Codex CLI update plan or apply job.
 *
 * The parent owns admission and the durable job ledger; this realm owns the
 * heavy inspection, hashing, staging and installer lifetime. The mutation
 * evidence WeakMap is per-realm, which is exactly why the whole plan/apply
 * must run here rather than only its hashing: report objects and their
 * internal evidence cannot cross the realm boundary together.
 *
 * The message carries the allowlisted launcher snapshot (never the parent's
 * trusted context) plus two shared-memory cells: the process-wide selection
 * GATE the worker holds for its short final window, and the per-job FENCE
 * whose PREPARING -> CANCELLED / PREPARING -> COMMITTED compare-exchanges
 * decide cancel-vs-spawn atomically. A "cancel" message aborts the real
 * AbortSignal handed to apply's fetchArtifact path — the asynchronous half
 * of cancellation; the fence remains the synchronous-section half, and a
 * cancel that loses the commit CAS is never posted. Any other second
 * message is ignored: one worker runs exactly one job and then closes, so
 * a late duplicate or a stale generation cannot attach new work to a dying
 * realm.
 */
import { createCodexCliUpdatePlan, type CodexCliUpdateChannel, type CodexCliUpdatePlan } from "./cli-update-plan";
import { applyCodexCliUpdate, type CodexCliApplyResult } from "./cli-update-apply";
import {
  codexCliUpdateInspectionDepsFromSnapshot,
  type CodexCliUpdateInspectionSnapshot,
} from "./cli-update-inspection-context";
import { codexCliUpdateIsCancelled, createWorkerCommitWindow } from "./cli-update-selection-gate";
import { recoverWindowsCodexCliInstallations } from "./cli-update-windows-apply";
import { WindowsCliToolchainCleanupError } from "./cli-update-job-store-windows";
import { createCodexCliUpdateRecovery } from "./cli-update-recovery";

export interface CodexCliUpdateWorkerRunMessage {
  readonly type: "run";
  readonly requestId: string;
  readonly jobId: string;
  readonly operation: "plan" | "apply";
  readonly planId?: string;
  readonly channel?: CodexCliUpdateChannel;
  /** Frozen allowlisted launcher snapshot; never supplemented from ambient env. */
  readonly snapshot: CodexCliUpdateInspectionSnapshot;
  /** Process-wide selection gate cell (see cli-update-selection-gate). */
  readonly gate: SharedArrayBuffer;
  /** Per-job cancel/commit fence cell. */
  readonly fence: SharedArrayBuffer;
  readonly owner?: number;
  /** Env snapshot: a Worker may not observe parent mutations on every platform. */
  readonly env?: { readonly CODEX_HOME?: string; readonly OPENCODEX_HOME?: string };
}
/** Same generation/recovery binding for each production worker execution. */
export function createCodexCliWorkerCommitWindow(message: Pick<CodexCliUpdateWorkerRunMessage,
  "gate" | "fence" | "owner" | "requestId">) {
  return createWorkerCommitWindow({ gate: message.gate, fence: message.fence, owner: message.owner,
    recovery: createCodexCliUpdateRecovery(message.requestId) });
}

/** Async half of cancellation; the fence CAS is the synchronous half. */
export interface CodexCliUpdateWorkerCancelMessage {
  readonly type: "cancel";
  readonly requestId?: string;
  readonly jobId?: string;
}

export type CodexCliUpdateWorkerReply =
  | { readonly type: "done"; readonly requestId: string; readonly jobId: string;
      readonly operation: "plan"; readonly plan: CodexCliUpdatePlan }
  | { readonly type: "done"; readonly requestId: string; readonly jobId: string;
      readonly operation: "apply"; readonly result: CodexCliApplyResult }
  | { readonly type: "error"; readonly requestId: string; readonly jobId: string;
      readonly message: string };

function isSharedBuffer(value: unknown): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== "undefined"
    && value instanceof SharedArrayBuffer
    && value.byteLength >= Int32Array.BYTES_PER_ELEMENT;
}

function isRunMessage(data: unknown): data is CodexCliUpdateWorkerRunMessage {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const o = data as Record<string, unknown>;
  return o.type === "run"
    && typeof o.requestId === "string"
    && typeof o.jobId === "string"
    && (o.operation === "plan" || o.operation === "apply")
    && (o.planId === undefined || typeof o.planId === "string")
    && (o.channel === undefined || o.channel === "latest")
    && (o.snapshot === null || (typeof o.snapshot === "object" && !Array.isArray(o.snapshot)))
    && isSharedBuffer(o.gate)
    && o.gate.byteLength >= Int32Array.BYTES_PER_ELEMENT * 2
    && isSharedBuffer(o.fence) && o.fence.byteLength >= Int32Array.BYTES_PER_ELEMENT * 3
    && (o.owner === undefined || (Number.isSafeInteger(o.owner) && (o.owner as number) >= 2));
}

declare const self: Worker;

// One real AbortSignal per realm for apply's fetchArtifact path; aborting it
// is idempotent, so a cancel that arrives before the run still refuses the
// apply at its first checkpoint via signal.aborted.
const applyAbort = new AbortController();
let ran = false;
let runIdentity: { requestId: string; jobId: string } | undefined;
// A raw Win32 handle is not a Bun event-loop reference. Keep the run-once
// handler AND exact resource roots until their terminal cleanup releases them.
export function createCodexCliWorkerLifetime(detach: () => void) {
  let executionFinished = false;
  let detached = false;
  const retainedExecutions = new Set<object>();
  const maybeDetach = () => {
    if (executionFinished && !detached && retainedExecutions.size === 0) { detached = true; detach(); }
  };
  return {
    retain(owner: object): { release(): void } {
      const token = { owner };
      retainedExecutions.add(token);
      return { release() { if (retainedExecutions.delete(token)) maybeDetach(); } };
    },
    finish() { executionFinished = true; maybeDetach(); },
  };
}
const lifetime = createCodexCliWorkerLifetime(() => { self.onmessage = null; });

// Guarded so the module can be imported directly by tests without a Worker host.
if (typeof Bun !== "undefined" && Bun.isMainThread === false
  && typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = async (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (data && typeof data === "object" && !Array.isArray(data)
      && (data as { type?: unknown }).type === "recover"
      && runIdentity && (data as { requestId?: unknown }).requestId === runIdentity.requestId
      && (data as { jobId?: unknown }).jobId === runIdentity.jobId) {
      await recoverWindowsCodexCliInstallations();
      return;
    }
    if (data && typeof data === "object" && !Array.isArray(data)
      && (data as CodexCliUpdateWorkerCancelMessage).type === "cancel") {
      applyAbort.abort();
      return;
    }
    if (ran || !isRunMessage(data)) return;
    ran = true;
    const message = data;
    runIdentity = { requestId: message.requestId, jobId: message.jobId };
    try {
      // Home overrides apply before anything resolves a home-derived path in
      // this realm; they are transport for the job, never snapshot fields.
      if (message.env?.CODEX_HOME) process.env.CODEX_HOME = message.env.CODEX_HOME;
      if (message.env?.OPENCODEX_HOME) process.env.OPENCODEX_HOME = message.env.OPENCODEX_HOME;
      const inspectionDeps = codexCliUpdateInspectionDepsFromSnapshot(message.snapshot);
      if (message.operation === "plan") {
        const plan = await createCodexCliUpdatePlan({
          channel: message.channel ?? "latest",
          inspectionDeps,
        });
        self.postMessage({
          type: "done", requestId: message.requestId, jobId: message.jobId,
          operation: "plan", plan,
        } satisfies CodexCliUpdateWorkerReply);
      } else {
        if (typeof message.planId !== "string") throw new Error("cli_update_worker_missing_plan_id");
        const result = await applyCodexCliUpdate(message.planId, {
          inspectionDeps,
          signal: applyAbort.signal,
          isCancelled: codexCliUpdateIsCancelled(message.fence),
          commitWindow: createCodexCliWorkerCommitWindow(message),
          retainExecution: owner => lifetime.retain(owner),
        });
        self.postMessage({
          type: "done", requestId: message.requestId, jobId: message.jobId,
          operation: "apply", result,
        } satisfies CodexCliUpdateWorkerReply);
      }
    } catch (error) {
      if (error instanceof WindowsCliToolchainCleanupError) lifetime.retain(error.acquisition);
      self.postMessage({
        type: "error", requestId: message.requestId, jobId: message.jobId,
        message: error instanceof Error ? error.message : "cli_update_worker_failed",
      } satisfies CodexCliUpdateWorkerReply);
    } finally {
      // Bun 1.4.4 has no self.close(). Drop the handler only when native owners
      // have released every token; referenced child/I/O work must also drain.
      // The parent's close event is not proof that every OS descendant exited.
      lifetime.finish();
    }
  };
}
