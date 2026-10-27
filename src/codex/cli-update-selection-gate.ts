/**
 * Shared commit fence and selection gate for the Codex CLI update worker.
 *
 * The update's last synchronous turn (final process scan, prefix/preimage/
 * selection guards, installer spawn) runs inside a Worker realm now, so the
 * old same-event-loop-turn argument no longer excludes the parent's own
 * selection-mutating operations or its session-spawn paths. Two shared-memory
 * primitives carry that exclusion across realms:
 *
 * - FENCE (one per dispatched job): the parent's only cancellation word is
 *   PREPARING -> CANCELLED, and the worker's only commit word is
 *   PREPARING -> COMMITTED. Exactly one compareExchange wins. A cancel that
 *   lands first is observed by the worker's isCancelled checkpoints and by
 *   the commit CAS losing; a commit that lands first means the npm spawn
 *   already happened and a late cancel is deferred to readback.
 *
 * - GATE (one process-wide holder plus generation counter): PARENT_WRITE belongs to the five
 *   parent selection writers (runtime pin persist/clear, shim install/
 *   auto-restore/uninstall) and the two parent session-spawn paths (remote
 *   workspace child, desktop relaunch). A unique worker generation is taken by the
 *   update worker through installer termination and post-install readback.
 *   Writers report busy rather than wait: a synchronous parent writer
 *   must never park the event loop behind it. The gate is intentionally one
 *   cell for the whole process rather than per-configDir: alias/junction/case
 *   spellings of the same target must not split the exclusion, so a writer on
 *   a different configDir can also see busy until the installation settles.
 *
 * This module claims nothing about processes it does not own: an external
 * installer, a late descendant of an earlier child, or an OS snapshot race
 * stays the documented residual it always was.
 */

import { codexCliUpdateRecoveryBlocksAdmission } from "./cli-update-recovery";

export const CODEX_CLI_UPDATE_FENCE_PREPARING = 0;
export const CODEX_CLI_UPDATE_FENCE_CANCELLED = 1;
export const CODEX_CLI_UPDATE_FENCE_COMMITTED = 2;
export const CODEX_CLI_UPDATE_FENCE_RECOVERING = 3;

export const CODEX_CLI_UPDATE_GATE_FREE = 0;
export const CODEX_CLI_UPDATE_GATE_PARENT_WRITE = 1;
export const CODEX_CLI_UPDATE_GATE_WORKER_COMMIT = 2;

/** Bounded wait for a parent writer's window; the worker then refuses busy. */
const WORKER_COMMIT_WAIT_DEADLINE_MS = 30_000;

export class CodexCliSelectionMutationBusyError extends Error {
  constructor(message = "codex_cli_selection_busy") {
    super(message);
    this.name = "CodexCliSelectionMutationBusyError";
  }
}

let selectionGate: SharedArrayBuffer | null = null;

/** One process-wide holder and monotonic generation counter shared across realms. */
export function codexCliUpdateSelectionGate(): SharedArrayBuffer {
  selectionGate ??= new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  return selectionGate;
}

/** Test seam: drop the cell so each case starts from FREE on a fresh buffer. */
export function resetCodexCliSelectionGatesForTests(): void {
  selectionGate = null;
}

/** Per-job fence: decision, current child pgid (0 = unpublished), terminal proof. */
export function createCodexCliUpdateFence(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
}

/** The holder word IS the generation: one CAS releases exactly one owner. */
export function allocateCodexCliUpdateGateOwner(buffer: SharedArrayBuffer): number {
  const view = new Int32Array(buffer);
  for (;;) {
    const sequence = Atomics.load(view, 1);
    if (sequence >= 0x7ffffffd) throw new Error("cli_update_gate_generation_exhausted");
    if (Atomics.compareExchange(view, 1, sequence, sequence + 1) === sequence) {
      return sequence + CODEX_CLI_UPDATE_GATE_WORKER_COMMIT;
    }
  }
}
export function releaseCodexCliUpdateGateOwner(buffer: SharedArrayBuffer, owner: number): void {
  Atomics.compareExchange(new Int32Array(buffer), 0, owner, CODEX_CLI_UPDATE_GATE_FREE);
}

/** Parent cancel word. True only when this CAS took PREPARING -> CANCELLED. */
export function cancelCodexCliUpdateFence(fence: SharedArrayBuffer): boolean {
  return Atomics.compareExchange(new Int32Array(fence), 0,
    CODEX_CLI_UPDATE_FENCE_PREPARING, CODEX_CLI_UPDATE_FENCE_CANCELLED) === CODEX_CLI_UPDATE_FENCE_PREPARING;
}

/**
 * The worker-side cancellation checkpoint fed to apply's isCancelled hook.
 * COMMITTED is deliberately not "cancelled": once the commit CAS lands the
 * installer is a live child whose close must be observed, not a cancel.
 */
export function codexCliUpdateIsCancelled(fence: SharedArrayBuffer): () => boolean {
  const view = new Int32Array(fence);
  return () => Atomics.load(view, 0) === CODEX_CLI_UPDATE_FENCE_CANCELLED;
}

export interface CodexCliSelectionParentWrite {
  readonly entered: boolean;
  /** Idempotent release; safe to call from both branches of a spawn attempt. */
  exit(): void;
}

