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

const zeroTokenSplit = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function creditRow(requestId: string) {
  return {
    requestId, timestamp: 1_700_000_000_000, provider: "kiro", model: "claude-opus-5.5",
    status: 200, durationMs: 2000, usageStatus: "estimated",
    usage: { inputTokens: 600_000, outputTokens: 400, providerCredits: 1.95, estimated: true },
    displayMetrics: {
      tokPerSecond: { kind: "value", value: 200, estimated: true },
      cost: {
        kind: "value",
        estimate: {
          cost: { ...zeroTokenSplit, total: 0.078 },
          estimated: true,
          billing: { source: "provider-credits", providerCredits: 1.95, creditPriceUsd: 0.04 },
        },
        estimateReasons: ["usage_estimated"],
      },
    },
  };
}

function tokenRow(requestId: string) {
  return {
    requestId, timestamp: 1_700_000_000_000, provider: "anthropic", model: "claude-3-haiku-20240307",
    status: 200, durationMs: 2000, usageStatus: "reported",
    usage: { inputTokens: 1000, outputTokens: 100 },
    displayMetrics: {
      tokPerSecond: { kind: "value", value: 50, estimated: false },
      cost: {
        kind: "value",
        estimate: { cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 }, estimated: false },
        estimateReasons: [],
      },
    },
  };
}

function mixedRow(requestId: string) {
  return {
    requestId, timestamp: 1_700_000_000_000, provider: "combo", model: "combo/mixed",
    status: 200, durationMs: 3000, usageStatus: "estimated",
    usage: { inputTokens: 601_000, outputTokens: 500 },
    displayMetrics: {
      tokPerSecond: { kind: "value", value: 166, estimated: true },
      cost: {
        kind: "value",
        estimate: {
          cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0782 },
          estimated: true,
          billing: { source: "mixed" },
        },
        estimateReasons: ["usage_estimated"],
      },
    },
    attempts: [
      {
        ...creditRow("attempt-1"), ordinal: 1, adapter: "kiro", sendCount: 1, recoveryKinds: [], durationMs: 1000, firstOutputMs: 500,
      },
      {
        ...tokenRow("attempt-2"), ordinal: 2, adapter: "anthropic", sendCount: 1, recoveryKinds: [], durationMs: 2000, firstOutputMs: 700,
      },
    ],
  };
}

function mockLogs(rows: Record<string, unknown>[]) {
  globalThis.fetch = (async input => {
    if (!String(input).includes("/api/logs")) return new Response(null, { status: 404 });
    return Response.json({ logs: rows, generatedAt: 1_700_000_000_000, timeZone: "UTC" });
  }) as typeof fetch;
}

function rowFor(container: HTMLElement, id: string): HTMLTableRowElement {
  const row = [...container.querySelectorAll<HTMLTableRowElement>(".logs-table tbody tr")]
    .find(row => row.textContent?.includes(id));
  expect(row).toBeDefined();
  return row!;
}

async function openDetails(row: HTMLTableRowElement) {
  await act(async () => { row.querySelector<HTMLButtonElement>(".log-detail-btn")!.click(); });
}

function costSection(): HTMLElement {
  const section = document.querySelector<HTMLElement>('[aria-labelledby="log-detail-cost"]');
  expect(section).not.toBeNull();
  return section!;
}

test("a credit-billed row shows credits and price instead of four zero token charges", async () => {
  mockLogs([creditRow("credit-row")]);
  const { root, container } = await mountLogs();
  try {
    await openDetails(rowFor(container, "credit-row"));
    const section = costSection();
    const text = section.textContent ?? "";
    expect(text).toContain("$0.0780");
    expect(text).toContain("1.95");
    // The unit price is not a charge: a four-decimal charge format would render a legitimate
    // sub-cent price as "$0.0000", the same zero-that-is-not-a-zero this basis removes.
    expect(text).toContain("$0.04 per credit");
    // The bug: the four token buckets rendered as "$0.0000" component charges beside a
    // nonzero total. A credit charge has no token allocation, so those rows must not exist.
    expect(text).not.toContain("$0.0000");
    expect(section.querySelector(".log-detail-credit-billing")).not.toBeNull();
    // The section heading must not call a credit total a list-price equivalent; the basis under
    // it would then contradict its own title.
    expect(section.querySelector(".log-detail-section-title")?.textContent).toBe("Estimated cost");
  } finally { await act(async () => { root.unmount(); }); }
});

test("a token-priced row keeps its component breakdown", async () => {
  mockLogs([tokenRow("token-row")]);
  const { root, container } = await mountLogs();
  try {
    await openDetails(rowFor(container, "token-row"));
    const section = costSection();
    const text = section.textContent ?? "";
    expect(text).toContain("input");
    expect(text).toContain("cache read");
    expect(text).toContain("output");
    expect(section.querySelector(".log-detail-credit-billing")).toBeNull();
    // A token row keeps the repository's deliberate list-price-equivalent labelling (#198).
    expect(section.querySelector(".log-detail-section-title")?.textContent).toBe("API list-price equivalent");
  } finally { await act(async () => { root.unmount(); }); }
});

test("an unrepresentable credit charge renders the localized reason, never an invented amount", async () => {
  mockLogs([{
    requestId: "unrepresentable-row", timestamp: 1_700_000_000_000, provider: "kiro", model: "claude-opus-5.5",
    status: 200, durationMs: 2000, usageStatus: "estimated",
    usage: { inputTokens: 1000, outputTokens: 10, providerCredits: 1e12, estimated: true },
    displayMetrics: {
      tokPerSecond: { kind: "value", value: 200, estimated: true },
      cost: { kind: "unavailable", reason: "credit_cost_unrepresentable" },
    },
  }]);
  const { root, container } = await mountLogs();
  try {
    await openDetails(rowFor(container, "unrepresentable-row"));
    const section = costSection();
    const text = section.textContent ?? "";
    // The reason key must resolve, not fall through as a raw wire token or a blank.
    expect(text).toContain("cannot produce a representable amount");
    expect(text).not.toContain("credit_cost_unrepresentable");
  } finally { await act(async () => { root.unmount(); }); }
});

test("a mixed combo names the basis, keeps the total, and hides no zero split", async () => {
  mockLogs([mixedRow("mixed-row")]);
  const { root, container } = await mountLogs();
  try {
    await openDetails(rowFor(container, "mixed-row"));
    const section = costSection();
    const text = section.textContent ?? "";
    expect(text).toContain("$0.0782");
    expect(text).toContain("Mixed");
    expect(text).not.toContain("$0.0000");
    // Each attempt still reports the basis it actually used.
    const attempts = document.querySelector(".log-detail-attempts")!;
    expect(attempts.textContent).toContain("$0.0780");
    expect(attempts.textContent).not.toContain("$0.0000");
  } finally { await act(async () => { root.unmount(); }); }
});
