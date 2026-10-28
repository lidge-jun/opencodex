/**
 * Parent-side dispatch for Codex CLI update plan/apply workers.
 *
 * The HTTP route and CLI keep their existing contracts: admission and the
 * generation-fenced durable ledger stay in this realm, the spawned Worker
 * realm owns the heavy inspection, hashing and installer lifetime. A job is
 * one fresh Worker plus one unique requestId plus the ledger generation; no
 * wire generation is needed because the Worker runs once, ignores later
 * messages and closes.
 *
 * Cancellation uses BOTH channels: the per-job shared fence's
 * PREPARING -> CANCELLED compare-exchange (the only word a synchronous
 * worker section can observe) and a "cancel" message that aborts the real
 * AbortSignal handed to apply's fetchArtifact path. The message is posted
 * only when the fence CAS won, so a cancel arriving after COMMITTED defers
 * to the live installer's close exactly like the in-process contract.
 *
 * Settlement requires BOTH a valid reply AND the Worker's close. A reply
 * alone is never terminal evidence: a legitimate result can still report
 * installer_state_unknown or version_process_state_unknown with a retained
 * lease and a live verification child, so done-without-close means the Worker's
 * own exit could not be observed and the job resolves ambiguous with its lease
 * state unknown. This host never calls terminate(): an unresponsive Worker may
 * legitimately own a running npm child, and killing the thread would orphan
 * the very lifetime the ledger must keep reporting as unknown. Workers that
 * settle ambiguous while still alive are tracked in the unjoined set so their
 * count is observable evidence rather than a silent leak.
 */
import { randomUUID } from "node:crypto";
import type { CodexCliApplyResult } from "./cli-update-apply";
import type { CodexCliUpdateChannel, CodexCliUpdatePlan } from "./cli-update-plan";
import type { CodexCliUpdateInspectionSnapshot } from "./cli-update-inspection-context";
import { trustedNodeLauncherContext } from "../cli/launcher-context";
import { spawnWorker } from "../lib/worker-embed";
import { recoverClosedCodexCliUpdateWorker } from "./cli-update-worker-recovery";
import {
  CODEX_CLI_UPDATE_GATE_FREE,
  CODEX_CLI_UPDATE_GATE_PARENT_WRITE,
  CODEX_CLI_UPDATE_GATE_WORKER_COMMIT,
  cancelCodexCliUpdateFence,
  codexCliUpdateSelectionGate,
  createCodexCliUpdateFence,
  allocateCodexCliUpdateGateOwner,
} from "./cli-update-selection-gate";
import type { CodexCliUpdateWorkerReply, CodexCliUpdateWorkerRunMessage } from "./cli-update-worker";

/** Grace for the Worker's close after a valid reply before the run goes ambiguous. */
const WORKER_CLOSE_GRACE_MS = 10_000;

interface LiveJobRecord {
  /** Fence CAS plus async cancel delivery; false when the fence already moved. */
  readonly cancel: () => boolean;
  readonly settled: () => boolean;
  readonly workerClosed: () => boolean;
}

const liveJobs = new Map<string, LiveJobRecord>();
const recoveryJobs = new Map<string, () => void>();
/** Explicit reconciliation request; only the original Worker can observe its
 * original native Job. This never reruns apply or changes the earlier receipt.
 */
export function recoverCodexCliUpdateWorkerJob(jobId: string): boolean {
  const recover = recoveryJobs.get(jobId);
  if (!recover) return false;
  recover(); return true;
}
const unjoinedWorkers = new Set<Worker>();
let unjoinedWorkerClosedTotal = 0;

/**
 * Parent cancellation for one in-flight job: CASes that job's fence
 * PREPARING -> CANCELLED and, only when that word was won, posts the async
 * "cancel" message that aborts the worker's real AbortSignal. False when the
 * job is unknown here or its fence already committed/cancelled — a lost CAS
 * never reaches the worker, so a post-COMMITTED cancel stays deferred.
 */
export function cancelCodexCliUpdateWorkerJob(jobId: string): boolean {
  return liveJobs.get(jobId)?.cancel() ?? false;
}

/** Workers that settled ambiguous while still alive; evidence, not a leak counter. */
export function codexCliUpdateUnjoinedWorkerCount(): number {
  return unjoinedWorkers.size;
}

