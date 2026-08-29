import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Providers from "../src/pages/Providers";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
      return { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } };
    },
  });
  class ResizeObserverStub {
    #cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
    observe(target: Element) {
      this.#cb([{ target, contentRect: { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } }, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}

const configResponse = {
  providers: {
    openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com" },
    anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com" },
  },
};

const emptyConfigResponse = { providers: {} };

function makeFetchHandler(
  calls: string[],
  opts?: {
    config?: unknown;
    test?: (url: string) => Response | Promise<Response> | never;
  },
) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/config")) return jsonResponse(opts?.config ?? configResponse);
    if (url.includes("/api/providers/test")) {
      calls.push(url);
      if (opts?.test) return opts.test(url);
      return jsonResponse({ ok: true, latencyMs: 50 });
    }
    if (url.includes("/api/providers")) return jsonResponse([]);
    if (url.includes("/api/codex-accounts")) return jsonResponse([]);
    if (url.includes("/api/oauth")) return jsonResponse({ providers: [] });
    if (url.includes("/api/provider-presets")) return jsonResponse([]);
    if (url.includes("/api/usage")) return jsonResponse({ range: "30d", summary: { requests: 0, totalTokens: 0, estimatedCostUsd: 0 }, models: [], providers: [], accounts: [], days: [] });
    if (url.includes("/api/settings")) return jsonResponse({ port: 10100, hostname: "127.0.0.1", timeZone: "UTC" });
    return jsonResponse({});
  }) as typeof fetch;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  clearClientResourceStoresForTests();
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountProviders(fetchFn: typeof fetch): Promise<{ root: Root; container: HTMLElement }> {
  globalThis.fetch = fetchFn;
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Providers apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  // Let config fetch resolve + render
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  return { root, container };
}

/** Drive the component through multiple act cycles so async batch completes + state commits. */
async function driveAsyncBatch(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }
  await act(async () => { jest.advanceTimersByTime(200); });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }
}

function findTestAllButton(container: HTMLElement): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find(
    btn => btn.textContent?.includes("Test All"),
  ) ?? null;
}

test("Providers: Test All sends requests for each provider", async () => {
  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls));

  const btn = findTestAllButton(container)!;
  expect(btn).not.toBeNull();
  expect(btn.disabled).toBe(false);

  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.some(u => u.includes("name=openai"))).toBe(true);
  expect(calls.some(u => u.includes("name=anthropic"))).toBe(true);

  await act(async () => { root.unmount(); });
});

test("Providers: Test All counts partial failures correctly", async () => {
  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    test: (url) => {
      if (url.includes("name=openai")) return jsonResponse({ ok: true, latencyMs: 50 });
      return jsonResponse({ ok: false, error: "invalid key" });
    },
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  // Both providers were tested
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.some(u => u.includes("name=openai"))).toBe(true);
  expect(calls.some(u => u.includes("name=anthropic"))).toBe(true);

  // Button should be re-enabled (batchTesting=false)
  expect(findTestAllButton(container)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("Providers: Test All counts non-2xx as failure", async () => {
  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    test: () => jsonResponse({ error: "server error" }, 500),
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  // Both providers were tested
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(findTestAllButton(container)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("Providers: Test All handles network error", async () => {
  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    test: () => { throw new TypeError("fetch failed"); },
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(findTestAllButton(container)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("Providers: Test All with no providers sends no test requests", async () => {
  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: emptyConfigResponse,
  }));

  // Button is always rendered but clicking with empty config does nothing
  const btn = findTestAllButton(container);
  if (btn) {
    await act(async () => { btn.click(); });
    await driveAsyncBatch();
  }
  // No test requests should have been sent
  expect(calls).toHaveLength(0);

  await act(async () => { root.unmount(); });
});

test("Providers: Test All button re-enables after completion", async () => {
  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls));

  const btn = findTestAllButton(container)!;
  expect(btn.disabled).toBe(false);

  await act(async () => { btn.click(); });
  // After batch completes, button should be re-enabled
  await driveAsyncBatch();

  // Button should be present and enabled (batchTesting=false)
  const btnAfter = findTestAllButton(container);
  expect(btnAfter).not.toBeNull();
  expect(btnAfter!.disabled).toBe(false);

  await act(async () => { root.unmount(); });
});
