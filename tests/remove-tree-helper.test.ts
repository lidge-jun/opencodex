import { describe, expect, test } from "bun:test";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
    expect(sleeps).toEqual([50, 50]);
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
    expect(removeCalls).toBe(50);
    expect(sleeps).toBe(49);
  });
});
