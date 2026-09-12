import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import Combos from "../src/pages/Combos";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { writeSessionListCache } from "../src/session-list-cache";

/**
 * WP3 (devlog/_fin/260730_gui_hydration_loading_unify/020_page_migration.md).
 *
 * Every migrated surface answers the same three questions the same way: replace the content
 * while cold, report progress next to content that is already on screen, and keep a failure
 * distinguishable from an empty result. These are source-level pins — the behavioural proof for
 * the contract itself lives in data-surface.test.tsx.
 *
 * Each surface is added here by its own migration commit, so the list doubles as the progress
 * ledger for WP3.
 */

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

/**
 * Pages name their local state binding differently (`state`, `loadState`, `logsState`), so match
 * the contract's field access rather than one variable name. Pinning a name would make this test
 * a rename detector instead of a contract check.
 */
const usesField = (source: string, field: string): boolean =>
  new RegExp(`\\.${field}\\b`).test(source);

/** Surfaces migrated so far, in migration order. */
const MIGRATED = [
  { name: "Grok", file: "../src/pages/Grok.tsx" },
  { name: "Subagents", file: "../src/pages/Subagents.tsx" },
  { name: "Combos", file: "../src/pages/Combos.tsx" },
  { name: "Usage", file: "../src/pages/Usage.tsx" },
  { name: "Startup", file: "../src/pages/Startup.tsx" },
  { name: "Logs", file: "../src/pages/Logs.tsx" },
  { name: "Debug", file: "../src/pages/Debug.tsx" },
  { name: "ClaudeCode", file: "../src/pages/ClaudeCode.tsx" },
  { name: "ClaudeDesktop", file: "../src/pages/ClaudeDesktop.tsx" },
  { name: "Storage", file: "../src/pages/Storage.tsx" },
  { name: "ApiKeys", file: "../src/pages/ApiKeys.tsx" },
  { name: "Models", file: "../src/pages/Models.tsx" },
  { name: "CodexSetPrompt", file: "../src/pages/codex-set-prompt.tsx" },
] as const;

test("every migrated surface subscribes through the shared resource layer", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).toContain("useDataSurface");
  }
});

test("no migrated surface defers its mount fetch behind a zero-delay timer", async () => {
  // The retired pattern cancelled the timer in cleanup, so a route change during the first tick
  // dropped the request with no retry and the tab simply stayed empty.
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).not.toContain("setTimeout(() => { void load(); }, 0)");
  }
});

test("every migrated surface renders the shared cold skeleton", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).toContain("DataSurfaceSkeleton");
    expect(usesField(source, "showSkeleton"), surface.name).toBe(true);
  }
});

test("every migrated surface reports a revalidation over existing content", async () => {
  // These surfaces keep cached panels visible without a status line — a spinner would flash
  // over known state on revisit (Logs also polls every 2s).
  const silentRevalidation = new Set([
    "Debug", "Startup", "Logs", "Subagents", "Usage", "Models", "ClaudeCode", "ClaudeDesktop", "ApiKeys", "Grok", "Combos",
  ]);
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    if (silentRevalidation.has(surface.name)) {
      expect(usesField(source, "refreshing") || usesField(source, "loading"), surface.name).toBe(true);
      continue;
    }
    expect(source, surface.name).toContain("DataSurfaceStatus");
    expect(
      usesField(source, "refreshing") || usesField(source, "loading"),
      surface.name,
    ).toBe(true);
  }
});

test("a failure after a success stays visible instead of reading as settled", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    // `showError` covers a stale failure; `failed-cold` covers the never-succeeded case. A surface
    // that handles neither would silently render as settled after a failed read.
    expect(
      usesField(source, "showError") || source.includes("failed-cold"),
      surface.name,
    ).toBe(true);
  }
});

