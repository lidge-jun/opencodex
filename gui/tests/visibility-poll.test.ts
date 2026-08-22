import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { startVisibilityPoll } from "../src/visibility-poll";

function test(name: string, fn: () => void | Promise<void>): void {
  bunTest(name, fn, { timeout: 15_000 });
}

const globals = ["document", "window", "navigator"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/** Same driver as client-resource-poll.test.tsx: happy-dom derives visibilityState. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(testWindow.document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ticks on cadence while visible", async () => {
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 40);
  await sleep(150);
  stop();
  expect(calls).toBeGreaterThanOrEqual(2);
});

test("hidden holds no timer and fires nothing", async () => {
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 30);
  await sleep(75);
  const beforeHide = calls;
  expect(beforeHide).toBeGreaterThanOrEqual(1);
  setVisibility("hidden");
  await sleep(160); // >5 intervals: zero calls without the suspension
  expect(calls).toBe(beforeHide);
  stop();
});

test("visible-again fires exactly one make-up tick, then resumes the cadence", async () => {
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 40);
  await sleep(50);
  setVisibility("hidden");
  await sleep(60);
  const atHidden = calls;
  setVisibility("visible");
  await sleep(10);
  expect(calls).toBe(atHidden + 1); // the make-up tick
  await sleep(90);
  expect(calls).toBeGreaterThanOrEqual(atHidden + 2); // cadence resumed
  stop();
});

test("pauseWhenHidden:false keeps ticking while hidden", async () => {
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 30, { pauseWhenHidden: false });
  await sleep(40);
  setVisibility("hidden");
  const atHidden = calls;
  await sleep(100);
  expect(calls).toBeGreaterThan(atHidden);
  stop();
});

test("stop() while hidden leaves no zombie wakeup", async () => {
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 30);
  await sleep(40);
  setVisibility("hidden");
  stop();
  const atStop = calls;
  setVisibility("visible");
  await sleep(100);
  expect(calls).toBe(atStop);
});

test("mounted while already hidden: no timer, but the listener still resumes it", async () => {
  setVisibility("hidden");
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 30);
  await sleep(100);
  expect(calls).toBe(0);
  setVisibility("visible");
  await sleep(10);
  expect(calls).toBe(1); // make-up tick proves the listener was installed
  stop();
});
