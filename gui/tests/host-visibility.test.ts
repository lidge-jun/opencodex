import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import {
  clearClientResourceStoresForTests,
  hasPollTimerForTests,
  useClientResource,
} from "../src/client-resource";
import { hostDocumentHidden, onHostVisibilityChange } from "../src/host-visibility";
import { startVisibilityPoll } from "../src/visibility-poll";

// Same setup as visibility-poll.test.ts / client-resource-poll.test.tsx: a real
// happy-dom window installed as the globals the modules read, plus Bun's own clock.
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
  // The flag is per page, never per test: a leftover `false` would hide every case after it.
  Reflect.deleteProperty(testWindow, "__OPENCODEX_HOST_VISIBLE__");
});

afterEach(() => {
  clearClientResourceStoresForTests();
  Reflect.deleteProperty(testWindow, "__OPENCODEX_HOST_VISIBLE__");
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/** happy-dom derives visibilityState from internals, so drive it directly. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(testWindow.document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange"));
}

function hostWindow(): { __OPENCODEX_HOST_VISIBLE__?: boolean } {
  return testWindow as unknown as { __OPENCODEX_HOST_VISIBLE__?: boolean };
}

function hostFlag(): boolean | undefined {
  return hostWindow().__OPENCODEX_HOST_VISIBLE__;
}

/** The desktop shell's bridge: the side effect first, then the event. */
function dispatchHostVisibility(visible: boolean): void {
  hostWindow().__OPENCODEX_HOST_VISIBLE__ = visible;
  dispatchHostEvent(visible);
}

/** Event only, so the module itself has to take the state from `detail`. */
function dispatchHostEvent(visible: boolean): void {
  testWindow.dispatchEvent(new testWindow.CustomEvent("opencodex:host-visibility", { detail: visible }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same busy-runner ceiling as client-resource-poll.test.tsx: the wait is about whether. */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }
}

test("the document and the host flag each hide the page; a browser with no flag is visible", () => {
  expect(hostDocumentHidden()).toBe(false);
  setVisibility("hidden");
  expect(hostDocumentHidden()).toBe(true);
  setVisibility("visible");
  expect(hostDocumentHidden()).toBe(false);

  // An explicit true must not hide anything, and the document still wins when both speak.
  hostWindow().__OPENCODEX_HOST_VISIBLE__ = true;
  expect(hostDocumentHidden()).toBe(false);
  hostWindow().__OPENCODEX_HOST_VISIBLE__ = false;
  expect(hostDocumentHidden()).toBe(true);
  setVisibility("hidden");
  expect(hostDocumentHidden()).toBe(true);
});

// The Windows WebView2 case: the document stays "visible" forever, so only the host
// event can suspend a poller.
test("the host event suspends a poller the document never reports hidden, then resumes it", async () => {
  let calls = 0;
  const stop = startVisibilityPoll(() => { calls += 1; }, 30);
  await sleep(75);
  const atStart = calls;
  expect(atStart).toBeGreaterThanOrEqual(1);
  expect(testWindow.document.visibilityState).toBe("visible"); // nothing else changed

  dispatchHostEvent(false);
  expect(hostFlag()).toBe(false); // the module wrote the flag from the event detail
  expect(hostDocumentHidden()).toBe(true);
  await sleep(160); // >5 intervals: zero calls without the suspension
  expect(calls).toBe(atStart);

  dispatchHostEvent(true);
  await sleep(10);
  expect(calls).toBe(atStart + 1); // exactly the make-up tick
  await sleep(90);
  expect(calls).toBeGreaterThanOrEqual(atStart + 2); // cadence resumed
  stop();
});

// On macOS both signals arrive for one hide. Consumers fetch on visible-again, so a
// second callback for the same transition would double-fetch.
test("two signals reporting one transition call back once", () => {
  const seen: boolean[] = [];
  const unsubscribe = onHostVisibilityChange(() => seen.push(hostDocumentHidden()));

  setVisibility("hidden");
  dispatchHostVisibility(false);
  expect(seen).toEqual([true]);

  setVisibility("visible");
  dispatchHostVisibility(true);
  expect(seen).toEqual([true, false]);

  // A repeated signal for a state already known is silent too.
  dispatchHostVisibility(true);
  setVisibility("visible");
  expect(seen).toEqual([true, false]);

  unsubscribe();
  setVisibility("hidden");
  expect(seen).toEqual([true, false]); // no listener left behind
});

test("a polling subscriber skips its interval for a host-hidden window and makes up once", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const KEY = `host-visibility-poll-${Date.now()}`;
  let fetches = 0;

  function Page() {
    useClientResource(KEY, async () => { fetches += 1; return `v${fetches}`; }, { pollMs: 150 });
    return null;
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(Page));
  });
  await waitFor(() => fetches >= 1);
  expect(hasPollTimerForTests(KEY)).toBe(true);

  await act(async () => {
    dispatchHostVisibility(false);
    await Promise.resolve();
  });
  expect(hasPollTimerForTests(KEY)).toBe(false); // suspended: the timer is gone

  // An in-flight tick may still settle; take the count once the store is quiet.
  await act(async () => { await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 60)); });
  const atHidden = fetches;
  await act(async () => { await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 320)); });
  expect(fetches).toBe(atHidden); // >2 intervals, no fetch

  await act(async () => {
    dispatchHostVisibility(true);
    await Promise.resolve();
  });
  await waitFor(() => fetches === atHidden + 1);
  await act(async () => { await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 50)); });
  expect(fetches).toBe(atHidden + 1); // one make-up fetch, not a burst
  await waitFor(() => fetches >= atHidden + 2); // then the cadence

  await act(async () => { root.unmount(); });
  container.remove();
});