/**
 * Cumulative count of workers that settled without close evidence and were
 * later observed closed — removed from the live set but retained as evidence.
 */
export function codexCliUpdateUnjoinedWorkerClosedTotal(): number {
  return unjoinedWorkerClosedTotal;
}

/**
 * Operator-facing snapshot for diagnosing admission. Worker holder words
 * carry generations; recovery observers can outlive the dispatch receipt.
 * The liveJobs list remains dispatch evidence, not a list of OS children.
 */
export interface CodexCliUpdateWorkerDiagnostics {
  readonly gate: "free" | "parent_write" | "worker_commit" | "unrecognized";
  readonly liveJobs: readonly {
    readonly jobId: string;
    readonly settled: boolean;
    readonly workerClosed: boolean;
  }[];
  readonly unjoinedWorkers: number;
  readonly unjoinedWorkerClosedTotal: number;
}

export function codexCliUpdateWorkerDiagnostics(): CodexCliUpdateWorkerDiagnostics {
  const raw = Atomics.load(new Int32Array(codexCliUpdateSelectionGate()), 0);
  const gate = raw === CODEX_CLI_UPDATE_GATE_FREE ? "free"
    : raw === CODEX_CLI_UPDATE_GATE_PARENT_WRITE ? "parent_write"
    : raw >= CODEX_CLI_UPDATE_GATE_WORKER_COMMIT ? "worker_commit"
    : "unrecognized";
  return {
    gate,
    liveJobs: [...liveJobs.entries()].map(([jobId, record]) => ({
      jobId, settled: record.settled(), workerClosed: record.workerClosed(),
    })),
    unjoinedWorkers: unjoinedWorkers.size,
    unjoinedWorkerClosedTotal,
  };
}

export interface CodexCliUpdateWorkerSpawnOptions {
  /** Frozen launcher snapshot; default captures the trusted context at call time. */
  readonly snapshot?: CodexCliUpdateInspectionSnapshot;
  /** Optional external abort: fires the same fence CAS as cancelCodexCliUpdateWorkerJob. */
  readonly signal?: AbortSignal;
  /** Test seam: spawn a fixture Worker instead of the bundled entrypoint. */
  readonly spawnWorkerFn?: (devUrl: string, key: string) => Worker;
  readonly closeGraceMs?: number;
  readonly env?: { readonly CODEX_HOME?: string; readonly OPENCODEX_HOME?: string };
}

type DispatchSettlement =
  | { readonly kind: "reply"; readonly reply: CodexCliUpdateWorkerReply }
  | { readonly kind: "spawn_failed" }
  | { readonly kind: "unsettled" };

const APPLY_OUTCOMES: ReadonlySet<string> = new Set(["refused", "applied", "not_applied", "ambiguous"]);

/**
 * Reject a reply that names our ids but lacks its payload. Accepting a
 * shapeless "done" would read success out of work that may not have happened;
 * the ledger's downstream normalizer is a second clamp, not the only check.
 */
function isPlausibleWorkerReply(
  data: unknown,
  requestId: string,
  jobId: string,
  operation: "plan" | "apply",
): data is CodexCliUpdateWorkerReply {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const o = data as Record<string, unknown>;
  if (o.requestId !== requestId || o.jobId !== jobId) return false;
  if (o.type === "error") return typeof o.message === "string";
  if (o.type !== "done" || o.operation !== operation) return false;
  if (operation === "plan") {
    return !!o.plan && typeof o.plan === "object" && !Array.isArray(o.plan);
  }
  const result = o.result;
  return !!result && typeof result === "object" && !Array.isArray(result)
    && APPLY_OUTCOMES.has((result as { outcome?: unknown }).outcome as string)
    && typeof (result as { reason?: unknown }).reason === "string";
}

function trackUnjoined(worker: Worker, alreadyClosed: boolean): void {
  if (unjoinedWorkers.has(worker)) return;
  if (alreadyClosed) {
    // The close is already evidenced; keep the diagnostic without pretending
    // a dead Worker is a live leak.
    unjoinedWorkerClosedTotal++;
    warnIfCommitGateHeld();
    return;
  }
  unjoinedWorkers.add(worker);
  worker.addEventListener("close", () => {
    if (!unjoinedWorkers.delete(worker)) return;
    unjoinedWorkerClosedTotal++;
    warnIfCommitGateHeld();
  }, { once: true });
}

