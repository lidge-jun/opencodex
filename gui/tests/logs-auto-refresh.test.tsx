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
  expect(overviewReasoning?.textContent).toContain("reasoning_effort=high");
  expect(overviewReasoning?.textContent).not.toContain("max → high → high");
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
  expect(container.textContent).toContain("I · gpt-5.6-luna");
  expect(container.textContent).toContain("gpt-test");

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
  expect(container.textContent).toContain("I · gpt-5.6-luna");
  expect(container.textContent).not.toContain("gpt-test");

  await act(async () => { toggle!.click(); });
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });

  expect(container.textContent).toContain("gpt-test");

  await act(async () => { root.unmount(); });
});
