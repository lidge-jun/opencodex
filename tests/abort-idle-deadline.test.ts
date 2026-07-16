import { expect, test } from "bun:test";
import { idleDeadline } from "../src/lib/abort";

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

test("idleDeadline reset() re-arms and postpones firing", async () => {
  let fired = 0;
  const idle = idleDeadline(120, () => { fired += 1; });
  idle.reset();
  for (let i = 0; i < 4; i++) {
    await sleep(40);
    idle.reset(); // keep-alive: total elapsed (160ms) exceeds 120ms but silence never does
  }
  expect(fired).toBe(0);
  await sleep(220);
  expect(fired).toBe(1);
  idle.cancel();
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
