import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
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
