/**
 * Tests for auto-scroll behavior using the virtualizer API.
 *
 * We mock @tanstack/react-virtual to record scrollToIndex calls and verify
 * they happen with the correct arguments at the right moments.
 */
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

// --- Virtualizer mock ---
let scrollToIndexCalls: Array<{ index: number; options?: Record<string, unknown> }> = [];
let mockCount = 0;

jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => {
    mockCount = opts.count;
    return {
      getVirtualItems: () => Array.from({ length: Math.min(opts.count, 30) }, (_, i) => ({
        index: i, start: i * 44, end: (i + 1) * 44, key: i,
      })),
      getTotalSize: () => opts.count * 44,
      scrollToIndex: (index: number, options?: Record<string, unknown>) => {
        scrollToIndexCalls.push({ index, options });
      },
      scrollElement: null,
    };
  },
}));

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
  scrollToIndexCalls = [];
  mockCount = 0;
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

function findAutoScrollCheckbox(container: HTMLElement): HTMLInputElement | null {
  return [...container.querySelectorAll('input[type="checkbox"]')].find(
    input => input.closest("label")?.textContent?.includes("Auto-scroll"),
  ) as HTMLInputElement | null;
}

// --- Tests ---

test("Virtualizer: scrollToIndex called with index=filteredLogs.length-1, align=end on new entries", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log1]);
    return jsonResponse([log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(mockCount).toBe(1);

  scrollToIndexCalls = [];

  // Trigger next poll with new entry
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  expect(mockCount).toBe(2);
  // scrollToIndex should have been called with the last index
  const lastCall = scrollToIndexCalls[scrollToIndexCalls.length - 1];
  expect(lastCall).toBeDefined();
  expect(lastCall.index).toBe(1); // filteredLogs.length - 1 = 2 - 1 = 1
  expect(lastCall.options).toEqual({ align: "end" });

  await act(async () => { root.unmount(); });
});

test("Virtualizer: auto-scroll OFF prevents scrollToIndex on new entries", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log1]);
    return jsonResponse([log3, log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  // Turn off auto-scroll
  const checkbox = findAutoScrollCheckbox(container)!;
  await act(async () => { checkbox.closest("label")!.click(); });
  await flushMicrotasks();

  scrollToIndexCalls = [];

  // Trigger next poll with new entries
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  // scrollToIndex should NOT have been called
  expect(scrollToIndexCalls).toHaveLength(0);

  await act(async () => { root.unmount(); });
});

test("Virtualizer: empty list does not call scrollToIndex(-1)", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([]);
  }) as typeof fetch;

  scrollToIndexCalls = [];
  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(mockCount).toBe(0);
  expect(scrollToIndexCalls).toHaveLength(0);

  await act(async () => { root.unmount(); });
});

test("Virtualizer: clear with no visible logs does not scroll", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  // Clear view — all logs hidden
  const clearBtn = [...container.querySelectorAll("button")].find(
    btn => btn.textContent?.trim() === "Clear view",
  )!;
  await act(async () => { clearBtn.click(); });
  await flushMicrotasks();

  scrollToIndexCalls = [];

  // No new entries arrive — filteredLogs.length stays 0
  expect(mockCount).toBe(0);
  expect(scrollToIndexCalls).toHaveLength(0);

  await act(async () => { root.unmount(); });
});

test("Virtualizer: re-enabling auto-scroll does not immediately scroll (waits for next entry)", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  const checkbox = findAutoScrollCheckbox(container)!;
  // Turn off
  await act(async () => { checkbox.closest("label")!.click(); });
  await flushMicrotasks();

  scrollToIndexCalls = [];

  // Turn back on — should NOT immediately scroll
  await act(async () => { checkbox.closest("label")!.click(); });
  await flushMicrotasks();

  expect(scrollToIndexCalls).toHaveLength(0);

  await act(async () => { root.unmount(); });
});

test("Virtualizer: scrollToIndex index equals filteredLogs.length minus one", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([]);
    return jsonResponse([log5, log4, log3, log2, log1]);
  }) as typeof fetch;

  scrollToIndexCalls = [];
  const { root, container } = await mountLogs();
  await flushMicrotasks();

  // Trigger next poll
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  expect(mockCount).toBe(5);
  const lastCall = scrollToIndexCalls[scrollToIndexCalls.length - 1];
  expect(lastCall).toBeDefined();
  expect(lastCall.index).toBe(4); // 5 - 1

  await act(async () => { root.unmount(); });
});
