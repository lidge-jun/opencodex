import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Logs from "../src/pages/Logs";
import { decodeRateLabelKeys } from "../src/pages/logs-decode-rate";

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


function fixture(requestId: string, decode?: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId, timestamp: 1_700_000_000_000, provider: "openai", model: requestId,
    status: 200, durationMs: 36871, firstOutputMs: 35175, usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 227, reasoningOutputTokens: 168 },
    displayMetrics: {
      tokPerSecond: { kind: "value", value: 6.157, estimated: false },
      ...(decode ? { decodeTokPerSecond: decode } : {}),
      cost: { kind: "unavailable", reason: "price_unmatched" },
    },
  };
}
const value = (timingBasis?: string, rate = 21.804) => ({
  kind: "value", value: rate, estimated: true, ...(timingBasis ? { timingBasis } : {}),
});
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

test("mixed Logs rows visibly identify their basis, with distinct details and attempt timing", async () => {
  const current = fixture("generation-row", value("generation-window"));
  const attempt = fixture("attempt-row", value("legacy-post-visible-output", 30));
  current.attempts = [{
    ...attempt, ordinal: 1, adapter: "openai-chat", sendCount: 1, recoveryKinds: [],
    durationMs: 10000, firstOutputMs: 2000,
  }, {
    ...fixture("cached-attempt", value()), ordinal: 2, adapter: "openai-chat", sendCount: 1, recoveryKinds: [],
  }, {
    ...fixture("short-attempt", { kind: "unavailable", reason: "decode_window_too_short" }),
    ordinal: 3, adapter: "openai-chat", sendCount: 1, recoveryKinds: [],
  }];
  mockLogs([fixture("legacy-row", value("legacy-post-visible-output", 133.844)), current]);
  const { root, container } = await mountLogs();
  try {
    const legacy = rowFor(container, "legacy-row").querySelector(".log-col-rate")!;
    const generation = rowFor(container, "generation-row").querySelector(".log-col-rate")!;
    expect(legacy.textContent).toContain("6.2");
    expect(legacy.textContent).toContain("~134");
    expect(legacy.textContent).toContain("After visible output");
    expect(generation.textContent).toContain("6.2");
    expect(generation.textContent).toContain("~21.8");
    expect(generation.textContent).toContain("Generation window");
    expect(legacy.querySelector("[title]")?.getAttribute("title")).toBe("Output rate after first visible output (est.)");
    await openDetails(rowFor(container, "generation-row"));
    const performance = document.querySelector('[aria-labelledby="log-detail-performance"]')!;
    expect(performance.textContent).toContain("End-to-end output tok/s");
    expect(performance.textContent).toContain("Output rate during generation (est.)");
    const hint = performance.querySelector(".logs-decode-basis-hint")!;
    expect(hint.textContent).toBe("Estimated using the time from the first output observed by the proxy, including reasoning, to the last output delta.");
    expect(hint.classList.contains("muted")).toBe(true);
    expect(hint.classList.contains("text-caption")).toBe(true);
    expect(hint.parentElement?.classList.contains("log-detail-performance-grid")).toBe(true);
    const attempts = document.querySelector(".log-detail-attempts")!;
    const legacyAttempt = attempts.querySelector('[title="Output rate after first visible output (est.)"].logs-decode-rate');
    expect(legacyAttempt?.textContent).toContain("~30.0");
    expect(legacyAttempt?.textContent).toContain("After visible output");
    const unknownAttempt = attempts.querySelector('[title="Output rate (est.; timing method unknown)"].logs-decode-rate');
    expect(unknownAttempt?.textContent).toContain("~21.8");
    expect(unknownAttempt?.textContent).toContain("Timing unknown");
    expect(attempts.querySelectorAll(".logs-decode-rate")).toHaveLength(2);
    expect(attempts.querySelector(".logs-decode-basis-hint")).toBeNull();
    expect(attempts).not.toBeNull();
  } finally { await act(async () => { root.unmount(); }); }
});

