import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Logs from "../src/pages/Logs";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const sampleLog = {
  requestId: "req-1",
  timestamp: 1_700_000_000_000,
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

const updatedLog = {
  ...sampleLog,
  requestId: "req-2",
  model: "gpt-updated",
};

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
      return {
        x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
        toJSON() { return this; },
      };
    },
  });

  class ResizeObserverStub {
    #cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
    observe(target: Element) {
      this.#cb(
        [{
          target,
          contentRect: {
            x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
            toJSON() { return this; },
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}

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
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
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
  // Let virtualizer observe + measure after first paint.
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });
  return { root, container };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceSilentRefresh(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  await flushMicrotasks();
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });
}

function clickRetry(container: HTMLElement): void {
  const retry = [...container.querySelectorAll("button")].find(btn => btn.textContent?.trim() === "Retry");
  expect(retry).toBeTruthy();
  retry!.click();
}

function expectTableLoaded(container: HTMLElement, model: string): void {
  expect(container.querySelector(".logs-table")).not.toBeNull();
  expect(container.textContent).not.toContain("No requests yet.");
  expect(container.textContent).not.toContain("Could not load request logs.");
  expect(container.textContent).toContain(model);
}

test("Logs: initial failure shows error; silent failure keeps it; retry then recovers", async () => {
  const calls: string[] = [];
  let mode: "fail" | "ok" = "fail";

  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (!url.includes("/api/logs")) return new Response(null, { status: 404 });
    if (mode === "fail") return jsonResponse({ error: "down" }, 503);
    return jsonResponse([sampleLog]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  expect(container.textContent).toContain("Could not load request logs.");
  expect(container.textContent).not.toContain("No requests yet.");
  expect(container.textContent).not.toMatch(/\bLoading\b/);
  const initialCalls = calls.filter(u => u.includes("/api/logs")).length;
  expect(initialCalls).toBeGreaterThanOrEqual(1);

  await advanceSilentRefresh();
  expect(container.textContent).toContain("Could not load request logs.");
  expect(container.textContent).not.toContain("No requests yet.");
  expect(calls.filter(u => u.includes("/api/logs")).length).toBeGreaterThan(initialCalls);

  mode = "ok";
  await act(async () => {
    clickRetry(container);
  });
  await flushMicrotasks();
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });

  expectTableLoaded(container, "gpt-test");

  await act(async () => { root.unmount(); });
});

test("Logs: silent failure after successful load keeps the table and does not toggle loading or empty state", async () => {
  let mode: "ok" | "fail" | "updated" = "ok";

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (!url.includes("/api/logs")) return new Response(null, { status: 404 });
    if (mode === "fail") return jsonResponse({ error: "down" }, 503);
    if (mode === "updated") return jsonResponse([updatedLog]);
    return jsonResponse([sampleLog]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expectTableLoaded(container, "gpt-test");

  mode = "fail";
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  const midFlightLoading = /\bLoading\b/.test(container.textContent ?? "");
  await flushMicrotasks();

  expect(midFlightLoading).toBe(false);
  expectTableLoaded(container, "gpt-test");
  expect(/\bLoading\b/.test(container.textContent ?? "")).toBe(false);

  mode = "updated";
  await advanceSilentRefresh();
  expectTableLoaded(container, "gpt-updated");

  await act(async () => { root.unmount(); });
});

test("Logs: silent success clears a previous error; later silent failure keeps the table", async () => {
  let mode: "fail" | "ok" | "fail-again" = "fail";

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (!url.includes("/api/logs")) return new Response(null, { status: 404 });
    if (mode === "ok") return jsonResponse([sampleLog]);
    return jsonResponse({ error: "down" }, 503);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expect(container.textContent).toContain("Could not load request logs.");

  mode = "ok";
  await advanceSilentRefresh();
  expectTableLoaded(container, "gpt-test");

  mode = "fail-again";
  await advanceSilentRefresh();
  expectTableLoaded(container, "gpt-test");

  await act(async () => { root.unmount(); });
});

test("Logs: disabling auto-refresh stops scheduled requests", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (!url.includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([sampleLog]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  const afterInitial = urls.filter(u => u.includes("/api/logs")).length;
  expect(afterInitial).toBe(1);

  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox?.checked).toBe(true);
  const autoRefreshLabel = checkbox!.closest("label");
  expect(autoRefreshLabel).not.toBeNull();
  await act(async () => {
    autoRefreshLabel!.click();
  });
  await flushMicrotasks();
  expect(checkbox!.checked).toBe(false);

  // Effect re-runs once when autoRefresh flips (non-silent fetch), then must stop polling.
  const afterDisable = urls.filter(u => u.includes("/api/logs")).length;
  expect(afterDisable).toBeGreaterThanOrEqual(afterInitial);
  expect(afterDisable).toBeLessThanOrEqual(afterInitial + 1);

  await act(async () => {
    jest.advanceTimersByTime(6000);
  });
  await flushMicrotasks();

  expect(urls.filter(u => u.includes("/api/logs")).length).toBe(afterDisable);

  await act(async () => { root.unmount(); });
});

test("Logs: switching to the Debug tab stops scheduled log requests", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/logs")) return jsonResponse([sampleLog]);
    return jsonResponse({});
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  const afterInitial = urls.filter(u => u.includes("/api/logs")).length;
  expect(afterInitial).toBe(1);

  await act(async () => {
    container.querySelector<HTMLButtonElement>("#logs-tab-debug")!.click();
  });
  await flushMicrotasks();

  // happy-dom may not emit hashchange on assignment; mirror the page listener.
  if (container.querySelector("#logs-tab-debug")?.getAttribute("aria-selected") !== "true") {
    await act(async () => {
      window.location.hash = "logs/debug";
      window.dispatchEvent(new testWindow.Event("hashchange"));
    });
    await flushMicrotasks();
  }

  expect(container.querySelector("#logs-tab-debug")?.getAttribute("aria-selected")).toBe("true");

  await act(async () => {
    jest.advanceTimersByTime(6000);
  });
  await flushMicrotasks();

  expect(urls.filter(u => u.includes("/api/logs")).length).toBe(afterInitial);

  await act(async () => { root.unmount(); });
});
