import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests, type ResourceSnapshot } from "../src/client-resource";
import { classifyDataSurface, useDataSurface, type DataSurfaceState } from "../src/data-surface";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
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
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
});

afterEach(() => {
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }
}

function snapshot(overrides: Partial<ResourceSnapshot<string[]>>): ResourceSnapshot<string[]> {
  return {
    data: undefined,
    error: undefined,
    loading: false,
    refreshing: false,
    hasSucceeded: false,
    lastAttemptOk: false,
    ...overrides,
  };
}

const isEmpty = (rows: string[]) => rows.length === 0;

test("a disabled surface never asks for a skeleton", () => {
  const state = classifyDataSurface(snapshot({}), isEmpty, false);
  expect(state.kind).toBe("disabled");
  expect(state.showSkeleton).toBe(false);
  expect(state.refreshing).toBe(false);
  expect(state.showError).toBe(false);
});

test("an in-flight request over existing rows keeps the content and shows progress", () => {
  const state = classifyDataSurface(
    snapshot({ data: ["a"], hasSucceeded: true, lastAttemptOk: true, refreshing: true }),
    isEmpty,
    true,
  );
  expect(state.kind).toBe("loading-with-stale-data");
  expect(state.showSkeleton).toBe(false);
  expect(state.refreshing).toBe(true);
  expect(state.data).toEqual(["a"]);
});

test("a cold retry keeps its skeleton instead of freezing on the previous error", () => {
  const settled = classifyDataSurface(
    snapshot({ error: new Error("boom"), lastAttemptOk: false }),
    isEmpty,
    true,
  );
  expect(settled.kind).toBe("failed-cold");
  expect(settled.showError).toBe(true);

  const retrying = classifyDataSurface(
    snapshot({ error: new Error("boom"), lastAttemptOk: false, refreshing: true }),
    isEmpty,
    true,
  );
  expect(retrying.kind).toBe("retrying-cold");
  expect(retrying.showSkeleton).toBe(true);
  expect(retrying.refreshing).toBe(true);
  // The skeleton owns the single live region, so the error must not also announce itself.
  expect(retrying.showError).toBe(false);
  expect(retrying.error).toBeInstanceOf(Error);
});

test("an empty success stays distinguishable from a populated one and from a later failure", () => {
  const empty = classifyDataSurface(
    snapshot({ data: [], hasSucceeded: true, lastAttemptOk: true }),
    isEmpty,
    true,
  );
  expect(empty.kind).toBe("ready-empty");
  expect(empty.showError).toBe(false);

  // The regression this contract exists to prevent: an empty success must not swallow the
  // next failure by looking "already loaded and fine".
  const thenFailed = classifyDataSurface(
    snapshot({ data: [], hasSucceeded: true, lastAttemptOk: false, error: new Error("later") }),
    isEmpty,
    true,
  );
  expect(thenFailed.kind).toBe("failed-with-stale");
  expect(thenFailed.showError).toBe(true);
  expect(thenFailed.data).toEqual([]);
});

test("a quiet poll over cached data raises refreshing without blanking the surface", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `data-surface-quiet-poll-${Date.now()}`;
  let release: ((rows: string[]) => void) | null = null;
  let calls = 0;
  const seen: DataSurfaceState<string[]>[] = [];

  function Surface() {
    const { state } = useDataSurface<string[]>(
      KEY,
      [],
      () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(["first"]);
        return new Promise<string[]>((resolve) => { release = resolve; });
      },
      { isEmpty, pollMs: 40 },
    );
    seen.push(state);
    return <div>{state.kind}</div>;
  }

  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<Surface />);
  });

  await waitFor(() => seen.some((s) => s.kind === "ready-populated"));
  // The second call is the poll; it must not clear the rows.
  await waitFor(() => calls >= 2 && release !== null);
  await waitFor(() => seen.some((s) => s.kind === "loading-with-stale-data"));

  const stale = seen.filter((s) => s.kind === "loading-with-stale-data");
  expect(stale.length).toBeGreaterThan(0);
  expect(stale[0]!.showSkeleton).toBe(false);
  expect(stale[0]!.refreshing).toBe(true);
  expect(stale[0]!.data).toEqual(["first"]);

  await act(async () => { release?.(["second"]); });
  await waitFor(() => seen.at(-1)?.data?.[0] === "second");

  await act(async () => { root?.unmount(); });
});