/**
 * Non-blocking acquisition for the parent selection writers and session-spawn
 * paths. entered === false means a commit window (or another writer) is in
 * flight and the caller must surface busy immediately, never wait.
 */
export function beginCodexCliSelectionParentWrite(): CodexCliSelectionParentWrite {
  if (codexCliUpdateRecoveryBlocksAdmission()) return Object.freeze({ entered: false, exit() {} });
  const view = new Int32Array(codexCliUpdateSelectionGate());
  if (Atomics.compareExchange(view, 0, CODEX_CLI_UPDATE_GATE_FREE, CODEX_CLI_UPDATE_GATE_PARENT_WRITE)
    !== CODEX_CLI_UPDATE_GATE_FREE) {
    return Object.freeze({ entered: false, exit() { /* nothing held */ } });
  }
  let held = true;
  return Object.freeze({
    entered: true,
    exit() {
      if (!held) return;
      held = false;
      Atomics.store(view, 0, CODEX_CLI_UPDATE_GATE_FREE);
    },
  });
}

/**
 * The worker's installation window. tryEnter covers the uncontended same-turn
 * case; waitEnter is the bounded retry for a held parent write. commit() is
 * the fence CAS issued in the same event-loop turn as the installer spawn;
 * exit() releases the gate after terminal installer evidence and readback.
 * Unknown installer/verifier lifetime intentionally leaves admission closed.
 */
export interface CodexCliUpdateCommitWindow {
  tryEnter(): boolean;
  waitEnter(): Promise<boolean>;
  commit(): boolean;
  childStarting?(): void;
  childStarted?(pid: number): void;
  exit(): void;
}

export function createWorkerCommitWindow(options: {
  readonly gate: SharedArrayBuffer;
  readonly fence: SharedArrayBuffer;
  readonly owner?: number;
  readonly recovery?: { arm(): void; child(pid: number): void; terminal(): void };
  readonly deadlineMs?: number;
  /** Test seam: observe/back-off without real sleeps. */
  readonly sleep?: (ms: number) => Promise<void>;
}): CodexCliUpdateCommitWindow {
  const gate = new Int32Array(options.gate);
  const fence = new Int32Array(options.fence);
  const owner = options.owner ?? allocateCodexCliUpdateGateOwner(options.gate);
  const deadlineMs = options.deadlineMs ?? WORKER_COMMIT_WAIT_DEADLINE_MS;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const cancelled = () => Atomics.load(fence, 0) === CODEX_CLI_UPDATE_FENCE_CANCELLED;
  let held = false;
  let cleanupRetry: ReturnType<typeof setInterval> | undefined;
  const release = () => {
    try { options.recovery?.terminal(); }
    catch { return false; }
    held = false;
    releaseCodexCliUpdateGateOwner(options.gate, owner);
    return true;
  };
  return Object.freeze({
    tryEnter() {
      if (cancelled()) return false;
      if (!held
        && Atomics.compareExchange(gate, 0, CODEX_CLI_UPDATE_GATE_FREE, owner)
          === CODEX_CLI_UPDATE_GATE_FREE) {
        held = true;
      }
      if (held && cancelled()) { held = false; releaseCodexCliUpdateGateOwner(options.gate, owner); }
      return held;
    },
    async waitEnter() {
      const deadline = Date.now() + deadlineMs;
      while (!held && !cancelled()) {
        if (Atomics.compareExchange(gate, 0, CODEX_CLI_UPDATE_GATE_FREE, owner)
          === CODEX_CLI_UPDATE_GATE_FREE) {
          held = true;
          if (cancelled()) { held = false; releaseCodexCliUpdateGateOwner(options.gate, owner); }
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(1);
      }
      return held;
    },
    commit() {
      if (!held || Atomics.load(gate, 0) !== owner || cancelled()) return false;
      options.recovery?.arm(); // durable uncertainty precedes any possible spawn
      return Atomics.compareExchange(fence, 0, CODEX_CLI_UPDATE_FENCE_PREPARING, CODEX_CLI_UPDATE_FENCE_COMMITTED)
        === CODEX_CLI_UPDATE_FENCE_PREPARING;
    },
    childStarting() {
      Atomics.store(fence, 1, 0);
      // Publish uncertainty BEFORE competing with parent recovery's seal.
      // A close notification may precede full thread exit; no next child can
      // start after the parent has sealed COMMITTED for recovery.
      if (Atomics.compareExchange(fence, 0, CODEX_CLI_UPDATE_FENCE_COMMITTED, CODEX_CLI_UPDATE_FENCE_COMMITTED)
        !== CODEX_CLI_UPDATE_FENCE_COMMITTED) throw new Error("cli_update_owner_recovering");
      options.recovery?.arm();
    },
    childStarted(pid: number) {
      // Publication follows spawn in the same turn. Death in the gap stays unknown.
      Atomics.store(fence, 1, pid);
      options.recovery?.child(pid);
    },
    exit() {
      if (!held) return;
      // Caller has proven no child remains. Publish that proof even if the
      // durable receipt temporarily cannot be written; parent close can retry.
      Atomics.store(fence, 2, 1);
      if (release() || cleanupRetry) return;
      cleanupRetry = setInterval(() => {
        if (release()) clearInterval(cleanupRetry);
      }, 250);
    },
  });
}
