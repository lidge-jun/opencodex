import { describe, expect, test } from "bun:test";
import {
  REMOVE_RETRY_BUDGET_MS,
  REMOVE_RETRY_MAX_DELAY_MS,
  removeRetrySchedule,
} from "../../scripts/test-temp";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function codedError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("removeTreeWithRetry", () => {
  test.each(["EPERM", "EBUSY", "ENOTEMPTY"])("retries transient %s failures", code => {
    let removeCalls = 0;
    const sleeps: number[] = [];

    removeTreeWithRetry("ignored", {
      remove: () => {
        removeCalls += 1;
        if (removeCalls < 3) throw codedError(code);
      },
      sleep: milliseconds => sleeps.push(milliseconds),
    });

    expect(removeCalls).toBe(3);
    expect(sleeps).toEqual([50, 100]);
  });

  test("a removal that succeeds immediately never waits", () => {
    const sleeps: number[] = [];

    removeTreeWithRetry("ignored", {
      remove: () => undefined,
      sleep: milliseconds => sleeps.push(milliseconds),
    });

    expect(sleeps).toEqual([]);
  });

  test("rethrows non-transient failures immediately", () => {
    const error = codedError("EACCES", "denied");
    let sleeps = 0;

    expect(() => removeTreeWithRetry("ignored", {
      remove: () => { throw error; },
      sleep: () => { sleeps += 1; },
    })).toThrow(error);
    expect(sleeps).toBe(0);
  });

  test("rethrows the final transient failure without an extra sleep", () => {
    const error = codedError("EBUSY", "still locked");
    let removeCalls = 0;
    let sleeps = 0;

    expect(() => removeTreeWithRetry("ignored", {
      remove: () => {
        removeCalls += 1;
        throw error;
      },
      sleep: () => { sleeps += 1; },
    })).toThrow(error);
    expect(removeCalls).toBe(removeRetrySchedule().length + 1);
    expect(sleeps).toBe(removeRetrySchedule().length);
  });
});

describe("removeRetrySchedule", () => {
  // The flat 50 x 50ms predecessor gave the documented icacls release race 2.5 seconds, and six
  // concurrent Windows shards exceeded it (#4789). These bounds are the contract: grow the wait,
  // cap it so no single gap is long, and spend the budget without overrunning it.
  test("backs off to a cap and outlasts the flat 2.5 second predecessor", () => {
    const schedule = removeRetrySchedule();
    const total = schedule.reduce((sum, delay) => sum + delay, 0);

    expect(schedule.slice(0, 3)).toEqual([50, 100, 200]);
    expect(Math.max(...schedule)).toBe(REMOVE_RETRY_MAX_DELAY_MS);
    expect(total).toBeGreaterThan(2_500);
    expect(total).toBeLessThanOrEqual(REMOVE_RETRY_BUDGET_MS);
    expect(total + REMOVE_RETRY_MAX_DELAY_MS).toBeGreaterThan(REMOVE_RETRY_BUDGET_MS);
  });

  test("a budget too small for one wait yields a single attempt", () => {
    expect(removeRetrySchedule(10)).toEqual([]);
  });
});
