import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Logs from "../src/pages/Logs";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

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
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
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


function fixture(status: number, cause: string, sends: number): Record<string, unknown> {
  return {
    requestId: "fault-row", timestamp: 1_700_000_000_000, provider: "openai", model: "fault-row",
    status, durationMs: 100, usageStatus: "unreported", failureCause: cause,
    spend: { sends, settled: sends, unresolved: 0 },
    attempts: [{ ordinal: 1, provider: "openai", model: "fault-row", adapter: "openai-chat",
      status, durationMs: 100, sendCount: sends, recoveryKinds: [], usageStatus: "unreported" }],
  };
}
async function show(row: Record<string, unknown>) {
  globalThis.fetch = (async input => String(input).includes("/api/logs")
    ? Response.json({ logs: [row], generatedAt: 1_700_000_000_000, timeZone: "UTC" })
    : new Response(null, { status: 404 })) as typeof fetch;
  const mounted = await mountLogs();
  const button = mounted.container.querySelector<HTMLButtonElement>(".log-detail-btn");
  expect(button).not.toBeNull();
  await act(async () => { button!.click(); });
  return mounted;
}
function value(label: string): string | undefined {
  const grid = document.querySelector(".log-detail-grid")!;
  const item = [...grid.children].find(node => node.textContent === label);
  return item?.nextElementSibling?.textContent?.trim();
}

test.each([
  [429, "rate-limit", "Rate limited", 1, 0],
  [500, "upstream-fault", "Upstream fault", 3, 2],
  [503, "upstream-declined", "Upstream declined to start", 3, 2],
] as const)("%i displays the upstream cause and resolved physical sends", async (status, cause, headline, sends, retries) => {
  const { root } = await show(fixture(status, cause, sends));
  try {
    expect(document.querySelector("#log-detail-title")?.textContent).toContain(`${status}${headline}`);
    expect(Boolean(document.querySelector(".modal-desc"))).toBe(false);
    expect(value("Upstream sends")).toBe(String(sends));
    expect(value("Retries")).toBe(String(retries));
  } finally { await act(async () => { root.unmount(); }); }
});


test.each([
  ["zero sends", { sends: 0, settled: 0, unresolved: 0 }, [0], "0", "0"],
  ["multiple attempts", { sends: 3, settled: 3, unresolved: 0 }, [1, 2], "3", undefined],
  ["unresolved", { sends: 3, settled: 2, unresolved: 1 }, [3], "3 (unresolved: 1)", undefined],
  ["attempt mismatch", { sends: 3, settled: 3, unresolved: 0 }, [2], "3", undefined],
  ["settled exceeds sends", { sends: 2, settled: 3, unresolved: 0 }, [2], "Unavailable", undefined],
  ["invalid reserved", { sends: 3, settled: 3, unresolved: 0, reserved: -1 }, [3], "Unavailable", undefined],
  ["null reserved", { sends: 3, settled: 3, unresolved: 0, reserved: null }, [3], "Unavailable", undefined],
  ["invalid attempt count", { sends: 3, settled: 3, unresolved: 0 }, [-1], "3", undefined],
  ["under-settled", { sends: 3, settled: 2, unresolved: 0 }, [3], "3", undefined],
  ["over-reserved", { sends: 3, settled: 3, unresolved: 0, reserved: 4 }, [3], "3", undefined],
  ["missing spend", undefined, [1], "Unavailable", undefined],
  ["invalid sends", { sends: -1, settled: 0, unresolved: 0 }, [0], "Unavailable", undefined],
  ["invalid unresolved", { sends: 1, settled: 1, unresolved: 0.5 }, [1], "Unavailable", undefined],
  ["missing attempts", { sends: 1, settled: 1, unresolved: 0 }, [], "1", undefined],
] as const)("%s keeps send and retry accounting honest", async (_name, spend, counts, sends, retries) => {
  const row = fixture(500, "upstream-fault", 3);
  row.spend = spend;
  const attempt = (row.attempts as Record<string, unknown>[])[0]!;
  row.attempts = counts.map((count, index) => ({ ...attempt, ordinal: index + 1, sendCount: count }));
  const { root } = await show(row);
  try {
    expect(value("Upstream sends")).toBe(sends);
    expect(value("Retries")).toBe(retries);
  } finally { await act(async () => { root.unmount(); }); }
});

test("a lossy normalized attempt roster does not imply retries", async () => {
  const row = fixture(500, "upstream-fault", 3);
  row.attemptNormalizationDropped = true;
  const { root } = await show(row);
  try {
    expect(value("Upstream sends")).toBe("3");
    expect(value("Retries")).toBeUndefined();
  } finally { await act(async () => { root.unmount(); }); }
});

test.each([
  ["local failure", "local-refusal", "Refused by this proxy", false],
  ["unknown cause", "future-fault", "Proxy error", true],
  ["inherited property cause", "constructor", "Proxy error", true],
  ["legacy row", undefined, "Proxy error", true],
] as const)("%s uses the proper headline and attribution", async (_name, cause, headline, fallback) => {
  const row = fixture(500, "upstream-fault", 0);
  // Persisted normalization drops unknown causes before they reach the dashboard.
  row.failureCause = cause === "future-fault" || cause === "constructor" ? undefined : cause;
  if (cause === undefined) { delete row.spend; delete row.attempts; }
  const { root } = await show(row);
  try {
    expect(document.querySelector("#log-detail-title")?.textContent).toContain(`500${headline}`);
    expect(Boolean(document.querySelector(".modal-desc"))).toBe(fallback);
    if (cause === "future-fault" || cause === "constructor") expect(value("Failure cause")).toBeUndefined();
    if (cause === undefined) expect(value("Upstream sends")).toBe("Unavailable");
  } finally { await act(async () => { root.unmount(); }); }
});


test("multiple attempts preserve their recovery reason without inventing retries", async () => {
  const row = fixture(429, "rate-limit", 2);
  const attempt = (row.attempts as Record<string, unknown>[])[0]!;
  row.attempts = [{ ...attempt, sendCount: 1, recoveryKinds: ["rate-limit-429"] },
    { ...attempt, ordinal: 2, sendCount: 1 }];
  const { root } = await show(row);
  try {
    expect(document.querySelector(".log-detail-attempts")?.textContent).toContain("Rate-limited (429)");
    expect(value("Upstream sends")).toBe("2");
    expect(value("Retries")).toBeUndefined();
  } finally { await act(async () => { root.unmount(); }); }
});
