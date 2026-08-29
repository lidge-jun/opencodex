import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Logs from "../src/pages/Logs";

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

function makeLog(id: string, ts: number) {
  return {
    requestId: id,
    timestamp: ts,
    model: "gpt-test",
    provider: "openai",
    status: 200,
    durationMs: 42,
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    displayMetrics: {
      tokPerSecond: { kind: "unavailable", reason: "invalid_duration" },
      cost: { kind: "unavailable", reason: "price_unmatched" },
    },
  };
}

const log1 = makeLog("r-aaa", 1_700_000_000_000);
const log2 = makeLog("r-bbb", 1_700_000_001_000);
const log3 = makeLog("r-ccc", 1_700_000_002_000);
const log4 = makeLog("r-ddd", 1_700_000_003_000);
const log5 = makeLog("r-eee", 1_700_000_004_000);

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#logs" });
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

async function mountLogs(): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Logs apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });
  return { root, container };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function findClearButton(container: HTMLElement): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find(
    btn => btn.textContent?.trim() === "Clear view",
  ) ?? null;
}

function findAutoScrollCheckbox(container: HTMLElement): HTMLInputElement | null {
  return [...container.querySelectorAll('input[type="checkbox"]')].find(
    input => input.closest("label")?.textContent?.includes("Auto-scroll"),
  ) as HTMLInputElement | null;
}

function hasLogRow(container: HTMLElement, id: string): boolean {
  return container.textContent?.includes(id) ?? false;
}

test("Logs: clear view hides existing logs", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log2, log1]);
    return jsonResponse([log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(hasLogRow(container, "r-aaa")).toBe(true);

  const btn = findClearButton(container)!;
  expect(btn).not.toBeNull();
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  expect(hasLogRow(container, "r-aaa")).toBe(false);
  expect(hasLogRow(container, "r-bbb")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: clear view boundary is requestId-based, not clock-based", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    // Server returns newest-first
    if (callCount <= 1) return jsonResponse([log3, log2, log1]);
    return jsonResponse([log4, log3, log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(hasLogRow(container, "r-ccc")).toBe(true);

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // All old entries hidden
  expect(hasLogRow(container, "r-aaa")).toBe(false);

  // New poll triggers re-fetch; boundary (r-ccc) is at index 1, slice(0,1)=[log4]
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  expect(hasLogRow(container, "r-ddd")).toBe(true);
  expect(hasLogRow(container, "r-aaa")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: new logs after clear view are shown", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log1]);
    return jsonResponse([log5, log4, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(hasLogRow(container, "r-aaa")).toBe(true);

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();
  expect(hasLogRow(container, "r-aaa")).toBe(false);

  // Poll again with new entries at front (newest first)
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  expect(hasLogRow(container, "r-ddd")).toBe(true);
  expect(hasLogRow(container, "r-eee")).toBe(true);
  expect(hasLogRow(container, "r-aaa")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: buffer count shows shown/total", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([log3, log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(container.textContent).toContain("3 / 3");

  await act(async () => { root.unmount(); });
});

test("Logs: buffer count updates after clear", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log3, log2, log1]);
    return jsonResponse([log4, log3, log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(container.textContent).toContain("3 / 3");

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // After clear, new poll brings 1 new entry (log4)
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  expect(container.textContent).toContain("1 / 4");

  await act(async () => { root.unmount(); });
});

test("Logs: auto-scroll checkbox toggles", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  const checkbox = findAutoScrollCheckbox(container)!;
  expect(checkbox).not.toBeNull();
  expect(checkbox.checked).toBe(true);

  await act(async () => { checkbox.closest("label")!.click(); });
  await flushMicrotasks();
  expect(checkbox.checked).toBe(false);

  await act(async () => { checkbox.closest("label")!.click(); });
  await flushMicrotasks();
  expect(checkbox.checked).toBe(true);

  await act(async () => { root.unmount(); });
});

test("Logs: empty list does not crash and shows empty state", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(container.textContent).toContain("No requests yet.");

  const btn = findClearButton(container);
  // Button should not exist or be absent when there's nothing to clear
  if (btn) {
    expect(btn.disabled).toBe(true);
  }

  await act(async () => { root.unmount(); });
});

test("Logs: clear view after apiBase change resets boundary", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(hasLogRow(container, "r-aaa")).toBe(true);

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();
  expect(hasLogRow(container, "r-aaa")).toBe(false);

  await act(async () => { root.unmount(); });
  clearClientResourceStoresForTests();

  let root2!: Root;
  const container2 = document.createElement("div");
  document.body.append(container2);
  await act(async () => {
    const { createRoot } = await import("react-dom/client");
    root2 = createRoot(container2);
    root2.render(
      <LanguageProvider>
        <Logs apiBase="http://localhost:10101" />
      </LanguageProvider>,
    );
  });
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  expect(hasLogRow(container2, "r-aaa")).toBe(true);

  await act(async () => { root2.unmount(); });
});
