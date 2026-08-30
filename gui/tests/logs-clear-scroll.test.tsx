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

// ─── RequestId-based clear tests: identity, eviction, filter, buffer counts ───

test("Logs: clear works for entries with unique requestIds", async () => {
  // All entries now have required requestId from the server (ocx-${randomBytes(16).hex}).
  // This replaces the old "entries without requestId" test.
  const entry1 = makeLog("r-uid-1", 1_700_000_000_000);
  const entry2 = makeLog("r-uid-2", 1_700_000_001_000);
  const entry3 = makeLog("r-uid-3", 1_700_000_005_000);

  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([entry2, entry1]);
    return jsonResponse([entry3, entry2, entry1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(hasLogRow(container, "r-uid-1")).toBe(true);
  expect(hasLogRow(container, "r-uid-2")).toBe(true);

  const btn = findClearButton(container)!;
  expect(btn).not.toBeNull();
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // All old entries hidden
  expect(hasLogRow(container, "r-uid-1")).toBe(false);
  expect(hasLogRow(container, "r-uid-2")).toBe(false);

  // Advance timer so poll fires and brings back entries
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  // entry3 is new (different requestId) → visible; old entries hidden
  expect(hasLogRow(container, "r-uid-3")).toBe(true);
  expect(hasLogRow(container, "r-uid-1")).toBe(false);
  expect(hasLogRow(container, "r-uid-2")).toBe(false);
  expect(container.textContent).toContain("1 / 3");

  await act(async () => { root.unmount(); });
});

test("Logs: entries with different requestIds are independently cleared", async () => {
  const entry1 = makeLog("r-mix-1", 1_700_000_000_000);
  const entry2 = makeLog("r-mix-2", 1_700_000_001_000);

  // After clear: one old (entry2) + two brand-new
  const newLog1 = makeLog("r-new1", 1_700_000_005_000);
  const newLog2 = makeLog("r-new2", 1_700_000_006_000);

  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([entry2, entry1]);
    return jsonResponse([newLog2, newLog1, entry2, entry1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(hasLogRow(container, "r-mix-1")).toBe(true);
  expect(hasLogRow(container, "r-mix-2")).toBe(true);

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // Both old entries should be hidden
  expect(hasLogRow(container, "r-mix-1")).toBe(false);
  expect(hasLogRow(container, "r-mix-2")).toBe(false);

  // New poll
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  // New entries visible, old still hidden
  expect(hasLogRow(container, "r-new1")).toBe(true);
  expect(hasLogRow(container, "r-new2")).toBe(true);
  expect(hasLogRow(container, "r-mix")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: same timestamp different requestIds are independent", async () => {
  // Two logs with IDENTICAL timestamp but different requestIds
  const logA = {
    requestId: "r-same-ts-1",
    timestamp: 1_700_000_000_000,
    model: "model-alpha",
    provider: "provider-x",
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    displayMetrics: {
      tokPerSecond: { kind: "unavailable" as const, reason: "invalid_duration" },
      cost: { kind: "unavailable" as const, reason: "price_unmatched" },
    },
  };
  const logB = {
    requestId: "r-same-ts-2",
    timestamp: 1_700_000_000_000, // same timestamp
    model: "model-beta",
    provider: "provider-y",
    status: 500,
    durationMs: 99,
    usageStatus: "reported",
    usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
    displayMetrics: {
      tokPerSecond: { kind: "unavailable" as const, reason: "invalid_duration" },
      cost: { kind: "unavailable" as const, reason: "price_unmatched" },
    },
  };

  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([logA, logB]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  // Both shown
  expect(hasLogRow(container, "model-alpha")).toBe(true);
  expect(hasLogRow(container, "model-beta")).toBe(true);

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // Both hidden despite same timestamp (different requestIds)
  expect(hasLogRow(container, "model-alpha")).toBe(false);
  expect(hasLogRow(container, "model-beta")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: evicted boundary entries do not cause old logs to reappear", async () => {
  // Load 5 logs newest-first: E, D, C, B, A
  const logA = makeLog("r-a-old", 1_700_000_000_000);
  const logB = makeLog("r-b-old", 1_700_000_001_000);
  const logC = makeLog("r-c-still", 1_700_000_002_000);
  const logD = makeLog("r-d-still", 1_700_000_003_000);
  const logE = makeLog("r-e-still", 1_700_000_004_000);

  // New entries
  const logF = makeLog("r-f-new", 1_700_000_005_000);
  const logG = makeLog("r-g-new", 1_700_000_006_000);

  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    // Initial load: E D C B A (newest first)
    if (callCount <= 1) return jsonResponse([logE, logD, logC, logB, logA]);
    // After clear: F G C D E (A and B fell off the server buffer)
    return jsonResponse([logG, logF, logC, logD, logE]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  // All 5 shown initially
  expect(hasLogRow(container, "r-a-old")).toBe(true);
  expect(hasLogRow(container, "r-e-still")).toBe(true);

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // All 5 hidden
  expect(hasLogRow(container, "r-a-old")).toBe(false);
  expect(hasLogRow(container, "r-c-still")).toBe(false);
  expect(hasLogRow(container, "r-e-still")).toBe(false);

  // New poll returns F G C D E (A, B gone from server)
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  // F and G are NEW → visible
  expect(hasLogRow(container, "r-f-new")).toBe(true);
  expect(hasLogRow(container, "r-g-new")).toBe(true);

  // C, D, E are STILL in the cleared set → hidden despite reappearing from server
  expect(hasLogRow(container, "r-c-still")).toBe(false);
  expect(hasLogRow(container, "r-d-still")).toBe(false);
  expect(hasLogRow(container, "r-e-still")).toBe(false);

  // A, B are gone from server entirely → hidden
  expect(hasLogRow(container, "r-a-old")).toBe(false);
  expect(hasLogRow(container, "r-b-old")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: filter change after clear does not restore cleared logs", async () => {
  // One log with surface "claude", one without surface (matches "codex" filter)
  const logClaude = {
    requestId: "r-surf-claude",
    timestamp: 1_700_000_000_000,
    model: "claude-test",
    provider: "anthropic",
    surface: "claude" as const,
    status: 200,
    durationMs: 50,
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    displayMetrics: {
      tokPerSecond: { kind: "unavailable", reason: "invalid_duration" },
      cost: { kind: "unavailable", reason: "price_unmatched" },
    },
  };
  const logCodex = {
    requestId: "r-surf-codex",
    timestamp: 1_700_000_001_000,
    model: "codex-test",
    provider: "openai",
    // no surface → matches "codex" filter
    status: 200,
    durationMs: 30,
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    displayMetrics: {
      tokPerSecond: { kind: "unavailable", reason: "invalid_duration" },
      cost: { kind: "unavailable", reason: "price_unmatched" },
    },
  };

  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([logClaude, logCodex]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  // Both shown with "all" filter
  expect(hasLogRow(container, "r-surf-claude")).toBe(true);
  expect(hasLogRow(container, "r-surf-codex")).toBe(true);

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // Both hidden after clear
  expect(hasLogRow(container, "r-surf-claude")).toBe(false);
  expect(hasLogRow(container, "r-surf-codex")).toBe(false);

  // Change surface filter to "Claude" — should NOT bring back cleared logs
  const claudeFilterBtn = [...container.querySelectorAll('button[role="radio"]')].find(
    b => b.textContent?.trim() === "Claude",
  )!;
  expect(claudeFilterBtn).not.toBeNull();
  await act(async () => { claudeFilterBtn.click(); });
  await flushMicrotasks();

  // Still hidden — clear takes precedence over surface filter
  expect(hasLogRow(container, "r-surf-claude")).toBe(false);
  expect(hasLogRow(container, "r-surf-codex")).toBe(false);

  // Switch to "Codex" filter too — still hidden
  const codexFilterBtn = [...container.querySelectorAll('button[role="radio"]')].find(
    b => b.textContent?.trim() === "Codex",
  )!;
  expect(codexFilterBtn).not.toBeNull();
  await act(async () => { codexFilterBtn.click(); });
  await flushMicrotasks();

  expect(hasLogRow(container, "r-surf-codex")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: buffer count after clear shows 0 shown", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([log3, log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(container.textContent).toContain("3 / 3");

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // After clear: 0 shown, 3 total
  expect(container.textContent).toContain("0 / 3");

  await act(async () => { root.unmount(); });
});

test("Logs: buffer count shows correct shown after new entries arrive post-clear", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log2, log1]);
    // After clear: 1 old (log1 still in buffer) + 2 new (log4, log5)
    return jsonResponse([log5, log4, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(container.textContent).toContain("2 / 2");

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // After clear: 0 shown, 2 total
  expect(container.textContent).toContain("0 / 2");

  // Advance timer so poll fires with 3 entries (1 old + 2 new)
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  // 2 new visible (log4, log5), 3 total in buffer
  expect(container.textContent).toContain("2 / 3");

  await act(async () => { root.unmount(); });
});

// ─── RequestId-based clear view identity tests ───

test("Logs: clear hides two entries with different requestIds", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(container.textContent).toContain("2 / 2");

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // Both hidden: 0 shown, 2 total
  expect(container.textContent).toContain("0 / 2");
  expect(hasLogRow(container, "r-aaa")).toBe(false);
  expect(hasLogRow(container, "r-bbb")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: after clear, new entry with different requestId is visible", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log2, log1]);
    return jsonResponse([log5, log2, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(container.textContent).toContain("2 / 2");

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();
  expect(container.textContent).toContain("0 / 2");

  // Poll — log5 is new (different requestId)
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  // 1 visible (log5), 3 total
  expect(container.textContent).toContain("1 / 3");
  expect(hasLogRow(container, "r-eee")).toBe(true);
  expect(hasLogRow(container, "r-aaa")).toBe(false);
  expect(hasLogRow(container, "r-bbb")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: multiple new entries arrive at once after clear — all visible", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log1]);
    return jsonResponse([log5, log4, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(container.textContent).toContain("1 / 1");

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();
  expect(container.textContent).toContain("0 / 1");

  // Poll — log4 and log5 are new
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  // 2 visible (log4, log5), 3 total
  expect(container.textContent).toContain("2 / 3");
  expect(hasLogRow(container, "r-ddd")).toBe(true);
  expect(hasLogRow(container, "r-eee")).toBe(true);
  expect(hasLogRow(container, "r-aaa")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: entries with different requestIds are independently cleared", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log3, log1]);
    const newLog = makeLog("r-new-1", 1_700_000_005_000);
    return jsonResponse([newLog, log3, log1]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(hasLogRow(container, "r-aaa")).toBe(true);
  expect(hasLogRow(container, "r-ccc")).toBe(true);
  expect(container.textContent).toContain("2 / 2");

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();
  expect(container.textContent).toContain("0 / 2");

  // Poll — new entry visible, old ones hidden
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  expect(hasLogRow(container, "r-new-1")).toBe(true);
  expect(hasLogRow(container, "r-aaa")).toBe(false);
  expect(hasLogRow(container, "r-ccc")).toBe(false);
  expect(container.textContent).toContain("1 / 3");

  await act(async () => { root.unmount(); });
});

test("Logs: buffer eviction — old entries stay hidden, new entries visible", async () => {
  let callCount = 0;
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    callCount++;
    if (callCount <= 1) return jsonResponse([log2, log1]);
    // Server evicted log1 and log2, returns only new log5
    return jsonResponse([log5]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(container.textContent).toContain("2 / 2");

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();
  expect(container.textContent).toContain("0 / 2");

  // Poll — server evicted old entries, only log5 remains
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flushMicrotasks();
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  // log5 has a different requestId from cleared entries → visible
  expect(container.textContent).toContain("1 / 1");
  expect(hasLogRow(container, "r-eee")).toBe(true);

  await act(async () => { root.unmount(); });
});

test("Logs: entries with same timestamp but different requestIds are independent", async () => {
  const logSameTime1 = makeLog("r-same-ts-1", 1_700_000_000_000);
  const logSameTime2 = makeLog("r-same-ts-2", 1_700_000_000_000);

  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([logSameTime1, logSameTime2]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(container.textContent).toContain("2 / 2");

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();

  // Both have unique requestIds → both hidden independently
  expect(hasLogRow(container, "r-same-ts-1")).toBe(false);
  expect(hasLogRow(container, "r-same-ts-2")).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Logs: filter switch does not restore cleared entries", async () => {
  const logA = {
    requestId: "r-filt-a", timestamp: 1_700_000_000_000, model: "m-a", provider: "p-a",
    surface: "claude" as const, status: 200, durationMs: 10,
    usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    displayMetrics: { tokPerSecond: { kind: "unavailable" as const, reason: "x" }, cost: { kind: "unavailable" as const, reason: "x" } },
  };
  const logB = {
    requestId: "r-filt-b", timestamp: 1_700_000_001_000, model: "m-b", provider: "p-b",
    status: 200, durationMs: 10,
    usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    displayMetrics: { tokPerSecond: { kind: "unavailable" as const, reason: "x" }, cost: { kind: "unavailable" as const, reason: "x" } },
  };

  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([logA, logB]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();
  expect(container.textContent).toContain("0 / 2");

  // Switch to "Claude" surface filter — cleared entries stay hidden
  const claudeBtn = [...container.querySelectorAll('button[role="radio"]')].find(
    b => b.textContent?.trim() === "Claude",
  );
  if (claudeBtn) {
    await act(async () => { claudeBtn.click(); });
    await flushMicrotasks();
    expect(hasLogRow(container, "r-filt-a")).toBe(false);
  }

  await act(async () => { root.unmount(); });
});

test("Logs: resourceKey change resets cleared entries", async () => {
  const logA = makeLog("r-reset-a", 1_700_000_000_000);

  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([logA]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  const btn = findClearButton(container)!;
  await act(async () => { btn.click(); });
  await flushMicrotasks();
  expect(hasLogRow(container, "r-reset-a")).toBe(false);

  // Remount with different apiBase (different resourceKey)
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
        <Logs apiBase="http://localhost:9999" />
      </LanguageProvider>,
    );
  });
  await act(async () => { jest.advanceTimersByTime(0); await Promise.resolve(); });

  // Cleared ids reset → same requestId entry visible again
  expect(hasLogRow(container2, "r-reset-a")).toBe(true);

  await act(async () => { root2.unmount(); });
});