test("a rejection with undefined still reads as a failure", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `data-surface-undefined-reject-${Date.now()}`;
  const seen: DataSurfaceState<string[]>[] = [];

  function Surface() {
    const { state } = useDataSurface<string[]>(
      KEY,
      [],
      () => Promise.reject(undefined),
      { isEmpty },
    );
    seen.push(state);
    return <div>{state.kind}</div>;
  }

  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<Surface />);
  });

  await waitFor(() => seen.some((s) => s.kind === "failed-cold"));
  const failed = seen.find((s) => s.kind === "failed-cold")!;
  expect(failed.showError).toBe(true);
  expect(failed.showSkeleton).toBe(false);

  await act(async () => { root?.unmount(); });
});

test("a disabled surface issues no request and starts fetching once enabled", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `data-surface-enable-${Date.now()}`;
  let calls = 0;
  let flip: (() => void) | null = null;
  const seen: DataSurfaceState<string[]>[] = [];

  function Surface() {
    const [enabled, setEnabled] = useState(false);
    flip = () => setEnabled(true);
    const { state } = useDataSurface<string[]>(
      KEY,
      [],
      () => { calls += 1; return Promise.resolve(["row"]); },
      { isEmpty, enabled },
    );
    seen.push(state);
    return <div>{state.kind}</div>;
  }

  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<Surface />);
  });

  expect(calls).toBe(0);
  expect(seen.at(-1)?.kind).toBe("disabled");

  await act(async () => { flip?.(); });
  await waitFor(() => calls >= 1);
  await waitFor(() => seen.at(-1)?.kind === "ready-populated");

  await act(async () => { root?.unmount(); });
});

test("a surface that unmounts immediately after mounting still issued its request", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const KEY = `data-surface-mount-unmount-${Date.now()}`;
  let calls = 0;

  function Surface() {
    const { state } = useDataSurface<string[]>(
      KEY,
      [],
      () => { calls += 1; return Promise.resolve(["row"]); },
      { isEmpty },
    );
    return <div>{state.kind}</div>;
  }

  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<Surface />);
  });
  await act(async () => { root?.unmount(); });

  // The retired pattern deferred the mount fetch through setTimeout(..., 0) and cancelled it in
  // cleanup, so a fast route change dropped the request entirely with no retry.
  expect(calls).toBeGreaterThanOrEqual(1);
});

test("a second surface on the same key renders cached rows without a skeleton", async () => {
  const { createRoot } = await import("react-dom/client");
  const first = document.createElement("div");
  const second = document.createElement("div");
  document.body.append(first, second);

  const KEY = `data-surface-shared-${Date.now()}`;
  const firstSeen: DataSurfaceState<string[]>[] = [];
  const secondSeen: DataSurfaceState<string[]>[] = [];

  function Surface({ sink }: { sink: DataSurfaceState<string[]>[] }) {
    const { state } = useDataSurface<string[]>(
      KEY,
      [],
      () => Promise.resolve(["shared"]),
      { isEmpty },
    );
    sink.push(state);
    return <div>{state.kind}</div>;
  }

  let firstRoot: Root | null = null;
  await act(async () => {
    firstRoot = createRoot(first);
    firstRoot.render(<Surface sink={firstSeen} />);
  });
  await waitFor(() => firstSeen.some((s) => s.kind === "ready-populated"));

  let secondRoot: Root | null = null;
  await act(async () => {
    secondRoot = createRoot(second);
    secondRoot.render(<Surface sink={secondSeen} />);
  });

  expect(secondSeen[0]!.showSkeleton).toBe(false);
  expect(secondSeen[0]!.data).toEqual(["shared"]);

  await act(async () => { firstRoot?.unmount(); secondRoot?.unmount(); });
});
