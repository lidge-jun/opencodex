import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  clearClientResourceStoresForTests,
  hasPollTimerForTests,
  pollBucketCountForTests,
  useClientResource,
} from "../src/client-resource";

function test(name: string, fn: () => void | Promise<void>): void {
  bunTest(name, fn, { timeout: 30_000 });
}

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }
}

async function setVisibility(state: "visible" | "hidden"): Promise<void> {
  Object.defineProperty(testWindow.document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  await act(async () => {
    testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange"));
    await Promise.resolve();
  });
}

test("stores sharing an interval share ONE timer bucket", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const stamp = Date.now();
  const fetches: Record<string, number> = { a: 0, b: 0, c: 0 };

  function Page() {
    useClientResource(`sched-a-${stamp}`, async () => { fetches.a += 1; return "a"; }, { pollMs: 30 });
    useClientResource(`sched-b-${stamp}`, async () => { fetches.b += 1; return "b"; }, { pollMs: 30 });
    useClientResource(`sched-c-${stamp}`, async () => { fetches.c += 1; return "c"; }, { pollMs: 30 });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  await waitFor(() => fetches.a >= 1 && fetches.b >= 1 && fetches.c >= 1);

  // Three polling stores, one interval → exactly one bucket (and one timer).
  expect(pollBucketCountForTests()).toBe(1);
  // Every member still ticks on that shared timer.
  const at = { ...fetches };
  await waitFor(() => fetches.a > at.a && fetches.b > at.b && fetches.c > at.c);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("an interval change moves the store between buckets and empty buckets are deleted", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `sched-move-${Date.now()}`;
  let fetches = 0;

  function Page({ pollMs }: { pollMs: number }) {
    useClientResource(KEY, async () => { fetches += 1; return "v"; }, { pollMs });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page pollMs={30} />);
  });
  await waitFor(() => fetches >= 1);
  expect(pollBucketCountForTests()).toBe(1);

  await act(async () => { root.render(<Page pollMs={60} />); });
  // The 30ms bucket is now empty and must be gone, not merely stopped.
  expect(pollBucketCountForTests()).toBe(1);
  expect(hasPollTimerForTests(KEY)).toBe(true);

  await act(async () => { root.unmount(); });
  await waitFor(() => pollBucketCountForTests() === 0);
  container.remove();
});

test("hidden drops the shared timer; visible re-arms it and makes up per store", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const stamp = Date.now();
  const KEY_A = `sched-hide-a-${stamp}`;
  const KEY_B = `sched-hide-b-${stamp}`;
  const fetches: Record<string, number> = { a: 0, b: 0 };

  function Page() {
    useClientResource(KEY_A, async () => { fetches.a += 1; return "a"; }, { pollMs: 30 });
    useClientResource(KEY_B, async () => { fetches.b += 1; return "b"; }, { pollMs: 30 });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  await waitFor(() => fetches.a >= 1 && fetches.b >= 1);
  expect(hasPollTimerForTests(KEY_A)).toBe(true);

  await setVisibility("hidden");
  expect(hasPollTimerForTests(KEY_A)).toBe(false);
  expect(hasPollTimerForTests(KEY_B)).toBe(false);
  const atHide = { ...fetches };
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 120));
  });
  expect(fetches.a).toBe(atHide.a);
  expect(fetches.b).toBe(atHide.b);

  await setVisibility("visible");
  await waitFor(() => hasPollTimerForTests(KEY_A));
  await waitFor(() => fetches.a > atHide.a && fetches.b > atHide.b);

  await act(async () => { root.unmount(); });
  container.remove();
  await setVisibility("visible");
});

test("an opt-out member keeps its bucket alive while hidden, and only it runs", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const stamp = Date.now();
  const KEY_PAUSED = `sched-mixed-paused-${stamp}`;
  const KEY_OPTOUT = `sched-mixed-optout-${stamp}`;
  const fetches: Record<string, number> = { paused: 0, optOut: 0 };

  function Page() {
    useClientResource(KEY_PAUSED, async () => { fetches.paused += 1; return "p"; }, { pollMs: 30 });
    useClientResource(KEY_OPTOUT, async () => { fetches.optOut += 1; return "o"; }, { pollMs: 30, pauseWhenHidden: false });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  await waitFor(() => fetches.paused >= 1 && fetches.optOut >= 1);
  expect(pollBucketCountForTests()).toBe(1);

  await setVisibility("hidden");
  // The bucket keeps its timer for the opt-out member...
  expect(hasPollTimerForTests(KEY_OPTOUT)).toBe(true);
  const atHide = { ...fetches };
  await waitFor(() => fetches.optOut > atHide.optOut);
  // ...but the paused store still fires nothing (per-store rule inside the tick).
  expect(fetches.paused).toBe(atHide.paused);

  await act(async () => { root.unmount(); });
  container.remove();
  await setVisibility("visible");
});
