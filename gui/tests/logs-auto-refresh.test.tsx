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
  // Logs reads through the shared resource layer now, and that cache is module-level: without
  // this, one test's rows leak into the next one's cold mount and suppress its request.
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

async function mountLogs(apiBase = "http://localhost"): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Logs apiBase={apiBase} />
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

async function advanceSilentRefresh(ms = 2000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 2000) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(2000, ms - elapsed));
    });
    await flushMicrotasks();
    await act(async () => {
      jest.advanceTimersByTime(0);
      await Promise.resolve();
    });
  }
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

test("Logs: renders the ordered ten-column layout schema", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([sampleLog]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  const colgroup = container.querySelector(".logs-table > colgroup");
  expect(colgroup).not.toBeNull();
  expect([...colgroup!.children].map(column => column.className)).toEqual([
    "logs-col-time",
    "logs-col-tokens",
    "logs-col-rate",
    "logs-col-cost",
    "logs-col-model",
    "logs-col-effort",
    "logs-col-provider",
    "logs-col-status",
    "logs-col-request",
    "logs-col-duration",
  ]);

  await act(async () => { root.unmount(); });
});

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

  await advanceSilentRefresh(6000);
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
  await advanceSilentRefresh(6000);
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
  await advanceSilentRefresh(6000);
  expectTableLoaded(container, "gpt-test");

  mode = "fail-again";
  await advanceSilentRefresh();
  expectTableLoaded(container, "gpt-test");

  await act(async () => { root.unmount(); });
});

// One failed tick on a two-second poll is noise worth swallowing, but an outage that never
// recovers must not leave stale rows reading as current forever. Three consecutive failures
// is the point where silence becomes a lie.
test("Logs: a sustained poll outage says the rows are stale, and a recovery clears it", async () => {
  const calls: string[] = [];
  let mode: "ok" | "fail" = "ok";

  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (!url.includes("/api/logs")) return new Response(null, { status: 404 });
    if (mode === "fail") return jsonResponse({ error: "down" }, 503);
    return jsonResponse([sampleLog]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  expectTableLoaded(container, "gpt-test");

  mode = "fail";
  // Below the limit the rows stay quiet: a single dropped tick is not worth an alarm.
  await advanceSilentRefresh();
  expect(container.textContent).not.toContain("Could not load request logs.");
  const afterFirstFailure = calls.filter(u => u.includes("/api/logs")).length;
  await advanceSilentRefresh();
  expect(calls.filter(u => u.includes("/api/logs"))).toHaveLength(afterFirstFailure);
  await advanceSilentRefresh(4000);
  expect(container.textContent).not.toContain("Could not load request logs.");

  // Third consecutive failure: the outage is not transient, so say so while keeping the rows.
  await advanceSilentRefresh(10000);
  expect(container.textContent).toContain("Could not load request logs.");
  expect(container.querySelector(".logs-table")).not.toBeNull();
  expect(container.textContent).toContain("gpt-test");
  expect(container.textContent).not.toContain("No requests yet.");

  // A recovered poll must retract the notice rather than leaving a permanent scar.
  mode = "ok";
  await advanceSilentRefresh(20000);
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

test("Logs: attempt details render exact reasoning wire values without legacy placeholders", async () => {
  const attemptsLog = {
    ...sampleLog,
    requestedEffort: "max->high",
    effectiveEffort: "high",
    reasoningWireField: "reasoning_effort",
    reasoningWireValue: "high",
    attempts: [
      {
        ordinal: 1,
        provider: "budget-provider",
        model: "budget-model",
        adapter: "openai-chat",
        status: 503,
        durationMs: 10,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
        requestedEffort: "minimal",
        effectiveEffort: "low",
        reasoningWireField: "thinking_budget",
        reasoningWireValue: 0,
      },
      {
        ordinal: 2,
        provider: "toggle-provider",
        model: "toggle-model",
        adapter: "openai-chat",
        status: 503,
        durationMs: 11,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
        requestedEffort: "high",
        effectiveEffort: "enabled",
        reasoningWireField: "thinking.type",
        reasoningWireValue: "enabled",
      },
      {
        ordinal: 3,
        provider: "legacy-provider",
        model: "legacy-model",
        adapter: "openai-chat",
        status: 200,
        durationMs: 12,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
      },
    ],
  };
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([attemptsLog]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();
  const overviewReasoning = container.querySelector<HTMLElement>(".log-reasoning-cell");
  expect(overviewReasoning?.textContent).toContain("max → high");
  expect(overviewReasoning?.textContent).not.toContain("max → high → high");
  // The wire field left the table cell (it repeated the label and overflowed the column);
  // it stays on the cell title and in the attempt rows below.
  expect(overviewReasoning?.textContent).not.toContain("reasoning_effort=high");
  expect(overviewReasoning?.getAttribute("title")).toBe("reasoning_effort=high");
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".log-detail-btn")!.click();
  });

  const rows = [...container.querySelectorAll<HTMLTableRowElement>(".log-detail-attempts tbody tr")];
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).toContain("minimal → low (thinking_budget=0)");
  expect(rows[1]?.textContent).toContain("high → enabled (thinking.type=enabled)");
  expect(rows[2]?.textContent).toContain("legacy-model");
  expect(rows[2]?.querySelectorAll("br")).toHaveLength(1);
  expect(rows[2]?.textContent).not.toContain("undefined");

  await act(async () => { root.unmount(); });
});

