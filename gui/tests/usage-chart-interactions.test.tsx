import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Usage from "../src/pages/Usage";

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage", "fetch",
  "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null = null;

function isoDay(offset = 0): string {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + offset);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/#dashboard" });
  class TestResizeObserver {
    observe() {}
    disconnect() {}
  }
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    ResizeObserver: { configurable: true, value: TestResizeObserver },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  clearClientResourceStoresForTests();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  clearClientResourceStoresForTests();
  win.close();
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${document.body.innerHTML}`);
    await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 10)); });
  }
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  await act(async () => { root!.render(<LanguageProvider>{node}</LanguageProvider>); });
  return container;
}

function usagePayload(models: Array<{ provider: string; model: string; requests: number; totalTokens: number }> = []) {
  const yesterday = isoDay(-1);
  const today = isoDay();
  return {
    range: "all",
    surface: "all",
    since: null,
    generatedAt: Date.now(),
    summary: {
      requests: 7, measuredRequests: 7, reportedRequests: 7, unreportedRequests: 0,
      unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 70, outputTokens: 30,
      cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 100, coverageRatio: 1,
    },
    days: [
      { date: yesterday, requests: 2, measuredRequests: 2, reportedRequests: 2, totalTokens: 25, models: [] },
      { date: today, requests: 5, measuredRequests: 5, reportedRequests: 5, totalTokens: 75, models },
    ],
    models: [], providers: [], historyTruncated: false, truncatedPrefixBytes: 0,
    entriesTruncated: false, entriesDropped: 0,
  };
}

test("Usage heatmap exposes one roving entry and day/week keyboard movement", async () => {
  globalThis.fetch = (async () => Response.json(usagePayload())) as typeof fetch;
  const container = await mount(<Usage apiBase="http://usage-chart-test" />);
  await waitFor(() => container.querySelector(".heatmap-grid") !== null);

  expect(container.querySelector(".heatmap-grid")?.getAttribute("role")).toBe("group");
  expect(container.querySelectorAll(".heatmap-grid [role='gridcell']")).toHaveLength(0);
  expect(container.querySelectorAll(".heatmap-grid [tabindex='0']")).toHaveLength(1);
  const initial = container.querySelector<HTMLElement>(".heatmap-grid [tabindex='0']")!;
  expect(initial.tagName).toBe("BUTTON");
  const initialDate = initial.dataset.date!;
  await act(async () => { initial.focus(); });
  const heatmapTip = document.querySelector(".heatmap-tip");
  expect(heatmapTip?.textContent).toContain("requests");
  expect(heatmapTip?.parentNode === document.body).toBe(true);
  expect(container.contains(heatmapTip)).toBe(false);

  await act(async () => {
    initial.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    await new Promise(resolve => win.setTimeout(resolve, 0));
  });
  const previousDay = container.querySelector<HTMLElement>(".heatmap-grid [tabindex='0']")!;
  expect(previousDay.dataset.date).not.toBe(initialDate);
  expect(document.activeElement).toBe(previousDay);

  await act(async () => {
    previousDay.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await new Promise(resolve => win.setTimeout(resolve, 0));
  });
  expect(container.querySelector<HTMLElement>(".heatmap-grid [tabindex='0']")?.dataset.date).not.toBe(previousDay.dataset.date);
});

test("seven-day bars expose the same detail on focus and touch", async () => {
  globalThis.fetch = (async () => Response.json(usagePayload())) as typeof fetch;
  const container = await mount(<Usage apiBase="http://usage-bars-test" />);
  await waitFor(() => container.querySelector(".heatmap-grid") !== null);
  const sevenDay = Array.from(container.querySelectorAll<HTMLButtonElement>(".usage-segmented-btn"))
    .find(button => button.textContent === "7d")!;
  await act(async () => { sevenDay.click(); });
  await waitFor(() => container.querySelectorAll(".daybar").length === 7);

  const bars = container.querySelectorAll<HTMLElement>(".daybar");
  expect(bars).toHaveLength(7);
  expect(Array.from(bars).every(bar => bar.tabIndex === 0)).toBe(true);

  const today = bars[6]!;
  await act(async () => { today.focus(); });
  const focused = document.querySelector(".daybar-tip")?.textContent;
  expect(focused).toContain("5 requests");
  expect(focused).toContain("75 tokens");

  await act(async () => { today.blur(); });
  await act(async () => {
    today.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
  });
  expect(document.querySelector(".daybar-tip")?.textContent).toBe(focused);
});

test("Usage tooltip portals stay inside viewport gutters at the lower-right edge", async () => {
  Object.defineProperties(win, {
    innerWidth: { configurable: true, value: 320 },
    innerHeight: { configurable: true, value: 240 },
  });
  const models = Array.from({ length: 8 }, (_, index) => ({
    provider: "openai",
    model: `model-${index}`,
    requests: 1,
    totalTokens: index + 1,
  }));
  globalThis.fetch = (async () => Response.json(usagePayload(models))) as typeof fetch;
  const container = await mount(<Usage apiBase="http://usage-tip-bounds-test" />);
  await waitFor(() => container.querySelector(".heatmap-grid") !== null);
  const sevenDay = Array.from(container.querySelectorAll<HTMLButtonElement>(".usage-segmented-btn"))
    .find(button => button.textContent === "7d")!;
  await act(async () => { sevenDay.click(); });
  await waitFor(() => container.querySelectorAll(".daybar").length === 7);

  const today = container.querySelectorAll<HTMLElement>(".daybar")[6]!;
  Object.defineProperty(today, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 220, right: 320, bottom: 240, left: 300, width: 20, height: 20, x: 300, y: 220, toJSON() {} }),
  });
  await act(async () => { today.focus(); });

  const tooltip = document.querySelector<HTMLElement>(".daybar-tip")!;
  expect(tooltip.parentNode === document.body).toBe(true);
  expect(container.contains(tooltip)).toBe(false);
  expect(tooltip.querySelectorAll(".daybar-tip-row")).toHaveLength(9);
  expect(parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(8);
  expect(parseFloat(tooltip.style.left) + parseFloat(tooltip.style.maxWidth)).toBeLessThanOrEqual(312);
  expect(parseFloat(tooltip.style.bottom)).toBeGreaterThanOrEqual(8);
  expect(parseFloat(tooltip.style.maxHeight) + parseFloat(tooltip.style.bottom)).toBeLessThanOrEqual(232);
});