test("the status line yields its live region to an error notice", async () => {
  const noStatusLine = new Set([
    "Debug", "Startup", "Logs", "Subagents", "Usage", "Models", "ClaudeCode", "ClaudeDesktop", "ApiKeys", "Grok", "Combos",
  ]);
  // One announcement per transition: two live regions make a screen reader repeat itself.
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    if (noStatusLine.has(surface.name)) continue;
    expect(
      /live=\{!\w+\.showError\}/.test(source) || source.includes("live={false}"),
      surface.name,
    ).toBe(true);
  }
});

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const API_BASE = "http://localhost";
const CACHE_KEY = `ocx.combos.workspace.v1:${API_BASE}`;
const CACHED_PAGE = {
  combos: [],
  providers: [{ name: "openai", disabled: false, hiddenFromPicker: false, authMode: "forward", adapter: "openai", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5" }],
  models: [{ provider: "openai", id: "gpt-5", namespaced: "openai/gpt-5" }],
  cataloguedComboIds: [],
};

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#models/combos" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeSessionListCache(CACHE_KEY, CACHED_PAGE);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("Combos announces silent revalidation over cached content via aria-busy", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  type Gate = { resolve: () => void };
  let release!: Gate;
  const gate = new Promise<void>(resolve => { release = { resolve }; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/combos") || url.includes("/api/config") || url.includes("/api/models")) {
      await gate;
      if (url.includes("/api/combos")) return Response.json([]);
      if (url.includes("/api/config")) return Response.json({ providers: CACHED_PAGE.providers });
      return Response.json([]);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Combos apiBase={API_BASE} /></LanguageProvider>);
  });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 0)); });

  const body = container.querySelector<HTMLElement>(".combos-workspace-shell-body");
  expect(body).not.toBeNull();
  expect(body?.getAttribute("aria-busy")).toBe("true");
  // The silent layout still announces: an sr-only polite status region carries the
  // loading text while the refresh is in flight (attribute-only wiring is not enough).
  const status = body?.querySelector<HTMLElement>('[role="status"]');
  expect(status).not.toBeNull();
  expect(status?.classList.contains("sr-only")).toBe(true);
  expect(status?.getAttribute("aria-live")).toBe("polite");
  expect(status?.textContent?.trim().length).toBeGreaterThan(0);

  await act(async () => {
    release.resolve();
    await Promise.resolve();
  });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 20)); });

  expect(container.querySelector<HTMLElement>(".combos-workspace-shell-body")?.getAttribute("aria-busy")).toBe("false");
  expect(container.querySelector<HTMLElement>(".combos-workspace-shell-body [role='status']")?.textContent?.trim()).toBe("");

  await act(async () => { root.unmount(); });
  container.remove();
});