test("Logs: inside-card clicks keep the detail dialog open; backdrop dismiss closes it", async () => {
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([sampleLog]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  const detailBtn = container.querySelector<HTMLButtonElement>(".log-detail-btn")!;
  await act(async () => { detailBtn.click(); });
  expect(container.querySelector("dialog")).not.toBeNull();

  const card = container.querySelector<HTMLElement>(".log-detail-card")!;
  expect(card).not.toBeNull();
  await act(async () => { card.click(); });
  expect(container.querySelector("dialog")).not.toBeNull();

  const backdrop = container.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!;
  expect(backdrop).not.toBeNull();
  expect(backdrop.tabIndex).toBe(-1);

  await act(async () => { backdrop.click(); });
  expect(container.querySelector("dialog")).toBeNull();

  await act(async () => { root.unmount(); });
});

// #2157: the Codex App sends helper requests on every message and turn completion. That
// traffic is the App's, not ours -- what is ours is making an INTERCEPTED one identifiable, so
// the reporter can tell recurring helper spend from their own work.
//
// "Intercepted", deliberately. A helper request that was not intercepted carries no marker and
// is indistinguishable from ordinary traffic here, so the filter must not promise more.
test("Logs: an intercepted helper row is badged and filterable", async () => {
  const interceptedLog = {
    ...sampleLog,
    requestId: "req-shadow",
    model: "grok-4.6",
    shadowCallRewrittenFrom: "gpt-5.6-luna",
  };
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (!url.includes("/api/logs")) return new Response(null, { status: 404 });
    return jsonResponse([interceptedLog, sampleLog]);
  }) as typeof fetch;

  const { root, container } = await mountLogs();
  await flushMicrotasks();

  // The badge names the ORIGINAL helper model, which is the attribution that was being lost.
  const tableText = () => container.querySelector(".logs-table tbody")?.textContent ?? "";
  expect(tableText()).toContain("I · gpt-5.6-luna");
  expect(tableText()).toContain("gpt-test");

  const toggle = [...container.querySelectorAll("input[type=checkbox]")].find(
    input => input.closest("label")?.textContent?.includes("Intercepted helpers only"),
  ) as HTMLInputElement | undefined;
  expect(toggle).toBeDefined();

  await act(async () => { toggle!.click(); });
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });

  // Filtered: the marked row stays, the ordinary one goes.
  expect(tableText()).toContain("I · gpt-5.6-luna");
  expect(tableText()).not.toContain("gpt-test");

  await act(async () => { toggle!.click(); });
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });

  expect(tableText()).toContain("gpt-test");

  await act(async () => { root.unmount(); });
});

// Rich-filter integration uses the same resource/virtualizer harness as the polling tests.
function visibleRequestIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".logs-table tbody .log-reqid")].map(node => node.textContent ?? "");
}