/**
 * A closed worker can still have a live installer group. Owner-scoped
 * recovery releases admission only after matching terminal proof.
 */
function warnIfCommitGateHeld(): void {
  if (Atomics.load(new Int32Array(codexCliUpdateSelectionGate()), 0)
    < CODEX_CLI_UPDATE_GATE_WORKER_COMMIT) return;
  console.warn(
    "[opencodex] a Codex CLI update worker closed while the shared selection gate still reads"
    + " worker_commit; admission awaits owner-scoped terminal evidence — inspect"
    + " codexCliUpdateWorkerDiagnostics() before retrying a busy operation",
  );
}

interface DispatchState {
  settled: boolean;
  closed: boolean;
}

function dispatchWorker(
  worker: Worker,
  message: CodexCliUpdateWorkerRunMessage,
  options: CodexCliUpdateWorkerSpawnOptions,
  state: DispatchState,
): Promise<DispatchSettlement> {
  return new Promise<DispatchSettlement>(resolve => {
    let reply: CodexCliUpdateWorkerReply | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: DispatchSettlement) => {
      if (state.settled) return;
      state.settled = true;
      if (grace) clearTimeout(grace);
      resolve(value);
    };
    // Every non-reply terminal signal keeps the possibly-live Worker tracked:
    // it can still own an installer child the ledger must report as unknown.
    const unsettled = () => {
      if (state.settled) return;
      trackUnjoined(worker, state.closed);
      finish({ kind: "unsettled" });
    };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      // A settled or already-closed dispatch ignores late traffic entirely:
      // a duplicate or post-close message must not re-arm the grace timer,
      // attach listeners or re-add the Worker to the unjoined set. Once a
      // valid reply is stored it is authoritative: a run-once Worker cannot
      // legitimately send a second result, so a late "better" duplicate or a
      // trailing error reply never replaces the first correlated payload.
      if (state.settled || state.closed || reply !== undefined) return;
      const data = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        unsettled();
        return;
      }
      const m = data as Record<string, unknown>;
      // A reply naming different ids belongs to someone else; ignoring it is
      // not the same as accepting it.
      if (m.requestId !== message.requestId || m.jobId !== message.jobId) return;
      if (!isPlausibleWorkerReply(data, message.requestId, message.jobId, message.operation)) {
        unsettled();
        return;
      }
      // done alone is not terminal evidence: the Worker's own close still has
      // to be observed, and within the grace a late close still settles reply.
      // The reply is stored once; the single close handler below decides.
      reply = data as CodexCliUpdateWorkerReply;
      grace = setTimeout(() => unsettled(), options.closeGraceMs ?? WORKER_CLOSE_GRACE_MS);
    };
    worker.addEventListener("messageerror", () => unsettled());
    worker.addEventListener("close", () => {
      state.closed = true;
      recoverClosedCodexCliUpdateWorker(message.gate, message.fence, message.owner!, message.requestId,
        message.env?.OPENCODEX_HOME);
      if (grace) clearTimeout(grace);
      // One close handler decides everything: a stored valid reply wins, any
      // other close — before a reply, or after only implausible traffic — is
      // unknown work, not a clean refusal.
      if (reply !== undefined) finish({ kind: "reply", reply });
      else unsettled();
    }, { once: true });
    worker.onerror = () => unsettled();
    try {
      worker.postMessage(message);
    } catch {
      // A synchronous post failure leaves delivery uncertain: the thread is
      // alive and may (or may not) have received the run. Unknown work must
      // never be downgraded to a provable pre-run refusal.
      unsettled();
    }
  });
}

function applyFallback(planId: string, settled: DispatchSettlement): CodexCliApplyResult {
  return Object.freeze(
    settled.kind === "spawn_failed"
      ? {
          outcome: "refused" as const, reason: "preparation_failed", planId,
          installedVersion: null, targetVersion: null, installerExitCode: null,
          leaseRetained: false, verificationPid: null, cleanupErrors: Object.freeze([]),
        }
      : {
          outcome: "ambiguous" as const, reason: "job_result_unknown", planId,
          installedVersion: null, targetVersion: null, installerExitCode: null,
          leaseRetained: true, verificationPid: null, cleanupErrors: Object.freeze([]),
        },
  );
}

