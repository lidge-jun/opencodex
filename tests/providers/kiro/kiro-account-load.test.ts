import { expect, test } from "bun:test";
import { acquireAccountLease, accountInFlight, KIRO_LEASE_MAX_MS } from "../../../src/oauth/kiro-account-load";

test("lease counts are process local and release is idempotent", async () => {
  const a = await acquireAccountLease("kiro", "load-idempotent");
  const b = await acquireAccountLease("kiro", "load-idempotent");
  expect(accountInFlight("kiro", "load-idempotent")).toBe(2);
  a!.release(); a!.release(); b!.release();
  expect(accountInFlight("kiro", "load-idempotent")).toBe(0);
});

test("a cap admits one, wakes one waiter, and never exceeds the limit", async () => {
  const first = await acquireAccountLease("kiro", "load-wake", { maxConcurrentPerAccount: 1 });
  const pending = acquireAccountLease("kiro", "load-wake", { maxConcurrentPerAccount: 1, waitMs: 100 });
  expect(accountInFlight("kiro", "load-wake")).toBe(1);
  first!.release();
  const second = await pending;
  expect(second).not.toBeNull();
  expect(accountInFlight("kiro", "load-wake")).toBe(1);
  second!.release();
  expect(accountInFlight("kiro", "load-wake")).toBe(0);
});

test("bounded wait returns null and removes its waiter", async () => {
  const first = await acquireAccountLease("kiro", "load-deadline", { maxConcurrentPerAccount: 1 });
  expect(await acquireAccountLease("kiro", "load-deadline", { maxConcurrentPerAccount: 1, waitMs: 5 })).toBeNull();
  first!.release();
  expect(accountInFlight("kiro", "load-deadline")).toBe(0);
});

test("aborted wait returns null without a reservation", async () => {
  const controller = new AbortController();
  const first = await acquireAccountLease("kiro", "load-abort", { maxConcurrentPerAccount: 1 });
  const pending = acquireAccountLease("kiro", "load-abort", { maxConcurrentPerAccount: 1, waitMs: 100, signal: controller.signal });
  controller.abort();
  expect(await pending).toBeNull();
  first!.release();
  expect(accountInFlight("kiro", "load-abort")).toBe(0);
});

test("a released slot wakes the first live waiter", async () => {
  const first = await acquireAccountLease("kiro", "load-fifo", { maxConcurrentPerAccount: 1 });
  const timedOut = acquireAccountLease("kiro", "load-fifo", { maxConcurrentPerAccount: 1, waitMs: 5 });
  const live = acquireAccountLease("kiro", "load-fifo", { maxConcurrentPerAccount: 1, waitMs: 100 });
  expect(await timedOut).toBeNull();
  first!.release();
  const next = await live;
  expect(next).not.toBeNull();
  expect(accountInFlight("kiro", "load-fifo")).toBe(1);
  next!.release();
});

test("a lease past its TTL is reclaimed", async () => {
  const before = Date.now;
  const start = before();
  Date.now = () => start;
  try {
    const stale = await acquireAccountLease("kiro", "load-ttl", { maxConcurrentPerAccount: 1 });
    Date.now = () => start + KIRO_LEASE_MAX_MS + 1;
    expect(accountInFlight("kiro", "load-ttl")).toBe(0);
    const fresh = await acquireAccountLease("kiro", "load-ttl", { maxConcurrentPerAccount: 1 });
    expect(fresh).not.toBeNull();
    stale!.release();
    expect(accountInFlight("kiro", "load-ttl")).toBe(1);
    fresh!.release();
    expect(accountInFlight("kiro", "load-ttl")).toBe(0);
  } finally { Date.now = before; }
});

test("a reclaimed lease's late release does not double-decrement", async () => {
  const before = Date.now;
  const start = before();
  Date.now = () => start;
  try {
    const stale = await acquireAccountLease("kiro", "load-late", { maxConcurrentPerAccount: 1 });
    Date.now = () => start + KIRO_LEASE_MAX_MS + 1;
    const fresh = await acquireAccountLease("kiro", "load-late", { maxConcurrentPerAccount: 1 });
    stale!.release(); stale!.release();
    expect(accountInFlight("kiro", "load-late")).toBe(1);
    fresh!.release();
  } finally { Date.now = before; }
});
