/**
 * Lifecycle integrity checks for the derived history index (#7966).
 *
 * SQLite's quick_check is synchronous even behind a timer. A disposable
 * worker performs it at first use and, while the index is in use, periodically.
 * A verified handle remains readable during later checks. No idle timer or
 * serving-thread scan is needed, and operational failures only delay retry.
 */

import { RebuildWorkerJob } from "./rebuild-job";

export const REQUEST_HISTORY_INTEGRITY_INTERVAL_MS = 5 * 60_000;
export const REQUEST_HISTORY_INTEGRITY_FAILURE_COOLDOWN_MS = 30_000;

type IntegrityJob = Pick<RebuildWorkerJob, "check" | "dispose" | "afterExit">;

export interface RequestHistoryIntegrityOptions {
  createJob?: () => IntegrityJob;
  now?: () => number;
  intervalMs?: number;
  failureCooldownMs?: number;
}

export type RequestHistoryIntegrityState =
  | { state: "ready" }
  | { state: "corrupt" }
  | { state: "unavailable"; error: unknown }
  // Never rejects, including on cancellation or check failure. Completion
  // proves the scanner exited; inspect again to obtain its verdict or error.
  | { state: "pending"; promise: Promise<void> };

interface Generation {
  handle: object;
  path: string;
  verified: boolean;
  corrupt: boolean;
  nextCheckAt: number;
  failure: { error: unknown } | null;
}

interface ActiveCheck {
  generation: Generation;
  cancelled: boolean;
  cancel: () => void;
  promise: Promise<void>;
}

type CheckOutcome =
  | { kind: "checked"; healthy: boolean }
  | { kind: "failed"; error: unknown }
  | { kind: "cancelled" };

export class RequestHistoryIntegrityMonitor {
  private readonly createJob: () => IntegrityJob;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly failureCooldownMs: number;
  private current: Generation | null = null;
  private active: ActiveCheck | null = null;

  constructor(options: RequestHistoryIntegrityOptions = {}) {
    this.createJob = options.createJob ?? (() => new RebuildWorkerJob());
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? REQUEST_HISTORY_INTEGRITY_INTERVAL_MS;
    this.failureCooldownMs = options.failureCooldownMs ?? REQUEST_HISTORY_INTEGRITY_FAILURE_COOLDOWN_MS;
  }

  inspect(handle: object, path: string): RequestHistoryIntegrityState {
    if (this.current?.handle !== handle || this.current.path !== path) {
      this.quiesce();
      this.current = { handle, path, verified: false, corrupt: false, nextCheckAt: -Infinity, failure: null };
    }
    const generation = this.current;
    if (generation.corrupt) return { state: "corrupt" };
    if (this.active) {
      if (this.active.generation === generation && !this.active.cancelled && generation.verified) {
        return { state: "ready" };
      }
      return { state: "pending", promise: this.active.promise };
    }
    if (this.now() >= generation.nextCheckAt) {
      const check = this.start(generation);
      if (check && !generation.verified) return { state: "pending", promise: check.promise };
    }
    if (generation.verified) return { state: "ready" };
    return { state: "unavailable", error: generation.failure?.error ?? new Error("history integrity check unavailable") };
  }

  /** A statement detected corruption; an in-flight healthy verdict cannot erase it. */
  markCorrupt(handle: object): void {
    if (this.current?.handle === handle) this.current.corrupt = true;
  }

  /**
   * Accept a newly reconstructed projection after successful inline ingest or
   * validation of a private worker build. Existing persisted databases must
   * use inspect instead. The caller drains scans before rebuilding/swapping.
   */
  acceptRebuilt(handle: object, path: string): void {
    if (this.active) throw new Error("history integrity worker must exit before accepting a rebuilt index");
    this.current = {
      handle, path, verified: true, corrupt: false,
      nextCheckAt: this.now() + this.intervalMs, failure: null,
    };
  }

  /**
   * Invalidate and stop the current check. Null means the index can be replaced
   * now; otherwise await the returned barrier before deleting or renaming it.
   * The barrier survives reset/reopen and resolves only after actual worker
   * exit, including Windows' OS-thread settling, not the bounded disposal wait.
   */
  quiesce(): Promise<void> | null {
    this.current = null;
    this.active?.cancel();
    return this.active?.promise ?? null;
  }

  reset(): void {
    this.quiesce();
  }

  private start(generation: Generation): ActiveCheck | null {
    let job: IntegrityJob;
    try {
      job = this.createJob();
    } catch (error) {
      this.recordFailure(generation, error);
      return null;
    }
    let cancel!: () => void;
    const cancelled = new Promise<CheckOutcome>(resolve => { cancel = () => resolve({ kind: "cancelled" }); });
    const check: ActiveCheck = {
      generation,
      cancelled: false,
      cancel: () => { check.cancelled = true; cancel(); },
      promise: Promise.resolve(),
    };
    this.active = check;
    check.promise = this.run(check, job, cancelled);
    return check;
  }

  private recordFailure(generation: Generation, error: unknown): void {
    generation.failure = { error: error ?? new Error("history integrity check failed") };
    generation.nextCheckAt = this.now() + this.failureCooldownMs;
  }

  private async run(check: ActiveCheck, job: IntegrityJob, cancelled: Promise<CheckOutcome>): Promise<void> {
    const observed = Promise.resolve().then(async (): Promise<CheckOutcome> => {
      if (check.cancelled) return { kind: "cancelled" };
      try {
        return { kind: "checked", healthy: await job.check(check.generation.path) };
      } catch (error) {
        return { kind: "failed", error };
      }
    });
    const outcome = await Promise.race([observed, cancelled]);
    await new Promise<void>(resolve => {
      // afterExit may return at its disposal timeout, before native I/O lets
      // the worker exit. Only its callback releases the file replacement gate.
      void job.afterExit(resolve).catch(() => undefined);
    });
    const generation = check.generation;
    if (this.current === generation && !check.cancelled && !generation.corrupt) {
      if (outcome.kind === "checked") {
        generation.verified = outcome.healthy;
        generation.corrupt = !outcome.healthy;
        generation.failure = null;
        generation.nextCheckAt = this.now() + this.intervalMs;
      } else if (outcome.kind === "failed") {
        this.recordFailure(generation, outcome.error);
      }
    }
    if (this.active === check) this.active = null;
  }
}
