import { describe, expect, test } from "bun:test";
import { startHistoryMigrationGuardian } from "../src/codex/history-migration-guardian";

/**
 * Manual scheduler: collects scheduled callbacks so tests drive ticks
 * deterministically.
 *
 * `runNext` awaits the callback, because a tick now runs its migration through
 * the history job and is therefore async. Dropping that promise would let a test
 * assert on state the tick had not finished producing.
 */
function manualScheduler() {
  const queue: Array<() => void | Promise<void>> = [];
  return {
    scheduleFn: (fn: () => void | Promise<void>) => {
      queue.push(fn);
      return { cancel: () => { const i = queue.indexOf(fn); if (i !== -1) queue.splice(i, 1); } };
    },
    async runNext(): Promise<boolean> {
      const fn = queue.shift();
      if (!fn) return false;
      await fn();
      return true;
    },
    get size() { return queue.length; },
  };
}

const silent = { log: () => {} };

describe("history migration guardian", () => {
  test("stops silently on a worker-verified no-op", async () => {
    const sched = manualScheduler();
    let migrations = 0;
    startHistoryMigrationGuardian({
      migrateFn: () => { migrations++; return { rows: 0, files: 0, verifiedNoop: true }; },
      log: silent,
      scheduleFn: sched.scheduleFn,
    });

    expect(await sched.runNext()).toBe(true);
    expect(migrations).toBe(1); // the locked worker owns no-op authority
    expect(sched.size).toBe(0); // and never reschedules
  });

  test("retries while the DB stays locked, then logs and stops on success", async () => {
    const sched = manualScheduler();
    const logs: string[] = [];
    let attempts = 0;
    startHistoryMigrationGuardian({
      migrateFn: () => {
        attempts++;
        return attempts < 3
          ? { rows: 0, files: 0, failed: true as const }
          : { rows: 2, files: 2, ejectedRows: 1 };
      },
      log: { log: (msg: string) => logs.push(msg) },
      scheduleFn: sched.scheduleFn,
    });

    expect(await sched.runNext()).toBe(true); // tick 1: locked
    expect(await sched.runNext()).toBe(true); // tick 2: locked
    expect(await sched.runNext()).toBe(true); // tick 3: success
    expect(attempts).toBe(3);
    expect(logs.some(l => l.includes("3 legacy opencodex thread(s) migrated"))).toBe(true);
    expect(sched.size).toBe(0); // stopped after success
  });

  test("gives up with a warning after maxTicks", async () => {
    const sched = manualScheduler();
    const logs: string[] = [];
    startHistoryMigrationGuardian({
      migrateFn: () => ({ rows: 0, files: 0, failed: true as const }),
      log: { log: (msg: string) => logs.push(msg) },
      scheduleFn: sched.scheduleFn,
      maxTicks: 2,
    });

    expect(await sched.runNext()).toBe(true);
    expect(await sched.runNext()).toBe(true);
    expect(sched.size).toBe(0); // budget exhausted — no reschedule
    expect(logs.some(l => l.includes("Could not verify"))).toBe(true);
    expect(logs.some(l => l.includes("stayed locked"))).toBe(false);
  });

  test("stop() cancels the pending tick", async () => {
    const sched = manualScheduler();
    let migrations = 0;
    const handle = startHistoryMigrationGuardian({
      migrateFn: () => { migrations++; return { rows: 0, files: 0, failed: true as const }; },
      log: silent,
      scheduleFn: sched.scheduleFn,
    });

    handle.stop();
    expect(await sched.runNext()).toBe(false); // cancelled before firing
    expect(migrations).toBe(0);
  });

  test("stops on a worker-verified no-op without a pre-lock probe", async () => {
    const sched = manualScheduler();
    let migrations = 0;
    startHistoryMigrationGuardian({
      migrateFn: () => { migrations++; return { rows: 0, files: 0, verifiedNoop: true }; },
      log: silent,
      scheduleFn: sched.scheduleFn,
    });

    expect(await sched.runNext()).toBe(true);
    expect(migrations).toBe(1);
    expect(sched.size).toBe(0); // worker proof, not the advisory count, stops it
  });

  test("an unverified zero-row result cannot turn into success", async () => {
    const sched = manualScheduler();
    let attempts = 0;
    startHistoryMigrationGuardian({
      migrateFn: () => {
        attempts++;
        return attempts === 1
          ? { rows: 0, files: 0, verifiedNoop: false }
          : { rows: 0, files: 0, verifiedNoop: true };
      },
      log: silent,
      scheduleFn: sched.scheduleFn,
    });
    expect(await sched.runNext()).toBe(true);
    expect(attempts).toBe(1);
    expect(sched.size).toBe(1);
    expect(await sched.runNext()).toBe(true);
    expect(attempts).toBe(2);
    expect(sched.size).toBe(0);
  });

  test("does not stop on a zero-row 'success' while backup entries remain (missing-DB race)", async () => {
    const sched = manualScheduler();
    let migrations = 0;
    const logs: string[] = [];
    // DB missing: the locked migration returns zero rows without a proof.
    startHistoryMigrationGuardian({
      migrateFn: () => { migrations++; return { rows: 0, files: 0 }; },
      log: { log: (msg: string) => logs.push(msg) },
      scheduleFn: sched.scheduleFn,
      maxTicks: 3,
    });

    expect(await sched.runNext()).toBe(true);
    expect(migrations).toBe(1);
    expect(sched.size).toBe(1); // NOT stopped — backup work is still pending
    expect(await sched.runNext()).toBe(true);
    expect(await sched.runNext()).toBe(true); // budget exhausted on tick 3
    expect(sched.size).toBe(0);
    expect(logs.some(l => l.includes("Could not verify"))).toBe(true);
    expect(logs.some(l => l.includes("stayed locked"))).toBe(false);
  });
});