async function changeLogSelect(container: HTMLElement, label: string, value: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(`.logs-filter-container select[aria-label="${label}"]`);
  expect(select).not.toBeNull();
  await act(async () => {
    select!.value = value;
    select!.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  await flushMicrotasks();
}

async function enterConversation(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('.logs-filter-container input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  await flushMicrotasks();
  expect(input.value).toBe(value);
}

function serveLogSnapshot(readRows: () => unknown[], onRequest?: () => void): void {
  globalThis.fetch = (async input => {
    const url = String(input);
    if (url.includes("/api/settings")) return jsonResponse({ timeZone: "UTC" });
    if (!url.includes("/api/logs")) return jsonResponse({});
    onRequest?.();
    return jsonResponse(readRows());
  }) as typeof fetch;
}

// Happy DOM owns window timers separately. Route only the filter's interval into
// Bun's existing fake clock; leave resource/virtualizer timers on their own paths.
function trackFilterClock() {
  const originalSet = window.setInterval.bind(window);
  const originalClear = window.clearInterval.bind(window);
  const live = new Map<number, ReturnType<typeof globalThis.setInterval>>();
  const started: number[] = [];
  const cleared: number[] = [];
  let nextId = -1;
  const setSpy = jest.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) => {
    if (delay !== 30_000 || typeof handler !== "function") return originalSet(handler, delay, ...args);
    const id = nextId--;
    live.set(id, globalThis.setInterval(() => handler(...args), delay));
    started.push(id);
    return id;
  });
  const clearSpy = jest.spyOn(window, "clearInterval").mockImplementation(id => {
    const timer = id === undefined ? undefined : live.get(id);
    if (timer === undefined) return originalClear(id);
    globalThis.clearInterval(timer);
    live.delete(id!);
    cleared.push(id!);
  });
  return {
    live, started, cleared,
    restore() {
      for (const timer of live.values()) globalThis.clearInterval(timer);
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

test("Logs: rich controls intersect rows while options retain the unfiltered ring", async () => {
  const matching = {
    ...sampleLog, requestId: "match", model: "model-a", status: 500,
    shadowCallRewrittenFrom: "helper-model",
  };
  const rows = [
    { ...matching, requestId: "other-provider", provider: "xai" },
    { ...matching, requestId: "other-model", model: "model-a-plus" },
    { ...matching, requestId: "other-status", status: 200 },
    { ...matching, requestId: "not-intercepted", shadowCallRewrittenFrom: undefined },
    { ...matching, requestId: "other-surface", surface: "claude" },
    matching,
  ];
  serveLogSnapshot(() => rows);
  const { root, container } = await mountLogs();
  try {
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual([
      "match", "other-surface", "not-intercepted", "other-status", "other-model", "other-provider",
    ]);
    await act(async () => { container.querySelector<HTMLButtonElement>("#logs-surface-codex")!.click(); });
    await changeLogSelect(container, "Provider", "openai");
    await changeLogSelect(container, "Model", "model-a");
    await changeLogSelect(container, "Status", "errors");
    const intercepted = container.querySelector<HTMLInputElement>('.logs-filter-container input[type="checkbox"]')!;
    await act(async () => { intercepted.click(); });
    expect(visibleRequestIds(container)).toEqual(["match"]);
    expect(container.querySelector(".logs-filter-status")?.textContent).toContain("Showing 1 of 6");
    expect([...container.querySelectorAll<HTMLOptionElement>('select[aria-label="Model"] option')].map(option => option.value))
      .toEqual(["", "model-a", "model-a-plus"]);
    expect([...container.querySelectorAll<HTMLOptionElement>('select[aria-label="Provider"] option')].map(option => option.value))
      .toEqual(["", "openai", "xai"]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("Logs: a relative-time row expires with an unchanged snapshot and auto-refresh off", async () => {
  const clock = trackFilterClock();
  let requests = 0;
  const rows = [{ ...sampleLog, timestamp: Date.now() - 15 * 60_000 + 1000 }];
  serveLogSnapshot(() => rows, () => requests++);
  let mounted: Awaited<ReturnType<typeof mountLogs>> | undefined;
  try {
    mounted = await mountLogs();
    const { container } = mounted;
    await flushMicrotasks();
    expect(clock.live.size).toBe(0);
    await changeLogSelect(container, "Time", "15m");
    await act(async () => { container.querySelector<HTMLInputElement>('.logs-auto-refresh input')!.click(); });
    await flushMicrotasks();
    const pausedRequests = requests;
    expect(visibleRequestIds(container)).toEqual(["req-1"]);
    expect(clock.live.size).toBe(1);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual([]);
    expect(container.textContent).toContain("No matching requests.");
    expect(container.textContent).not.toContain("No requests yet.");
    expect(container.querySelector(".logs-filter-status")?.textContent).toContain("Showing 0 of 1");
    expect(requests).toBe(pausedRequests);
  } finally {
    try {
      if (mounted) await act(async () => { mounted!.root.unmount(); });
    } finally {
      clock.restore();
    }
  }
});

test("Logs: relative clock is replaced on window changes and cleared on All, Debug and unmount", async () => {
  const clock = trackFilterClock();
  serveLogSnapshot(() => [sampleLog]);
  let mounted: Awaited<ReturnType<typeof mountLogs>> | undefined;
  let unmounted = false;
  try {
    mounted = await mountLogs();
    const { root, container } = mounted;
    await flushMicrotasks();
    expect(clock.started).toEqual([]);
    await changeLogSelect(container, "Time", "15m");
    const first = clock.started[0]!;
    expect(clock.live.has(first)).toBe(true);
    await changeLogSelect(container, "Time", "1h");
    expect(clock.cleared).toEqual([first]);
    expect(clock.live.size).toBe(1);
    await changeLogSelect(container, "Time", "all");
    expect(clock.live.size).toBe(0);
    expect(clock.cleared).toEqual(clock.started);
    await changeLogSelect(container, "Time", "24h");
    expect(clock.live.size).toBe(1);
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#logs-tab-debug")!.click();
      window.dispatchEvent(new testWindow.Event("hashchange"));
    });
    await flushMicrotasks();
    expect(container.querySelector("#logs-tab-debug")?.getAttribute("aria-selected")).toBe("true");
    expect(clock.live.size).toBe(0);
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#logs-tab-logs")!.click();
      window.dispatchEvent(new testWindow.Event("hashchange"));
    });
    await flushMicrotasks();
    expect(container.querySelector("#logs-tab-logs")?.getAttribute("aria-selected")).toBe("true");
    expect(clock.started).toHaveLength(4);
    expect(clock.live.size).toBe(1);
    await act(async () => { root.unmount(); });
    unmounted = true;
    expect(clock.live.size).toBe(0);
    expect(clock.cleared).toEqual(clock.started);
  } finally {
    try {
      if (!unmounted && mounted) await act(async () => { mounted!.root.unmount(); });
    } finally {
      clock.restore();
    }
  }
});

test("Logs: ring rollover clears only vanished model and provider selections", async () => {
  let rows = [{ ...sampleLog, model: "model-a", status: 500, conversationId: "conversation-a" }];
  serveLogSnapshot(() => rows);
  const { root, container } = await mountLogs();
  try {
    await flushMicrotasks();
    await changeLogSelect(container, "Model", "model-a");
    await changeLogSelect(container, "Provider", "openai");
    await changeLogSelect(container, "Status", "errors");
    await changeLogSelect(container, "Time", "1h");
    await enterConversation(container, "conversation-a");
    const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    rows = [{ ...rows[0]!, model: "model-b" }];
    await advanceSilentRefresh();
    expect(select("Model").value).toBe("");
    expect(select("Provider").value).toBe("openai");
    expect(visibleRequestIds(container)).toEqual(["req-1"]);
    await changeLogSelect(container, "Model", "model-b");
    rows = [{ ...rows[0]!, provider: "xai" }];
    await advanceSilentRefresh();
    expect(select("Provider").value).toBe("");
    expect(select("Model").value).toBe("model-b");
    expect(select("Status").value).toBe("errors");
    expect(select("Time").value).toBe("1h");
    expect(container.querySelector<HTMLInputElement>('.logs-filter-container input[type="search"]')!.value).toBe("conversation-a");
    expect(visibleRequestIds(container)).toEqual(["req-1"]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("Logs: casing-only rollover retains model and provider selection with current option spellings", async () => {
  let rows = [
    { ...sampleLog, requestId: "selected", model: "GPT-5", provider: "OpenAI" },
    { ...sampleLog, requestId: "other-model", model: "model-other", provider: "OpenAI" },
    { ...sampleLog, requestId: "other-provider", model: "GPT-5", provider: "xai" },
  ];
  serveLogSnapshot(() => rows);
  const { root, container } = await mountLogs();
  try {
    await flushMicrotasks();
    await changeLogSelect(container, "Model", "GPT-5");
    await changeLogSelect(container, "Provider", "OpenAI");
    await changeLogSelect(container, "Status", "success");
    const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    expect(select("Model").value).toBe("GPT-5");
    expect(select("Provider").value).toBe("OpenAI");
    expect(visibleRequestIds(container)).toEqual(["selected"]);

    rows = rows.map(row => ({ ...row, model: row.model === "GPT-5" ? "gpt-5" : row.model }));
    await advanceSilentRefresh();
    expect(select("Model").value).toBe("gpt-5");
    expect(select("Model").selectedOptions[0]?.value).toBe("gpt-5");
    expect(select("Provider").value).toBe("OpenAI");
    expect(visibleRequestIds(container)).toEqual(["selected"]);

    rows = rows.map(row => ({ ...row, provider: row.provider === "OpenAI" ? "openai" : row.provider }));
    await advanceSilentRefresh();
    expect(select("Provider").value).toBe("openai");
    expect(select("Provider").selectedOptions[0]?.value).toBe("openai");
    expect(select("Model").value).toBe("gpt-5");
    expect(select("Status").value).toBe("success");
    expect(visibleRequestIds(container)).toEqual(["selected"]);
    expect(container.querySelector(".logs-filter-status")?.textContent).toContain("Showing 1 of 3");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("Logs: detail conversation action and reset use the same filter state", async () => {
  const digest = jest.spyOn(crypto.subtle, "digest")
    .mockResolvedValueOnce(new Uint8Array(32).fill(17).buffer)
    .mockResolvedValue(new Uint8Array(32).fill(34).buffer);
  serveLogSnapshot(() => [
    { ...sampleLog, requestId: "hashed", conversationId: "11".repeat(16) },
    { ...sampleLog, requestId: "other", conversationId: "22".repeat(16) },
  ]);
  let mounted: Awaited<ReturnType<typeof mountLogs>> | undefined;
  try {
    mounted = await mountLogs();
    const { container } = mounted;
    await flushMicrotasks();
    await enterConversation(container, "raw-conversation");
    expect(digest).toHaveBeenCalled();
    expect(visibleRequestIds(container)).toEqual(["hashed"]);
    await changeLogSelect(container, "Status", "success");
    await changeLogSelect(container, "Time", "1h");
    await act(async () => { container.querySelector<HTMLButtonElement>(".logs-filter-status button")!.click(); });
    expect(visibleRequestIds(container)).toEqual(["other", "hashed"]);
    expect(container.querySelector(".logs-filter-status")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("#logs-surface-all"));
    expect(container.querySelector("#logs-surface-all")?.getAttribute("aria-checked")).toBe("true");
    const detail = container.querySelector<HTMLButtonElement>('.log-detail-btn[aria-label="Details: other"]')!;
    expect(detail).not.toBeNull();
    await act(async () => { detail.click(); });
    const apply = [...container.querySelectorAll<HTMLButtonElement>("dialog button")]
      .find(button => button.textContent?.trim() === "Filter logs");
    expect(apply).toBeDefined();
    await act(async () => { apply!.click(); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual(["other"]);
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.querySelector<HTMLInputElement>('.logs-filter-container input[type="search"]')!.value).toBe("22".repeat(16));
  } finally {
    try {
      if (mounted) await act(async () => { mounted!.root.unmount(); });
    } finally {
      digest.mockRestore();
    }
  }
});

test("Logs: a hash completed after reset cannot match a newer conversation query", async () => {
  let resolveOld!: (value: ArrayBuffer) => void;
  let resolveNew!: (value: ArrayBuffer) => void;
  const oldHash = new Promise<ArrayBuffer>(resolve => { resolveOld = resolve; });
  const newHash = new Promise<ArrayBuffer>(resolve => { resolveNew = resolve; });
  const digest = jest.spyOn(crypto.subtle, "digest").mockReturnValueOnce(oldHash).mockReturnValueOnce(newHash);
  serveLogSnapshot(() => [
    { ...sampleLog, requestId: "old", conversationId: "11".repeat(16) },
    { ...sampleLog, requestId: "new", conversationId: "22".repeat(16) },
  ]);
  let mounted: Awaited<ReturnType<typeof mountLogs>> | undefined;
  try {
    mounted = await mountLogs();
    const { container } = mounted;
    await flushMicrotasks();
    await enterConversation(container, "old-query");
    expect(digest).toHaveBeenCalledTimes(1);
    await act(async () => { container.querySelector<HTMLButtonElement>(".logs-filter-status button")!.click(); });
    expect(visibleRequestIds(container)).toEqual(["new", "old"]);
    expect(container.querySelector(".logs-filter-status")).toBeNull();
    await enterConversation(container, "new-query");
    expect(digest).toHaveBeenCalledTimes(2);
    await act(async () => { resolveOld(new Uint8Array(32).fill(17).buffer); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual([]);
    expect(container.textContent).toContain("No matching requests.");
    await act(async () => { resolveNew(new Uint8Array(32).fill(34).buffer); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual(["new"]);
  } finally {
    try {
      if (mounted) await act(async () => { mounted!.root.unmount(); });
    } finally {
      digest.mockRestore();
    }
  }
});

test("Logs: no matches differs from a truly empty ring and reset restores loaded rows", async () => {
  let rows = [sampleLog];
  serveLogSnapshot(() => rows);
  const { root, container } = await mountLogs();
  try {
    await flushMicrotasks();
    await changeLogSelect(container, "Status", "errors");
    expect(container.textContent).toContain("No matching requests.");
    expect(container.textContent).not.toContain("No requests yet.");
    await act(async () => { container.querySelector<HTMLButtonElement>(".logs-filter-status button")!.click(); });
    expect(visibleRequestIds(container)).toEqual(["req-1"]);
    rows = [];
    await advanceSilentRefresh();
    expect(container.textContent).toContain("No requests yet.");
    expect(container.textContent).not.toContain("No matching requests.");
    await changeLogSelect(container, "Status", "errors");
    expect(container.textContent).toContain("No requests yet.");
    expect(container.textContent).not.toContain("No matching requests.");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("Logs: a cold empty snapshot shows no requests rather than no matches", async () => {
  serveLogSnapshot(() => []);
  const { root, container } = await mountLogs();
  try {
    await flushMicrotasks();
    expect(container.textContent).toContain("No requests yet.");
    expect(container.textContent).not.toContain("No matching requests.");
    expect(container.textContent).not.toContain("Could not load request logs.");
    expect(container.querySelector(".logs-filter-status")).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
  }
});

const PROXY_NOW = 1_800_000_000_000;

function proxyLogEnvelope(generatedAt: unknown, logs: unknown[]) {
  return { generatedAt, timeZone: "UTC", total: logs.length, logs };
}

async function renderLogsAt(root: Root, apiBase: string): Promise<void> {
  await act(async () => {
    root.render(<LanguageProvider><Logs apiBase={apiBase} /></LanguageProvider>);
  });
  await flushMicrotasks();
}

test.each([-6, 6])("Logs: proxy clock handles browser skew of %sh, wall jumps and paused expiry", async hours => {
  let wallNow = PROXY_NOW + hours * 60 * 60_000;
  let monotonic = 1000;
  const wall = jest.spyOn(Date, "now").mockImplementation(() => wallNow);
  const monotonicClock = jest.spyOn(performance, "now").mockImplementation(() => monotonic);
  const clock = trackFilterClock();
  let requests = 0;
  const rows = [
    { ...sampleLog, requestId: "too-old", timestamp: PROXY_NOW - 15 * 60_000 - 1000 },
    { ...sampleLog, requestId: "fresh", timestamp: PROXY_NOW - 15 * 60_000 + 1000 },
  ];
  globalThis.fetch = (async input => {
    if (!String(input).includes("/api/logs")) return jsonResponse({ timeZone: "UTC" });
    requests++;
    return jsonResponse(proxyLogEnvelope(PROXY_NOW, rows));
  }) as typeof fetch;
  let mounted: Awaited<ReturnType<typeof mountLogs>> | undefined;
  try {
    mounted = await mountLogs();
    const { container } = mounted;
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual(["fresh", "too-old"]);
    await changeLogSelect(container, "Time", "15m");
    expect(visibleRequestIds(container)).toEqual(["fresh"]);
    await act(async () => { container.querySelector<HTMLInputElement>(".logs-auto-refresh input")!.click(); });
    await flushMicrotasks();
    const pausedRequests = requests;
    wallNow += 12 * 60 * 60_000;
    monotonic += 500;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual(["fresh"]);
    wallNow -= 24 * 60 * 60_000;
    monotonic += 30_000;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual([]);
    expect(container.textContent).toContain("No matching requests.");
    expect(requests).toBe(pausedRequests);
    await changeLogSelect(container, "Time", "all");
    expect(visibleRequestIds(container)).toEqual(["fresh", "too-old"]);
  } finally {
    try {
      if (mounted) await act(async () => { mounted!.root.unmount(); });
    } finally {
      clock.restore();
      wall.mockRestore();
      monotonicClock.mockRestore();
    }
  }
});

test("Logs: successful proxy samples resync immediately; legacy, malformed and failed refreshes retain the anchor", async () => {
  const wall = jest.spyOn(Date, "now").mockReturnValue(PROXY_NOW - 6 * 60 * 60_000);
  let monotonic = 1000;
  const monotonicClock = jest.spyOn(performance, "now").mockImplementation(() => monotonic);
  const clock = trackFilterClock();
  const rows = [{ ...sampleLog, requestId: "row", timestamp: PROXY_NOW - 5 * 60_000 }];
  let mode: "initial" | "resync" | "legacy" | "malformed" | "failed" = "initial";
  globalThis.fetch = (async input => {
    if (!String(input).includes("/api/logs")) return jsonResponse({ timeZone: "UTC" });
    if (mode === "failed") return jsonResponse({ error: "unavailable" }, 503);
    if (mode === "legacy") return jsonResponse(rows);
    if (mode === "malformed") return jsonResponse(proxyLogEnvelope(-1, rows));
    return jsonResponse(proxyLogEnvelope(mode === "initial" ? PROXY_NOW : PROXY_NOW + 20 * 60_000, rows));
  }) as typeof fetch;
  let mounted: Awaited<ReturnType<typeof mountLogs>> | undefined;
  try {
    mounted = await mountLogs();
    const { container } = mounted;
    await flushMicrotasks();
    await changeLogSelect(container, "Time", "15m");
    expect(visibleRequestIds(container)).toEqual(["row"]);
    mode = "resync";
    await advanceSilentRefresh();
    // No 30s interval tick yet: receipt of a new server sample updates the filter.
    expect(visibleRequestIds(container)).toEqual([]);
    for (const next of ["legacy", "malformed", "failed"] as const) {
      mode = next;
      await advanceSilentRefresh();
      expect(visibleRequestIds(container)).toEqual([]);
    }
    monotonic += 30_000;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual([]);
    expect(container.textContent).toContain("No matching requests.");
  } finally {
    try {
      if (mounted) await act(async () => { mounted!.root.unmount(); });
    } finally {
      clock.restore();
      wall.mockRestore();
      monotonicClock.mockRestore();
    }
  }
});

test("Logs: switching apiBase clears the old proxy anchor for a legacy envelope", async () => {
  const browserNow = PROXY_NOW + 6 * 60 * 60_000;
  const wall = jest.spyOn(Date, "now").mockReturnValue(browserNow);
  const monotonicClock = jest.spyOn(performance, "now").mockReturnValue(1000);
  globalThis.fetch = (async input => {
    const url = String(input);
    if (!url.includes("/api/logs")) return jsonResponse({ timeZone: "UTC" });
    if (url.startsWith("http://proxy-a/")) return jsonResponse(proxyLogEnvelope(PROXY_NOW, [
      { ...sampleLog, requestId: "proxy-a", timestamp: PROXY_NOW - 60_000 },
    ]));
    return jsonResponse({ logs: [
      { ...sampleLog, requestId: "legacy-old", timestamp: browserNow - 20 * 60_000 },
      { ...sampleLog, requestId: "legacy-fresh", timestamp: browserNow - 5 * 60_000 },
    ] });
  }) as typeof fetch;
  let mounted: Awaited<ReturnType<typeof mountLogs>> | undefined;
  try {
    mounted = await mountLogs("http://proxy-a");
    const { root, container } = mounted;
    await flushMicrotasks();
    await changeLogSelect(container, "Time", "15m");
    expect(visibleRequestIds(container)).toEqual(["proxy-a"]);
    await renderLogsAt(root, "http://proxy-b");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Time"]')!.value).toBe("15m");
    expect(visibleRequestIds(container)).toEqual(["legacy-fresh"]);
  } finally {
    try {
      if (mounted) await act(async () => { mounted!.root.unmount(); });
    } finally {
      wall.mockRestore();
      monotonicClock.mockRestore();
    }
  }
});

// The response headers have arrived, but its body reader deliberately ignores abort.
// This reaches the loader's side-effect boundary after the resource-store guard fired.
function delayedLogBody() {
  let resolve!: (body: unknown) => void;
  const body = new Promise<unknown>(done => { resolve = done; });
  const response = jsonResponse({});
  response.json = () => body;
  return { response, resolve };
}

test("Logs: a late body from an aborted old apiBase cannot poison the new proxy clock", async () => {
  const late = delayedLogBody();
  let oldSignal: AbortSignal | undefined;
  let oldRequests = 0;
  const wall = jest.spyOn(Date, "now").mockReturnValue(PROXY_NOW + 6 * 60 * 60_000);
  let monotonic = 1000;
  const monotonicClock = jest.spyOn(performance, "now").mockImplementation(() => monotonic);
  const clock = trackFilterClock();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (!url.includes("/api/logs")) return jsonResponse({ timeZone: "UTC" });
    if (url.startsWith("http://proxy-a/")) {
      oldRequests++;
      oldSignal = init?.signal ?? undefined;
      return late.response;
    }
    return jsonResponse(proxyLogEnvelope(PROXY_NOW, [
      { ...sampleLog, requestId: "proxy-b", timestamp: PROXY_NOW - 60_000 },
    ]));
  }) as typeof fetch;
  let mounted: Awaited<ReturnType<typeof mountLogs>> | undefined;
  try {
    mounted = await mountLogs("http://proxy-a");
    const { root, container } = mounted;
    await flushMicrotasks();
    expect(oldRequests).toBe(1);
    await renderLogsAt(root, "http://proxy-b");
    expect(oldSignal?.aborted).toBe(true);
    await changeLogSelect(container, "Time", "15m");
    await changeLogSelect(container, "Model", "gpt-test");
    await changeLogSelect(container, "Provider", "openai");
    await act(async () => { container.querySelector<HTMLInputElement>(".logs-auto-refresh input")!.click(); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual(["proxy-b"]);
    await act(async () => { late.resolve(proxyLogEnvelope(PROXY_NOW + 12 * 60 * 60_000, [])); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual(["proxy-b"]);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.value).toBe("gpt-test");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!.value).toBe("openai");
    monotonic += 30_000;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual(["proxy-b"]);
  } finally {
    try {
      if (mounted) await act(async () => { mounted!.root.unmount(); });
    } finally {
      clock.restore();
      wall.mockRestore();
      monotonicClock.mockRestore();
    }
  }
});

test("Logs: aborting an in-flight refresh before pausing cannot replace the accepted clock", async () => {
  const late = delayedLogBody();
  let requests = 0;
  let lateSignal: AbortSignal | undefined;
  const wall = jest.spyOn(Date, "now").mockReturnValue(PROXY_NOW - 6 * 60 * 60_000);
  let monotonic = 1000;
  const monotonicClock = jest.spyOn(performance, "now").mockImplementation(() => monotonic);
  const clock = trackFilterClock();
  globalThis.fetch = (async (input, init) => {
    if (!String(input).includes("/api/logs")) return jsonResponse({ timeZone: "UTC" });
    requests++;
    if (requests === 2) {
      lateSignal = init?.signal ?? undefined;
      return late.response;
    }
    return jsonResponse(proxyLogEnvelope(PROXY_NOW, [
      { ...sampleLog, requestId: "current", timestamp: PROXY_NOW - 60_000 },
    ]));
  }) as typeof fetch;
  let mounted: Awaited<ReturnType<typeof mountLogs>> | undefined;
  try {
    mounted = await mountLogs();
    const { container } = mounted;
    await flushMicrotasks();
    await changeLogSelect(container, "Time", "15m");
    await advanceSilentRefresh();
    expect(requests).toBe(2);
    await act(async () => { container.querySelector<HTMLInputElement>(".logs-auto-refresh input")!.click(); });
    await flushMicrotasks();
    expect(lateSignal?.aborted).toBe(true);
    const pausedRequests = requests;
    await act(async () => { late.resolve(proxyLogEnvelope(PROXY_NOW + 12 * 60 * 60_000, [])); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual(["current"]);
    monotonic += 30_000;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();
    expect(visibleRequestIds(container)).toEqual(["current"]);
    expect(requests).toBe(pausedRequests);
  } finally {
    try {
      if (mounted) await act(async () => { mounted!.root.unmount(); });
    } finally {
      clock.restore();
      wall.mockRestore();
      monotonicClock.mockRestore();
    }
  }
});

test("Logs: reappearing options do not resurrect selections cleared by a successful rollover", async () => {
  const original = { ...sampleLog, requestId: "original", model: "model-a", provider: "openai" };
  const replacement = { ...sampleLog, requestId: "replacement", model: "model-b", provider: "xai" };
  let rows = [original];
  serveLogSnapshot(() => rows);
  const { root, container } = await mountLogs();
  try {
    await flushMicrotasks();
    await changeLogSelect(container, "Model", "model-a");
    await changeLogSelect(container, "Provider", "openai");
    await changeLogSelect(container, "Status", "success");
    rows = [replacement];
    await advanceSilentRefresh();
    const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    expect(select("Model").value).toBe("");
    expect(select("Provider").value).toBe("");
    expect(visibleRequestIds(container)).toEqual(["replacement"]);
    rows = [original, replacement];
    await advanceSilentRefresh();
    expect(select("Model").value).toBe("");
    expect(select("Provider").value).toBe("");
    expect(select("Status").value).toBe("success");
    expect(visibleRequestIds(container)).toEqual(["replacement", "original"]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("Logs: a pending refresh reconciles the user's latest selection rather than its starting selection", async () => {
  const late = delayedLogBody();
  const original = [
    { ...sampleLog, requestId: "a", model: "model-a", provider: "openai", status: 500 },
    { ...sampleLog, requestId: "b", model: "model-b", provider: "xai", status: 500 },
  ];
  let requests = 0;
  globalThis.fetch = (async input => {
    if (!String(input).includes("/api/logs")) return jsonResponse({ timeZone: "UTC" });
    requests++;
    return requests === 1 ? jsonResponse(original) : late.response;
  }) as typeof fetch;
  const { root, container } = await mountLogs();
  try {
    await flushMicrotasks();
    await changeLogSelect(container, "Model", "model-a");
    await changeLogSelect(container, "Provider", "openai");
    await advanceSilentRefresh();
    expect(requests).toBe(2);
    await changeLogSelect(container, "Model", "model-b");
    await changeLogSelect(container, "Provider", "xai");
    await changeLogSelect(container, "Status", "errors");
    expect(visibleRequestIds(container)).toEqual(["b"]);
    await act(async () => {
      late.resolve([
        { ...original[0]!, requestId: "other", model: "model-other" },
        { ...original[1]!, requestId: "current", model: "MODEL-B", provider: "XAI" },
      ]);
    });
    await flushMicrotasks();
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.value).toBe("MODEL-B");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!.value).toBe("XAI");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Status"]')!.value).toBe("errors");
    expect(visibleRequestIds(container)).toEqual(["current"]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});