async function runInWorker(
  operation: "plan" | "apply",
  fields: { readonly planId?: string; readonly channel?: CodexCliUpdateChannel },
  options: CodexCliUpdateWorkerSpawnOptions & { readonly jobId?: string },
): Promise<DispatchSettlement> {
  const jobId = options.jobId ?? randomUUID();
  const requestId = randomUUID();
  const fence = createCodexCliUpdateFence();
  const owner = allocateCodexCliUpdateGateOwner(codexCliUpdateSelectionGate());
  const snapshot = options.snapshot !== undefined
    ? options.snapshot
    : trustedNodeLauncherContext()?.codexCliInspectionEnv ?? null;
  let worker: Worker;
  try {
    const injectedSpawn = options.spawnWorkerFn;
    worker = injectedSpawn === undefined || injectedSpawn === null
      ? spawnWorker(new URL("./cli-update-worker.ts", import.meta.url).href, "cli-update-worker")
      : injectedSpawn(new URL("./cli-update-worker.ts", import.meta.url).href, "cli-update-worker");
  } catch {
    // Spawn threw before the run message existed: provably no job code ran.
    return { kind: "spawn_failed" };
  }
  const state: DispatchState = { settled: false, closed: false };
  const cancel = () => {
    if (!cancelCodexCliUpdateFence(fence)) return false;
    // Async cancel delivery only rides a won CAS: the worker's real
    // AbortSignal aborts its in-flight fetchArtifact download, while the
    // fence remains the synchronous-section channel. A post-COMMITTED cancel
    // loses the CAS and is never posted, so the live child keeps its close.
    try { worker.postMessage({ type: "cancel", requestId, jobId }); } catch { /* already closing */ }
    return true;
  };
  liveJobs.set(jobId, {
    cancel,
    settled: () => state.settled,
    workerClosed: () => state.closed,
  });
  const signal = options.signal;
  const onAbort = () => { cancel(); };
  try {
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const message: CodexCliUpdateWorkerRunMessage = {
      type: "run",
      requestId,
      jobId,
      operation,
      ...(fields.planId !== undefined ? { planId: fields.planId } : {}),
      ...(fields.channel !== undefined ? { channel: fields.channel } : {}),
      snapshot,
      gate: codexCliUpdateSelectionGate(),
      fence,
      owner,
      ...(options.env ? { env: options.env } : {}),
    };
    const recover = () => {
      try { worker.postMessage({ type: "recover", requestId, jobId }); } catch { /* no terminal evidence */ }
    };
    recoveryJobs.set(jobId, recover);
    worker.addEventListener("close", () => { if (recoveryJobs.get(jobId) === recover) recoveryJobs.delete(jobId); }, { once: true });
    return await dispatchWorker(worker, message, options, state);
  } finally {
    liveJobs.delete(jobId);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Run one confirmed apply in a fresh Worker. Results are the worker realm's
 * own CodexCliApplyResult verbatim; dispatch failures synthesize the two
 * honest fallbacks (refused preparation_failed only when no job code provably
 * ran, otherwise ambiguous job_result_unknown with the lease unknown).
 */
export async function runCodexCliUpdateApplyInWorker(
  planId: string,
  options: CodexCliUpdateWorkerSpawnOptions & { readonly jobId?: string } = {},
): Promise<CodexCliApplyResult> {
  const settled = await runInWorker("apply", { planId }, options);
  if (settled.kind === "reply" && settled.reply.type === "done" && settled.reply.operation === "apply") {
    return settled.reply.result;
  }
  return applyFallback(planId, settled);
}

/**
 * Run one read-only plan in a fresh Worker. There is no ledger for a plan, so
 * a dispatch failure surfaces exactly like today's thrown inspection error:
 * the route translates it into plan_unavailable.
 */
export async function runCodexCliUpdatePlanInWorker(
  options: CodexCliUpdateWorkerSpawnOptions & { readonly channel?: CodexCliUpdateChannel } = {},
): Promise<CodexCliUpdatePlan> {
  const settled = await runInWorker("plan", { channel: options.channel ?? "latest" }, options);
  if (settled.kind === "reply" && settled.reply.type === "done" && settled.reply.operation === "plan") {
    return settled.reply.plan;
  }
  throw new Error("plan_unavailable");
}
