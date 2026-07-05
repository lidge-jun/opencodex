import { describe, expect, test } from "bun:test";
import { startHistoryMigrationGuardian } from "../src/history-migration-guardian";

/** Manual scheduler: collects scheduled callbacks so tests drive ticks deterministically. */
function manualScheduler() {
  const queue: Array<() => void> = [];
  return {
    scheduleFn: (fn: () => void) => {
      queue.push(fn);
      return { cancel: () => { const i = queue.indexOf(fn); if (i !== -1) queue.splice(i, 1); } };
    },
    runNext(): boolean {
      const fn = queue.shift();
      if (!fn) return false;
      fn();
      return true;
    },
    get size() { return queue.length; },
  };
}

const silent = { log: () => {} };

describe("history migration guardian", () => {
  test("stops silently when nothing is pending", () => {
    const sched = manualScheduler();
    let migrations = 0;
    startHistoryMigrationGuardian({
      countFn: () => ({ pendingRows: 0, backupEntries: 0 }),
      migrateFn: () => { migrations++; return { rows: 0, files: 0 }; },
      log: silent,
      scheduleFn: sched.scheduleFn,
    });

    expect(sched.runNext()).toBe(true);
    expect(migrations).toBe(0); // no pending work — never touches the migrate path
    expect(sched.size).toBe(0); // and never reschedules
  });

  test("retries while the DB stays locked, then logs and stops on success", () => {
    const sched = manualScheduler();
    const logs: string[] = [];
    let attempts = 0;
    startHistoryMigrationGuardian({
      countFn: () => ({ pendingRows: 3, backupEntries: 1 }),
      migrateFn: () => {
        attempts++;
        return attempts < 3
          ? { rows: 0, files: 0, failed: true as const }
          : { rows: 2, files: 2, ejectedRows: 1 };
      },
      log: { log: (msg: string) => logs.push(msg) },
      scheduleFn: sched.scheduleFn,
    });

    expect(sched.runNext()).toBe(true); // tick 1: locked
    expect(sched.runNext()).toBe(true); // tick 2: locked
    expect(sched.runNext()).toBe(true); // tick 3: success
    expect(attempts).toBe(3);
    expect(logs.some(l => l.includes("3 legacy opencodex thread(s) migrated"))).toBe(true);
    expect(sched.size).toBe(0); // stopped after success
  });

  test("gives up with a warning after maxTicks", () => {
    const sched = manualScheduler();
    const logs: string[] = [];
    startHistoryMigrationGuardian({
      countFn: () => ({ pendingRows: 1, backupEntries: 0 }),
      migrateFn: () => ({ rows: 0, files: 0, failed: true as const }),
      log: { log: (msg: string) => logs.push(msg) },
      scheduleFn: sched.scheduleFn,
      maxTicks: 2,
    });

    expect(sched.runNext()).toBe(true);
    expect(sched.runNext()).toBe(true);
    expect(sched.size).toBe(0); // budget exhausted — no reschedule
    expect(logs.some(l => l.includes("stayed locked"))).toBe(true);
  });

  test("stop() cancels the pending tick", () => {
    const sched = manualScheduler();
    let migrations = 0;
    const handle = startHistoryMigrationGuardian({
      countFn: () => ({ pendingRows: 1, backupEntries: 0 }),
      migrateFn: () => { migrations++; return { rows: 0, files: 0, failed: true as const }; },
      log: silent,
      scheduleFn: sched.scheduleFn,
    });

    handle.stop();
    expect(sched.runNext()).toBe(false); // cancelled before firing
    expect(migrations).toBe(0);
  });

  test("a locked count probe still attempts migration (count unknown != count zero)", () => {
    const sched = manualScheduler();
    let migrations = 0;
    startHistoryMigrationGuardian({
      countFn: () => ({ pendingRows: 0, backupEntries: 0, failed: true as const }),
      migrateFn: () => { migrations++; return { rows: 0, files: 0 }; },
      log: silent,
      scheduleFn: sched.scheduleFn,
    });

    expect(sched.runNext()).toBe(true);
    expect(migrations).toBe(1);
    expect(sched.size).toBe(0); // migration succeeded → stop
  });
});
