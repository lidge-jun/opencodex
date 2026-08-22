import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import {
  clearClientResourceStoresForTests,
  useClientResource,
} from "../src/client-resource";
import { classifyDataSurface } from "../src/data-surface";

// Same harness as client-resource-poll.test.tsx: busy CI runners need the ceiling.
function test(name: string, fn: () => void | Promise<void>): void {
  bunTest(name, fn, { timeout: 30_000 });
}

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const mountedRoots: Root[] = [];

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
  // Unmount before globals restore: a settle microtask firing after restore would
  // emit into React with window undefined.
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
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

type SnapshotProbe = { current: ReturnType<typeof useClientResource<string>> | null };

async function mountResource(opts: {
  key: string;
  fetcher: (signal: AbortSignal) => Promise<string>;
  pollMs?: number;
  deadlineMs?: number;
}): Promise<{ probe: SnapshotProbe; root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const probe: SnapshotProbe = { current: null };
  function Subscriber() {
    probe.current = useClientResource(opts.key, opts.fetcher, { pollMs: opts.pollMs, deadlineMs: opts.deadlineMs });
    return <span />;
  }
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Subscriber />);
  });
  mountedRoots.push(root);
  return { probe, root, container };
}
test("never-settling fetcher settles failed within the deadline", async () => {
  const { probe } = await mountResource({
    key: `deadline-settle-${Date.now()}`,
    fetcher: () => new Promise<string>(() => {}),
    deadlineMs: 50,
  });
  await waitFor(() => probe.current?.lastAttemptOk === false && probe.current?.error instanceof Error);
  expect(probe.current?.loading).toBe(false);
  expect(probe.current?.refreshing).toBe(false);
  expect(String((probe.current?.error as Error).message)).toContain("timed out");
});

test("polled store self-heals after a timed-out attempt", async () => {
  let attempts = 0;
  const { probe } = await mountResource({
    key: `deadline-heal-${Date.now()}`,
    fetcher: () => {
      attempts++;
      return attempts === 1 ? new Promise<string>(() => {}) : Promise.resolve("ok");
    },
    pollMs: 40,
    deadlineMs: 50,
  });
  await waitFor(() => probe.current?.data === "ok");
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test("timed-out cold store shows the error surface, not a skeleton", async () => {
  const { probe } = await mountResource({
    key: `deadline-surface-${Date.now()}`,
    fetcher: () => new Promise<string>(() => {}),
    deadlineMs: 50,
  });
  // lastAttemptOk starts false (EMPTY_SNAPSHOT) — only an error marks a real settle.
  await waitFor(() => probe.current?.error instanceof Error);
  const state = classifyDataSurface(probe.current!, () => false, true);
  expect(state.kind).toBe("failed-cold");
  expect(state.showSkeleton).toBe(false);
  expect(state.showError).toBe(true);
});

test("unmount during the deadline window still takes the abort path", async () => {
  const { probe, root } = await mountResource({
    key: `deadline-unmount-${Date.now()}`,
    fetcher: () => new Promise<string>(() => {}),
    deadlineMs: 10_000,
  });
  await waitFor(() => probe.current?.refreshing === true);
  await act(async () => {
    root.unmount();
  });
  // The aborted attempt must never surface as a failure settle for a remount.
  const { probe: probe2 } = await mountResource({
    key: `deadline-unmount-2-${Date.now()}`,
    fetcher: () => Promise.resolve("fresh"),
    deadlineMs: 10_000,
  });
  await waitFor(() => probe2.current?.data === "fresh");
  expect(probe2.current?.lastAttemptOk).toBe(true);
});

test("manual refresh after timeout recovers immediately", async () => {
  let settle = false;
  const { probe } = await mountResource({
    key: `deadline-refresh-${Date.now()}`,
    fetcher: () => (settle ? Promise.resolve("recovered") : new Promise<string>(() => {})),
    deadlineMs: 50,
  });
  await waitFor(() => probe.current?.lastAttemptOk === false);
  settle = true;
  await act(async () => {
    probe.current?.refresh();
  });
  await waitFor(() => probe.current?.data === "recovered");
});

test("signal-dropping fetcher is bounded by the race", async () => {
  const { probe } = await mountResource({
    key: `deadline-signaldrop-${Date.now()}`,
    // Ignores the abort signal entirely: only the race can settle the store.
    fetcher: () => new Promise<string>(() => {}),
    deadlineMs: 50,
  });
  await waitFor(() => probe.current?.lastAttemptOk === false && probe.current?.refreshing === false);
});

test("owner abort after the deadline fired settles exactly once, as the timeout", async () => {
  let replace: (() => void) | null = null;
  let attempts = 0;
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const probe: SnapshotProbe = { current: null };
  function Harness() {
    const [gen, setGen] = useState(0);
    replace = () => setGen(1);
    probe.current = useClientResource(
      `deadline-race-${gen}`,
      () => {
        attempts++;
        return new Promise<string>(() => {});
      },
      { deadlineMs: 50 },
    );
    return <span />;
  }
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  mountedRoots.push(root);
  // Let the first key's deadline fire and settle (error — lastAttemptOk starts false)...
  await waitFor(() => probe.current?.error instanceof Error);
  const failedError = probe.current?.error;
  // ...then replace it (new key = owner abort of nothing + fresh mount).
  await act(async () => {
    replace!();
  });
  await waitFor(() => attempts >= 2 && probe.current?.error instanceof Error);
  expect(String((failedError as Error).message)).toContain("timed out");
  await act(async () => {
    root.unmount();
  });
});
