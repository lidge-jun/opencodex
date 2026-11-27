import { expect, test } from "bun:test";
import { ConfigMutationLockError } from "../../src/config";
import { retryClientRollback, retryableClientRollbackLock } from "../../src/client/runtime-rollback";

test("rollback retries only known lifecycle or configuration contention", () => {
  expect(retryableClientRollbackLock({ code: "client_lifecycle_busy" })).toBe(true);
  for (const code of ["SQLITE_BUSY", "SQLITE_LOCKED"]) {
    expect(retryableClientRollbackLock(new ConfigMutationLockError("busy", { cause: { code } }))).toBe(true);
  }
  for (const error of [undefined, new Error("busy"), { code: "SQLITE_BUSY" }, { code: "client_lifecycle_lock_failed" },
    new ConfigMutationLockError("unavailable", { cause: { code: "SQLITE_CORRUPT" } })]) {
    expect(retryableClientRollbackLock(error)).toBe(false);
  }
});

test("rollback closes each busy attempt before yielding and keeps one remaining budget", async () => {
  let clock = 0, calls = 0, listener = false;
  const remaining: number[] = [];
  expect(await retryClientRollback(async budget => {
    remaining.push(budget); calls++; listener = true; clock += 10;
    if (calls === 3) return "published";
    listener = false; return "busy";
  }, { budgetMs: 200, now: () => clock, sleep: async ms => {
    expect(listener).toBe(false); clock += ms;
  } })).toBe(true);
  expect(remaining).toEqual([200, 140, 80]);
  expect(listener).toBe(true);
});

test("rollback contention exhaustion never extends its budget", async () => {
  let clock = 0, calls = 0;
  expect(await retryClientRollback(async () => { calls++; clock += 20; return "busy"; }, {
    budgetMs: 100, now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(false);
  expect({ clock, calls }).toEqual({ clock: 100, calls: 2 });
});

test("a changed owner or non-contention refusal stops rollback retries immediately", async () => {
  let clock = 0, calls = 0;
  expect(await retryClientRollback(async () => ++calls === 1 ? "busy" : "refused", {
    now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(false);
  expect(calls).toBe(2);
});
