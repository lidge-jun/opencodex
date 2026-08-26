import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Startup from "../src/pages/Startup";
import { writeSessionListCache } from "../src/session-list-cache";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const API_BASE = "http://localhost";
const CACHE_KEY = `ocx.startup.page.v1:${API_BASE}`;

function atRiskHealth() {
  return {
    status: "at-risk",
    routingKind: "opencodex-local",
    routingInjected: true,
    localRoutingDependency: true,
    autostartEnabled: false,
    rebootSafe: false,
    protection: "none",
    serviceInstalled: false,
    serviceViable: false,
    serviceEnabled: false,
    serviceRunning: false,
    serviceStale: false,
    serviceConflict: false,
    serviceSupported: true,
    shimInstalled: false,
    shimHealthy: false,
    shimCoverage: "none",
    platform: "darwin",
    recommendedCommand: "ocx service install",
    diagnosticStale: false,
    commands: { installService: "ocx service install", repairService: "ocx service repair", installShim: "ocx shim install", restoreNative: "ocx restore" },
  };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow.sessionStorage.clear();
  writeSessionListCache(CACHE_KEY, {
    data: atRiskHealth(),
    warning: null,
    fix: null,
    tray: null,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("a revisit with session cache keeps Action required visible without a loading spinner", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  type Gate = { resolve: () => void };
  const gate: { current: Gate | null } = { current: null };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/settings")) return Response.json({ codexRuntime: {} });
    if (!url.includes("/api/startup-health")) return new Response(null, { status: 404 });
    await new Promise<void>(resolve => { gate.current = { resolve }; });
    return Response.json(atRiskHealth());
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Startup apiBase={API_BASE} /></LanguageProvider>);
  });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 0)); });

  expect(container.textContent).toContain("Action required");
  expect(container.textContent).not.toContain("Checking startup protection");

  await act(async () => {
    gate.current?.resolve();
    await Promise.resolve();
  });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 20)); });

  expect(container.textContent).toContain("Action required");
  expect(container.textContent).not.toContain("Checking startup protection");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a superseded settings response cannot overwrite newer Startup cache", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  let settingsCalls = 0;
  let resolveStaleSettings!: (response: Response) => void;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/startup-health")) return Response.json(atRiskHealth());
    if (!url.includes("/api/settings")) return new Response(null, { status: 404 });
    settingsCalls += 1;
    if (settingsCalls === 1) {
      return await new Promise<Response>(resolve => { resolveStaleSettings = resolve; });
    }
    return Response.json({ codexRuntime: { version: "fresh", newerAvailable: { version: "new" } } });
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Startup apiBase={API_BASE} /></LanguageProvider>);
  });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 20)); });

  const refresh = Array.from(container.querySelectorAll("button"))
    .find(button => button.textContent?.includes("Refresh"));
  expect(refresh).toBeDefined();
  await act(async () => { refresh?.click(); });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 20)); });
  expect(settingsCalls).toBe(2);
  expect(testWindow.sessionStorage.getItem(CACHE_KEY)).toContain("fresh");

  await act(async () => {
    resolveStaleSettings(Response.json({ codexRuntime: { version: "stale", newerAvailable: { version: "new" } } }));
    await new Promise<void>(r => testWindow.setTimeout(r, 20));
  });

  expect(testWindow.sessionStorage.getItem(CACHE_KEY)).toContain("fresh");
  expect(testWindow.sessionStorage.getItem(CACHE_KEY)).not.toContain("stale");

  await act(async () => { root.unmount(); });
  container.remove();
});
