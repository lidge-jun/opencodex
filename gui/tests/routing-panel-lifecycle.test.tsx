/**
 * RoutingProfiles as a hidden Models tab.
 *
 * Review found a path that abort and generation-invalidation both miss: a save or
 * delete resolving AFTER the panel is hidden calls `load()`, which opened a fresh
 * controller and four requests the deactivation effect had already run past — with a
 * current generation, so its writes would land in a panel nobody is looking at.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import RoutingProfiles from "../src/pages/RoutingProfiles";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
const API_BASE = "http://localhost";

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#models/routing" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

type Counts = { profiles: number; aborted: number };

function installFetch(counts: Counts, gate?: Promise<void>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/routing-profiles")) {
      counts.profiles++;
      if (gate) await gate;
      // Report abort the way a real fetch would, so the caller's guard is exercised.
      if (init?.signal?.aborted) { counts.aborted++; throw new Error("aborted"); }
      return Response.json([]);
    }
    if (url.includes("/api/routing-analytics")) return Response.json(null);
    if (url.includes("/api/config")) return Response.json({ providers: {} });
    if (url.includes("/api/models")) return Response.json([]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

async function mount(active: boolean): Promise<{
  root: Root;
  container: HTMLElement;
  rerender: (a: boolean) => Promise<void>;
}> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  const render = (a: boolean) => (
    <LanguageProvider>
      <RoutingProfiles apiBase={API_BASE} active={a} />
    </LanguageProvider>
  );
  await act(async () => {
    root = createRoot(container);
    root.render(render(active));
  });
  // The load is scheduled through a zero-delay timeout, so a microtask flush is not
  // enough to observe it.
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  return {
    root,
    container,
    rerender: async (a: boolean) => {
      await act(async () => { root.render(render(a)); });
      await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    },
  };
}

test("a hidden panel never starts its initial load", async () => {
  const counts: Counts = { profiles: 0, aborted: 0 };
  installFetch(counts);
  const { root } = await mount(false);
  try {
    expect(counts.profiles).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});

test("an in-flight load is aborted when the panel is hidden", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const counts: Counts = { profiles: 0, aborted: 0 };
  installFetch(counts, gate);

  const { root, rerender } = await mount(true);
  try {
    expect(counts.profiles).toBe(1);
    await rerender(false);
    release();
    await act(async () => { await Promise.resolve(); });
    expect(counts.aborted).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * The blocker, reproduced through the real path: Retry calls `load()` directly, exactly
 * as the post-save and post-delete handlers do. Cancelling what is already running does
 * not stop a call that arrives AFTER the panel is hidden from opening a whole new load.
 *
 * Driven by clicking Retry while hidden — the same entry point a mutation resolving
 * late would use, and one a test can reach without faking a save.
 */
test("a load requested while hidden never reaches the network", async () => {
  const counts: Counts = { profiles: 0, aborted: 0 };
  installFetch(counts);

  const { root, rerender, container } = await mount(true);
  try {
    const afterMount = counts.profiles;
    expect(afterMount).toBeGreaterThan(0);

    const retry = [...container.querySelectorAll("button")]
      .find(b => b.textContent?.includes("Retry")) as HTMLButtonElement | undefined;
    expect(retry).toBeTruthy();

    await rerender(false);
    // The panel is hidden; the handler still exists and still calls load().
    await act(async () => { retry!.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });

    expect(counts.profiles).toBe(afterMount);
  } finally {
    await act(async () => root.unmount());
  }
});

test("becoming visible again loads", async () => {
  const counts: Counts = { profiles: 0, aborted: 0 };
  installFetch(counts);
  const { root, rerender } = await mount(false);
  try {
    expect(counts.profiles).toBe(0);
    await rerender(true);
    expect(counts.profiles).toBeGreaterThan(0);
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * The tab meta is only useful if it follows the list. `onCountChange` fires from an
 * effect keyed on `profiles.length`, so a reload that changes the list has to report.
 */
test("the profile count is reported and follows a reload", async () => {
  const seen: number[] = [];
  /*
   * The real response shape: a `profiles` wrapper, and every nested object present.
   * `parseProfiles` drops anything that omits them, so a looser fixture silently
   * yields an empty list and the test would measure nothing.
   */
  const PROFILE = {
    id: "balanced",
    model: "policy/balanced",
    revision: "rev-abc",
    candidates: [{ provider: "openai", model: "gpt-5" }],
    require: {},
    optimize: {},
    limits: {},
    unknownEvidence: {},
  };
  let profiles: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/routing-profiles")) return Response.json({ profiles });
    if (url.includes("/api/routing-analytics")) return Response.json(null);
    if (url.includes("/api/config")) return Response.json({ providers: {} });
    if (url.includes("/api/models")) return Response.json([]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <RoutingProfiles apiBase={API_BASE} active onCountChange={n => seen.push(n)} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });

  try {
    expect(seen.at(-1)).toBe(0);

    // Stand in for a create: the list grows, then Retry reloads it.
    profiles = [PROFILE];
    const retry = [...container.querySelectorAll("button")]
      .find(b => b.textContent?.includes("Retry")) as HTMLButtonElement;
    await act(async () => { retry.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(seen.at(-1)).toBe(1);

    // And a delete: back to empty.
    profiles = [];
    await act(async () => { retry.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(seen.at(-1)).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});