test.each(["timer", "visible", "active", "commit-boundary"])("Combos expires a quota block before a new response: %s", async wake => {
  const { createRoot } = await import("react-dom/client");
  const startedAt = Date.now();
  let now = startedAt;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const schedule = testWindow.setTimeout.bind(testWindow);
  const cancel = testWindow.clearTimeout.bind(testWindow);
  const expiryTimers = new Set<number>();
  let expire: (() => void) | undefined;
  let controlImmediate = false;
  let nextControlledTimer = -1;
  const immediateTimers = new Map<number, () => void>();
  const scheduleSpy = spyOn(testWindow, "setTimeout").mockImplementation((callback, delay, ...args) => {
    if (controlImmediate && delay === 0 && typeof callback === "function") {
      const timer = nextControlledTimer--;
      immediateTimers.set(timer, () => callback(...args));
      return timer;
    }
    const timer = schedule(callback, delay, ...args);
    if (delay === 123_456 && typeof callback === "function") {
      expiryTimers.add(timer);
      expire = () => callback(...args);
    }
    return timer;
  });
  const cancelSpy = spyOn(testWindow, "clearTimeout").mockImplementation(timer => {
    expiryTimers.delete(timer);
    if (immediateTimers.delete(timer)) return;
    cancel(timer);
  });
  const item = { id: "alpha", model: "combo/alpha", strategy: "failover", stickyLimit: 1,
    targets: [{ provider: "keyed", model: "m1" }] };
  let quotaFetches = 0;
  const workspaceFetches = new Map<string, number>();
  const waitForAbort = (signal: AbortSignal | null | undefined) => new Promise<Response>((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/provider-quotas")) {
      quotaFetches += 1;
      if (quotaFetches > 1) return waitForAbort(init?.signal);
      return Response.json({ reports: [{ provider: "keyed", updatedAt: startedAt,
        quota: { updatedAt: startedAt, fiveHourPercent: 100 },
        routingQuota: { state: "exhausted", updatedAt: startedAt, validUntil: startedAt + 123_456 },
      }] });
    }
    const count = (workspaceFetches.get(url) ?? 0) + 1;
    workspaceFetches.set(url, count);
    if (count > 1) return waitForAbort(init?.signal);
    if (url.includes("/api/combos")) return Response.json({ combos: [item] });
    if (url.includes("/api/config")) return Response.json({ providers: {
      keyed: { adapter: "openai-chat", authMode: "key", baseUrl: "https://provider.example/v1", defaultModel: "m1" },
    } });
    if (url.includes("/api/models")) return Response.json([
      { provider: "keyed", id: "m1" }, { provider: "combo", id: "alpha" },
    ]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function ClockBoundary({ active, expireDuringCommit }: { active: boolean; expireDuringCommit: boolean }) {
    useLayoutEffect(() => {
      if (expireDuringCommit) now = startedAt + 123_456;
    }, [expireDuringCommit]);
    return <LanguageProvider><Combos apiBase={API_BASE} active={active} /></LanguageProvider>;
  }
  const render = (active = true, expireDuringCommit = false) =>
    <ClockBoundary active={active} expireDuringCommit={expireDuringCommit} />;
  try {
    await act(async () => { root.render(render()); });
    await act(async () => { await new Promise<void>(resolve => schedule(resolve, 0)); });
    const rail = [...container.querySelectorAll<HTMLButtonElement>(".combos-workspace-rail-row")]
      .find(row => row.querySelector(".combos-workspace-rail-name")?.textContent === "combo/alpha");
    expect(rail).toBeDefined();
    await act(async () => { rail!.click(); });
    await act(async () => { await new Promise<void>(resolve => schedule(resolve, 0)); });
    const alias = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(alias, "kept-draft");
      alias.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(true);
    expect(expire).toBeDefined();
    if (wake === "visible") {
      Object.defineProperty(testWindow.document, "visibilityState", { configurable: true, value: "hidden" });
      await act(async () => { testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange")); });
    }
    if (wake === "active" || wake === "commit-boundary") {
      controlImmediate = true;
      // Do not yield to global resource eviction between the two activation commits.
      act(() => { root.render(render(false)); });
      expect(expiryTimers.size).toBe(0);
      now = startedAt + 123_456 - (wake === "commit-boundary" ? 1 : 0);
      act(() => { root.render(render(true, wake === "commit-boundary")); });
      expect(immediateTimers.size).toBe(1);
      const [timer, recheck] = [...immediateTimers.entries()][0]!;
      immediateTimers.delete(timer);
      act(() => { recheck(); });
    } else {
      now = startedAt + 123_456;
      await act(async () => {
        if (wake === "timer") expire!();
        else {
          Object.defineProperty(testWindow.document, "visibilityState", { configurable: true, value: "visible" });
          testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange"));
        }
      });
    }
    expect(container.querySelector<HTMLInputElement>("#cwi-edit-alias")!.value).toBe("kept-draft");
    expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(false);
    if (wake === "timer") expect(quotaFetches).toBe(1);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    scheduleSpy.mockRestore();
    cancelSpy.mockRestore();
    clock.mockRestore();
  }
  expect(expiryTimers.size).toBe(0);
  expect(immediateTimers.size).toBe(0);
});


test("Combos evaluates fresh exhaustion beside a retained older quota row without losing drafts", async () => {
  const { createRoot } = await import("react-dom/client");
  const startedAt = 1_800_000_000_000;
  let now = startedAt;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const interval = globalThis.setInterval;
  let pollQuota: (() => void) | undefined;
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) => {
    if (delay === 60_000 && typeof callback === "function") pollQuota = () => callback(...args);
    return interval(callback, delay, ...args);
  });
  let quotaFetches = 0;
  let completeRefresh: ((response: Response) => void) | undefined;
  const snapshot = (fresh: boolean) => Response.json({ reports: [
    { provider: "older", routingQuota: { state: "available", updatedAt: startedAt, validUntil: startedAt + 600_000 } },
    { provider: "keyed", routingQuota: { state: fresh ? "exhausted" : "available",
      updatedAt: fresh ? now : startedAt, validUntil: startedAt + 600_000 } },
  ] });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/provider-quotas")) {
      quotaFetches += 1;
      if (quotaFetches === 1) return snapshot(false);
      return new Promise<Response>(resolve => { completeRefresh = resolve; });
    }
    if (url.includes("/api/combos")) return Response.json({ combos: [{
      id: "alpha", model: "combo/alpha", strategy: "failover", stickyLimit: 1,
      targets: [{ provider: "keyed", model: "m1" }],
    }] });
    if (url.includes("/api/config")) return Response.json({ providers: {
      keyed: { adapter: "openai-chat", authMode: "key", baseUrl: "https://provider.example/v1", defaultModel: "m1" },
    } });
    if (url.includes("/api/models")) return Response.json([
      { provider: "keyed", id: "m1" }, { provider: "combo", id: "alpha" },
    ]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<LanguageProvider><Combos apiBase={API_BASE} /></LanguageProvider>); });
    const rail = [...container.querySelectorAll<HTMLButtonElement>(".combos-workspace-rail-row")]
      .find(row => row.querySelector(".combos-workspace-rail-name")?.textContent === "combo/alpha");
    expect(rail).toBeDefined();
    await act(async () => { rail!.click(); });
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
    const alias = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(alias, "kept-draft");
      alias.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    });
    expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(false);
    expect(pollQuota).toBeDefined();
    now = startedAt + 60_000;
    await act(async () => { pollQuota!(); });
    expect(completeRefresh).toBeDefined();
    await act(async () => { completeRefresh!(snapshot(true)); });
    expect(container.querySelector<HTMLInputElement>("#cwi-edit-alias")!.value).toBe("kept-draft");
    expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    intervalSpy.mockRestore();
    clock.mockRestore();
  }
});
