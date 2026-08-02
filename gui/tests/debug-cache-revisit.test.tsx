import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Debug from "../src/pages/Debug";
import type { DebugSettings } from "../src/pages/debug-shared";
import { writeSessionListCache } from "../src/session-list-cache";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const API_BASE = "http://localhost";
const CACHE_KEY = `ocx.debug.settings.v1:${API_BASE}`;

const BASE_SETTINGS: DebugSettings = {
  enabled: true,
  usage: false,
  injection: false,
  claude: false,
  runtimeOverride: {},
  env: { debug: true, usage: false, injection: false, claude: false },
};

function installLayoutStubs(win: Window): void {
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() {
      return {
        x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
        toJSON() { return this; },
      };
    },
  });

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#debug" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
  testWindow.sessionStorage.clear();
  writeSessionListCache(CACHE_KEY, BASE_SETTINGS);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("a revisit with cached debug settings skips the loading skeleton and status line", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  type Gate = { resolve: () => void };
  const gate: { current: Gate | null } = { current: null };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/debug/logs")) return Response.json([]);
    if (!url.includes("/api/debug")) return new Response(null, { status: 404 });
    await new Promise<void>(resolve => { gate.current = { resolve }; });
    return Response.json(BASE_SETTINGS);
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Debug apiBase={API_BASE} /></LanguageProvider>);
  });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 0)); });

  expect(container.textContent).not.toContain("Loading debug settings");
  expect(container.querySelector(".data-surface-skeleton")).toBeNull();
  expect(container.querySelector(".switch")).not.toBeNull();

  await act(async () => {
    gate.current?.resolve();
    await Promise.resolve();
  });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 20)); });

  expect(container.textContent).not.toContain("Loading debug settings");

  await act(async () => { root.unmount(); });
  container.remove();
});
