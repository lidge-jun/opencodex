import { describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInboundBodyBudget,
  configureInboundBodyBudget,
  DEFAULT_CONCURRENT_INBOUND_BODY_BYTES,
  inboundBodyBudget,
  INBOUND_BODY_QUEUE_TIMEOUT_MS,
  MAX_CONCURRENT_INBOUND_BODY_BYTES,
  MAX_QUEUED_INBOUND_BODIES,
  type InboundBodyBudget,
  type InboundBodyLease,
} from "../../src/server/inbound-body-budget";

const freshSignal = () => new AbortController().signal;
/** Assert that every reservation, active owner, and queued waiter was released. */
function assertEmpty(budget: InboundBodyBudget) {
  assert.deepEqual(budget.snapshot(), { reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
}

describe("inbound body budget", () => {
  test("bounds the shared allowance, waiting uploads and wait duration", () => {
    expect(DEFAULT_CONCURRENT_INBOUND_BODY_BYTES).toBe(512 * 1024 * 1024);
    expect(MAX_CONCURRENT_INBOUND_BODY_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(MAX_QUEUED_INBOUND_BODIES).toBe(32);
    expect(INBOUND_BODY_QUEUE_TIMEOUT_MS).toBe(120_000);
  });

  test("explicit startup settings preserve the same shared owner and zero restores its default", async () => {
    const owner = inboundBodyBudget;
    const lease = await owner.acquire(1, freshSignal(), 0);
    assert.ok(lease);
    try {
      configureInboundBodyBudget(MAX_CONCURRENT_INBOUND_BODY_BYTES);
      assert.equal(inboundBodyBudget, owner);
      assert.equal(owner.capacity(), MAX_CONCURRENT_INBOUND_BODY_BYTES);
      configureInboundBodyBudget(0);
      assert.equal(owner.capacity(), DEFAULT_CONCURRENT_INBOUND_BODY_BYTES);
      assert.deepEqual(owner.snapshot(), { reservedBytes: 1, activeLeases: 1, queuedRequests: 0 });
    } finally { lease.release(); configureInboundBodyBudget(); }
  });

  test("raising capacity wakes FIFO waiters without erasing active charges", async () => {
    const budget = createInboundBodyBudget(100);
    const first = await budget.acquire(100, freshSignal());
    assert.ok(first);
    const pending = budget.acquire(80, freshSignal());
    budget.setCapacity(200);
    const second = await pending;
    assert.ok(second);
    try {
      assert.deepEqual(budget.snapshot(), { reservedBytes: 180, activeLeases: 2, queuedRequests: 0 });
    } finally { first.release(); second.release(); }
    assertEmpty(budget);
  });

  test("lowering capacity retains outstanding charges until the FIFO head fits", async () => {
    const budget = createInboundBodyBudget(100);
    const first = await budget.acquire(80, freshSignal());
    assert.ok(first);
    const pending = budget.acquire(60, freshSignal());
    let second: InboundBodyLease | null = null;
    try {
      budget.setCapacity(60);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 80, activeLeases: 1, queuedRequests: 1 });
      assert.equal(await budget.acquire(1, freshSignal(), 0), null);
      first.shrink(20);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 20, activeLeases: 1, queuedRequests: 1 });
      first.release();
      second = await pending;
      assert.ok(second);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 60, activeLeases: 1, queuedRequests: 0 });
    } finally { first.release(); (second ?? await pending)?.release(); }
    assertEmpty(budget);
  });

  test("invalid capacity changes preserve the current budget", () => {
    const budget = createInboundBodyBudget(100);
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => budget.setCapacity(invalid), RangeError);
      assert.equal(budget.capacity(), 100);
    }
    assertEmpty(budget);
  });

  for (const capacity of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    test(`rejects invalid capacity ${String(capacity)}`, () => {
      expect(() => createInboundBodyBudget(capacity)).toThrow(RangeError);
    });
  }
  for (const maxQueued of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    test(`rejects invalid queue size ${String(maxQueued)}`, () => {
      expect(() => createInboundBodyBudget(100, maxQueued)).toThrow(RangeError);
    });
  }

  test("rejects invalid reservations without changing counters", async () => {
    const budget = createInboundBodyBudget(100);
    for (const bytes of [0, -1, 0.5, NaN, Infinity, 101, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(budget.acquire(bytes, freshSignal())).rejects.toBeInstanceOf(RangeError);
      assertEmpty(budget);
    }
  });

  test("shrinking drains waiters and releasing a shrunken lease is idempotent", async () => {
    const budget = createInboundBodyBudget(100);
    const first = await budget.acquire(80, freshSignal());
    assert.ok(first);
    let second: InboundBodyLease | null = null;
    const abort = new AbortController();
    const pending = budget.acquire(80, abort.signal, 1000);
    try {
      assert.deepEqual(budget.snapshot(), { reservedBytes: 80, activeLeases: 1, queuedRequests: 1 });
      first.shrink(20);
      second = await pending;
      assert.ok(second);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 100, activeLeases: 2, queuedRequests: 0 });
      first.release();
      first.release();
      first.shrink(1);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 80, activeLeases: 1, queuedRequests: 0 });
      second.release();
      assertEmpty(budget);
    } finally {
      abort.abort();
      first.release();
      (second ?? await pending.catch(() => null))?.release();
    }
  });

  test("invalid measurements and attempted growth cannot alter a lease", async () => {
    const budget = createInboundBodyBudget(100);
    const lease = await budget.acquire(80, freshSignal());
    assert.ok(lease);
    try {
      for (const measured of [NaN, -1, Infinity, -Infinity, 81, 1000]) {
        lease.shrink(measured);
        assert.deepEqual(budget.snapshot(), { reservedBytes: 80, activeLeases: 1, queuedRequests: 0 });
      }
      lease.shrink(20);
      lease.shrink(79);
      assert.equal(budget.snapshot().reservedBytes, 20);
      lease.release();
      lease.release();
      lease.shrink(1);
      assertEmpty(budget);
    } finally { lease.release(); }
  });

  test("an eligible smaller arrival cannot bypass the FIFO head", async () => {
    const budget = createInboundBodyBudget(100);
    const holder = await budget.acquire(90, freshSignal());
    assert.ok(holder);
    const abort = new AbortController();
    const order: string[] = [];
    const large = budget.acquire(80, abort.signal, 1000).then(lease => { order.push("large"); return lease; });
    const small = budget.acquire(10, abort.signal, 1000).then(lease => { order.push("small"); return lease; });
    try {
      await Promise.resolve();
      assert.deepEqual(order, []);
      holder.shrink(60);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 60, activeLeases: 1, queuedRequests: 2 });
      await Promise.resolve();
      assert.deepEqual(order, []);
      holder.release();
      const leases = await Promise.all([large, small]);
      assert.ok(leases.every(Boolean));
      assert.deepEqual(order, ["large", "small"]);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 90, activeLeases: 2, queuedRequests: 0 });
    } finally {
      abort.abort();
      holder.release();
      for (const pending of [large, small]) (await pending.catch(() => null))?.release();
    }
    assertEmpty(budget);
  });

  for (const removal of ["abort", "timeout"] as const) {
    test(`removing a FIFO head by ${removal} drains an eligible follower`, async () => {
      const budget = createInboundBodyBudget(100);
      const holder = await budget.acquire(70, freshSignal());
      assert.ok(holder);
      const headAbort = new AbortController();
      const followerAbort = new AbortController();
      const reason = new Error("fixture queued upload aborted");
      const head = budget.acquire(80, headAbort.signal, removal === "timeout" ? 20 : 1000).catch(error => error);
      const follower = budget.acquire(30, followerAbort.signal, 1000);
      try {
        assert.equal(budget.snapshot().queuedRequests, 2);
        if (removal === "abort") headAbort.abort(reason);
        assert.equal(await head, removal === "abort" ? reason : null);
        const lease = await follower;
        assert.ok(lease);
        assert.deepEqual(budget.snapshot(), { reservedBytes: 100, activeLeases: 2, queuedRequests: 0 });
      } finally {
        headAbort.abort();
        followerAbort.abort();
        holder.release();
        (await follower.catch(() => null))?.release();
      }
      assertEmpty(budget);
    });
  }

  test("allows exactly 32 queued uploads and removes every aborted waiter", async () => {
    const budget = createInboundBodyBudget(100);
    const holder = await budget.acquire(100, freshSignal());
    assert.ok(holder);
    const controllers = Array.from({ length: MAX_QUEUED_INBOUND_BODIES }, () => new AbortController());
    const waiting = controllers.map(controller => budget.acquire(100, controller.signal).catch(error => error));
    const reason = new Error("fixture queue cleared");
    try {
      assert.deepEqual(budget.snapshot(), { reservedBytes: 100, activeLeases: 1, queuedRequests: 32 });
      assert.equal(await budget.acquire(1, freshSignal()), null);
      assert.equal(budget.snapshot().queuedRequests, 32);
      for (const controller of controllers) controller.abort(reason);
      assert.deepEqual(await Promise.all(waiting), Array(32).fill(reason));
      assert.deepEqual(budget.snapshot(), { reservedBytes: 100, activeLeases: 1, queuedRequests: 0 });
    } finally {
      for (const controller of controllers) controller.abort(reason);
      await Promise.all(waiting);
      holder.release();
    }
    assertEmpty(budget);
    (await budget.acquire(100, freshSignal(), 0))!.release();
    assertEmpty(budget);
  });

  test("a queue size of zero refuses busy arrivals without retaining them", async () => {
    const budget = createInboundBodyBudget(100, 0);
    const holder = await budget.acquire(100, freshSignal());
    assert.ok(holder);
    try {
      assert.equal(await budget.acquire(1, freshSignal()), null);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 100, activeLeases: 1, queuedRequests: 0 });
    } finally { holder.release(); }
    assertEmpty(budget);
  });

  test("zero wait time never leaves a queued request", async () => {
    const budget = createInboundBodyBudget(100);
    const holder = await budget.acquire(100, freshSignal());
    assert.ok(holder);
    try {
      assert.equal(await budget.acquire(1, freshSignal(), 0), null);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 100, activeLeases: 1, queuedRequests: 0 });
    } finally { holder.release(); }
    assertEmpty(budget);
  });

  test("a timed out waiter leaves the holder charged and permits a fresh acquisition", async () => {
    const budget = createInboundBodyBudget(100);
    const holder = await budget.acquire(100, freshSignal());
    assert.ok(holder);
    try {
      assert.equal(await budget.acquire(100, freshSignal(), 20), null);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 100, activeLeases: 1, queuedRequests: 0 });
    } finally { holder.release(); }
    (await budget.acquire(100, freshSignal(), 0))!.release();
    assertEmpty(budget);
  });

  test("pre-aborted acquisitions preserve their reason without owning capacity", async () => {
    const budget = createInboundBodyBudget(100);
    const abort = new AbortController();
    const reason = new Error("fixture already aborted");
    abort.abort(reason);
    await expect(budget.acquire(100, abort.signal)).rejects.toBe(reason);
    assertEmpty(budget);
  });

  test("a granted waiter loses its timer and abort cannot release its lease", async () => {
    const budget = createInboundBodyBudget(100);
    const holder = await budget.acquire(100, freshSignal());
    assert.ok(holder);
    const abort = new AbortController();
    const pending = budget.acquire(100, abort.signal, 20);
    holder.release();
    const admitted = await pending;
    assert.ok(admitted);
    try {
      abort.abort();
      await Bun.sleep(30);
      assert.deepEqual(budget.snapshot(), { reservedBytes: 100, activeLeases: 1, queuedRequests: 0 });
    } finally { admitted.release(); }
    assertEmpty(budget);
  });

  for (const waitMs of [undefined, 240_000]) {
    test(`wait ${String(waitMs)} schedules no more than the 120 second deadline`, async () => {
      const budget = createInboundBodyBudget(100);
      const holder = await budget.acquire(100, freshSignal());
      assert.ok(holder);
      const abort = new AbortController();
      const timer = spyOn(globalThis, "setTimeout");
      let pending: Promise<unknown> | undefined;
      try {
        pending = budget.acquire(100, abort.signal, waitMs).catch(error => error);
        expect(timer).toHaveBeenLastCalledWith(expect.any(Function), INBOUND_BODY_QUEUE_TIMEOUT_MS);
      } finally {
        timer.mockRestore();
        abort.abort();
        await pending;
        holder.release();
      }
      assertEmpty(budget);
    });
  }
});