test("older and unknown DTOs never invent a timing basis; absent and unavailable rates stay absent", async () => {
  const old = fixture("cached-old", value());
  // Even other fields cannot prove which basis an old server used for its cached value.
  old.genStartMs = 26115; old.lastOutputMs = 36526;
  mockLogs([old, fixture("future", value("future-window")), fixture("absent"),
    fixture("short", { kind: "unavailable", reason: "decode_window_too_short" })]);
  const { root, container } = await mountLogs();
  try {
    for (const id of ["cached-old", "future"]) {
      const cell = rowFor(container, id).querySelector(".log-col-rate")!;
      expect(cell.textContent).toContain("~21.8");
      expect(cell.textContent).toContain("Timing unknown");
      expect(cell.textContent).not.toContain("Generation window");
    }
    for (const id of ["absent", "short"]) {
      expect(rowFor(container, id).querySelector(".logs-decode-rate")).toBeNull();
      expect(rowFor(container, id).querySelector(".log-col-rate")?.textContent?.trim()).toBe("6.2");
    }
    for (const id of ["cached-old", "future"]) {
      await openDetails(rowFor(container, id));
      const performance = document.querySelector('[aria-labelledby="log-detail-performance"]')!;
      expect(performance.textContent).toContain("Output rate (est.; timing method unknown)");
      expect(performance.querySelector(".logs-decode-basis-hint")?.textContent)
        .toBe("The server did not report which timing method was used for this estimate.");
      await act(async () => { document.querySelector<HTMLButtonElement>(".modal-head button")!.click(); });
    }
  } finally { await act(async () => { root.unmount(); }); }
});

test("all locales translate both explicit bases and the unknown fallback", async () => {
  const { DICTS } = await import("../src/i18n/shared");
  for (const dict of Object.values(DICTS)) {
    for (const timingBasis of ["generation-window", "legacy-post-visible-output", undefined, "unknown-new-value"]) {
      const keys = decodeRateLabelKeys({ timingBasis });
      expect(dict[keys.short]?.length).toBeGreaterThan(0);
      expect(dict[keys.detail]?.length).toBeGreaterThan(0);
      expect(dict[keys.hint]?.length).toBeGreaterThan(0);
    }
    expect(dict["logs.decodeBasis.generation"]).not.toBe(dict["logs.decodeBasis.legacy"]);
    expect(dict["logs.decodeBasis.unknown"]).not.toBe(dict["logs.decodeBasis.legacy"]);
  }
});


test("decode label keys include the matching hint for every timing method", () => {
  for (const [timingBasis, suffix, detail] of [
    ["generation-window", "generation", "decodeGeneration"],
    ["legacy-post-visible-output", "legacy", "decodeLegacy"],
    [undefined, "unknown", "decodeUnknown"],
    ["future-basis", "unknown", "decodeUnknown"],
  ] as const) {
    expect(decodeRateLabelKeys({ timingBasis })).toEqual({
      short: `logs.decodeBasis.${suffix}`,
      detail: `logs.detail.${detail}`,
      hint: `logs.detail.decodeBasisHint.${suffix}`,
    });
  }
});

test.each([
  ["legacy", value("legacy-post-visible-output")],
  ["absent", undefined],
  ["short", { kind: "unavailable", reason: "decode_window_too_short" }],
  ["missing-ttft", { kind: "unavailable", reason: "ttft_missing" }],
] as const)("request detail hint visibility follows the decode value: %s", async (id, decode) => {
  mockLogs([fixture(id, decode)]);
  const { root, container } = await mountLogs();
  try {
    await openDetails(rowFor(container, id));
    const performance = document.querySelector('[aria-labelledby="log-detail-performance"]')!;
    const hint = performance.querySelector(".logs-decode-basis-hint");
    if (id === "legacy") {
      expect(performance.textContent).toContain("Output rate after first visible output (est.)");
      expect(hint?.textContent).toBe("Estimated using the time from the first visible output to the end of the request, while counting all reported output tokens, including reasoning.");
    } else {
      expect(hint).toBeNull();
      expect(performance.textContent).not.toContain("Estimated using the time");
      expect(performance.textContent).not.toContain("The server did not report");
    }
  } finally { await act(async () => { root.unmount(); }); }
});
