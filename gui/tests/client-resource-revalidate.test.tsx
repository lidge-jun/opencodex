import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests, invalidateClientResource, useClientResource } from "../src/client-resource";
import { classifyDataSurface } from "../src/data-surface";
import {
  readSessionListCache,
  readSessionListCacheEntry,
  writeSessionListCache,
  writeSessionListCacheEntry,
} from "../src/session-list-cache";

function test(name: string, fn: () => void | Promise<void>): void {
  bunTest(name, fn, { timeout: 30_000 });
}

const globals = ["document", "window", "navigator", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
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
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
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

type Probe = { current: ReturnType<typeof useClientResource<string>> | null };

async function mountSeeded(opts: {
  key: string;
  fetcher: () => Promise<string>;
  seed: string;
  cachedAt: number | null;
  staleAfterMs?: number;
}): Promise<{ probe: Probe; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const probe: Probe = { current: null };
  function Page() {
    probe.current = useClientResource(opts.key, opts.fetcher, {
      initialData: opts.seed,
      initialDataCachedAt: opts.cachedAt,
      staleAfterMs: opts.staleAfterMs,
    });
    return null;
  }
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Page />);
  });
  return { probe, root };
}

test("a seed younger than staleAfterMs skips the mount refetch entirely", async () => {
  let fetches = 0;
  const { probe, root } = await mountSeeded({
    key: `reval-fresh-${Date.now()}`,
    fetcher: async () => { fetches += 1; return "live"; },
    seed: "seeded",
    cachedAt: Date.now() - 100,
    staleAfterMs: 60_000,
  });
  expect(probe.current?.data).toBe("seeded");
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 60));
  });
  expect(fetches).toBe(0); // the saved request
  await act(async () => { root.unmount(); });
});

test("a seed older than staleAfterMs quietly revalidates without a skeleton", async () => {
  let fetches = 0;
  let release: ((value: string) => void) | null = null;
  const { probe, root } = await mountSeeded({
    key: `reval-stale-${Date.now()}`,
    // Held open so the mid-revalidation state is observable rather than already past.
    fetcher: () => { fetches += 1; return new Promise<string>((resolve) => { release = resolve; }); },
    seed: "seeded",
    cachedAt: Date.now() - 120_000,
    staleAfterMs: 60_000,
  });
  await waitFor(() => probe.current?.refreshing === true);
  // Cached data stays visible while the refetch runs — never a cold skeleton.
  const during = classifyDataSurface(probe.current!, () => false, true);
  expect(during.showSkeleton).toBe(false);
  expect(during.data).toBe("seeded");
  expect(during.kind).toBe("loading-with-stale-data");
  await act(async () => { release!("live"); });
  await waitFor(() => probe.current?.data === "live");
  expect(fetches).toBe(1);
  await act(async () => { root.unmount(); });
});

test("a legacy seed with unknown age counts as stale and self-heals", async () => {
  let fetches = 0;
  const { probe, root } = await mountSeeded({
    key: `reval-legacy-${Date.now()}`,
    fetcher: async () => { fetches += 1; return "live"; },
    seed: "seeded",
    cachedAt: null,
    staleAfterMs: 60_000,
  });
  await waitFor(() => probe.current?.data === "live");
  expect(fetches).toBe(1);
  await act(async () => { root.unmount(); });
});

test("without staleAfterMs a seed keeps today's always-revalidate behavior", async () => {
  let fetches = 0;
  const { probe, root } = await mountSeeded({
    key: `reval-default-${Date.now()}`,
    fetcher: async () => { fetches += 1; return "live"; },
    seed: "seeded",
    cachedAt: Date.now() - 10,
  });
  await waitFor(() => probe.current?.data === "live");
  expect(fetches).toBe(1);
  await act(async () => { root.unmount(); });
});

test("session cache entries round-trip their age and read legacy values", () => {
  const key = `entry-${Date.now()}`;
  writeSessionListCacheEntry(key, { rows: [1, 2, 3] });
  const entry = readSessionListCacheEntry<{ rows: number[] }>(key);
  expect(entry?.data.rows).toEqual([1, 2, 3]);
  expect(typeof entry?.cachedAt).toBe("number");
  // The plain reader stays transparent for callers that ignore age.
  expect(readSessionListCache<{ rows: number[] }>(key)?.rows).toEqual([1, 2, 3]);

  const legacyKey = `entry-legacy-${Date.now()}`;
  writeSessionListCache(legacyKey, { rows: [9] });
  const legacy = readSessionListCacheEntry<{ rows: number[] }>(legacyKey);
  expect(legacy?.data.rows).toEqual([9]);
  expect(legacy?.cachedAt).toBeNull();
});

for (const mode of ["without a store", "before eviction", "after eviction"] as const) {
  test("explicit invalidation revalidates a fresh seed " + mode, async () => {
    const key = "invalidated-fresh-seed";
    if (mode !== "without a store") {
      const first = await mountSeeded({ key, fetcher: async () => "unused", seed: "old", cachedAt: Date.now(), staleAfterMs: 60_000 });
      await act(async () => first.root.unmount());
      if (mode === "before eviction") invalidateClientResource(key);
      // Flush the resource's documented deferred store eviction.
      await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
    }
    if (mode !== "before eviction") invalidateClientResource(key);
    let fetches = 0;
    const { probe, root } = await mountSeeded({ key, fetcher: async () => { fetches++; return "new"; },
      seed: "old", cachedAt: Date.now(), staleAfterMs: 60_000 });
    expect(fetches).toBe(1);
    expect(probe.current?.data).toBe("new");
    await act(async () => root.unmount());
  });
}

test("active invalidation sequences its fetch ahead of a delayed older refresh", async () => {
  let releaseOld!: (value: string) => void;
  let reads = 0;
  const { probe, root } = await mountSeeded({ key: "invalidated-active", fetcher: () => {
    if (++reads === 1) return new Promise<string>(resolve => { releaseOld = resolve; });
    return Promise.resolve("new");
  }, seed: "seed", cachedAt: Date.now(), staleAfterMs: 60_000 });
  await act(async () => probe.current!.refresh());
  await act(async () => invalidateClientResource("invalidated-active"));
  expect(probe.current?.data).toBe("new");
  await act(async () => releaseOld("old"));
  expect(probe.current?.data).toBe("new");
  await act(async () => root.unmount());
});
