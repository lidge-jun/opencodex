import { expect, spyOn, test } from "bun:test";
import { idleDeadline } from "../../src/lib/abort";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("idleDeadline fires once after the idle window with no reset", async () => {
  let fired = 0;
  const idle = idleDeadline(30, () => { fired += 1; });
  idle.reset();
  await sleep(120);
  expect(fired).toBe(1);
  // idempotent after fire: reset/cancel are no-ops, never fires again
  idle.reset();
  await sleep(80);
  expect(fired).toBe(1);
  idle.cancel();
  expect(fired).toBe(1);
});

test("idleDeadline reset() re-arms and postpones firing", () => {
  // Keep this boundary check synchronous: real sleeps can resume after the idle window.
  // The other cases below still exercise Bun's real timers.
  type TimerHandle = ReturnType<typeof setTimeout>;
  let now = 0;
  let nextHandle = 0;
  const timers = new Map<TimerHandle, { at: number; fire: () => void }>();
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]
  ) => {
    const handle = ++nextHandle as unknown as TimerHandle;
    timers.set(handle, { at: now + delay, fire: () => callback(...args) });
    return handle;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(handle => {
    timers.delete(handle as TimerHandle);
  });
  const advanceBy = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fire();
    }
    now = target;
  };
  let fired = 0;
  let idle: ReturnType<typeof idleDeadline> | undefined;
  try {
    idle = idleDeadline(120, () => { fired += 1; });
    idle.reset();
    for (let i = 0; i < 4; i++) {
      advanceBy(40);
      idle.reset(); // total elapsed exceeds 120 ms, but each silent interval does not
    }
    expect(fired).toBe(0);
    advanceBy(119);
    expect(fired).toBe(0);
    advanceBy(1);
    expect(fired).toBe(1);
    advanceBy(240);
    expect(fired).toBe(1);
  } finally {
    try {
      idle?.cancel();
    } finally {
      clearSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  }
});

test("idleDeadline pause() disarms without retiring; reset() re-arms after pause", async () => {
  let fired = 0;
  const idle = idleDeadline(30, () => { fired += 1; });
  idle.reset();
  idle.pause();
  await sleep(100);
  expect(fired).toBe(0); // paused: no pending window
  idle.reset();
  await sleep(100);
  expect(fired).toBe(1); // re-armed after pause still works
});

test("idleDeadline cancel() is permanent", async () => {
  let fired = 0;
  const idle = idleDeadline(20, () => { fired += 1; });
  idle.reset();
  idle.cancel();
  idle.reset(); // no-op after cancel
  await sleep(80);
  expect(fired).toBe(0);
});

test("idleDeadline with idleMs <= 0 is inert (0-disable lives in the primitive)", async () => {
  let fired = 0;
  const zero = idleDeadline(0, () => { fired += 1; });
  zero.reset();
  const negative = idleDeadline(-5, () => { fired += 1; });
  negative.reset();
  await sleep(60);
  expect(fired).toBe(0);
  zero.cancel();
  negative.cancel();
});

test("idleDeadline starts disarmed: constructing without reset never fires", async () => {
  let fired = 0;
  idleDeadline(15, () => { fired += 1; });
  await sleep(60);
  expect(fired).toBe(0);
});
