import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { QuotaSummaryChips } from "../src/components/quota-summary-bar/QuotaSummaryBar";
import type { TFn } from "../src/i18n/shared";
import { freshQuotaReportsFromResponse } from "../src/provider-workspace/report";
import { buildQuotaSummary } from "../src/quota-summary";

const globals = ["document", "window", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#dashboard" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    requestAnimationFrame: { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) },
    cancelAnimationFrame: { configurable: true, value: (id: number) => clearTimeout(id) },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

const now = Date.now();
const t = ((key: string) => key) as unknown as TFn;
const rows = buildQuotaSummary(freshQuotaReportsFromResponse([
  { provider: "openai", label: "OpenAI (Codex login)", updatedAt: now, quota: { weeklyPercent: 69, updatedAt: now } },
  { provider: "xai", label: "xAI Grok", updatedAt: now, quota: { weeklyPercent: 74, updatedAt: now } },
  { provider: "kimi", label: "Kimi", updatedAt: now, quota: { weeklyPercent: 31, updatedAt: now } },
], now), provider => provider);

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<QuotaSummaryChips rows={rows} t={t} locale="en" />);
  });
  const list = container.querySelector("ul")!;
  return {
    container,
    list,
    chip: (label: string) => [...container.querySelectorAll("a.quota-summary-chip")]
      .find(element => element.textContent?.includes(label)) as unknown as HTMLAnchorElement,
    buttons: () => [...container.querySelectorAll("button.quota-summary-scroll")] as unknown as HTMLButtonElement[],
    unmount: () => act(async () => { root.unmount(); }),
  };
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
  });
}

/** happy-dom does no layout, so the scroll metrics a real browser would report are stubbed. */
async function scrollMetrics(list: HTMLElement, metrics: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
  for (const [key, value] of Object.entries(metrics)) Object.defineProperty(list, key, { configurable: true, value });
  await act(async () => { list.dispatchEvent(new testWindow.Event("scroll") as unknown as Event); });
}

test("every chip is a link to its provider's Accounts tab, and a click follows it", async () => {
  const view = await mount();
  expect(view.chip("xAI Grok").getAttribute("href")).toBe("#providers?provider=xai&tab=accounts");
  await click(view.chip("xAI Grok"));
  expect(testWindow.location.hash).toBe("#providers?provider=xai&tab=accounts");
  expect(view.container.querySelector("[role=tooltip]")).toBeNull();
  await view.unmount();
});

test("following the link that is already current re-announces it", async () => {
  const view = await mount();
  // The first navigation's own hashchange may arrive asynchronously; let it land before counting.
  const navigated = new Promise<void>(resolve => testWindow.addEventListener("hashchange", () => resolve(), { once: true }));
  await click(view.chip("Kimi"));
  await act(async () => { await navigated; });
  let announced = 0;
  testWindow.addEventListener("hashchange", () => { announced += 1; });
  await click(view.chip("Kimi"));
  expect(testWindow.location.hash).toBe("#providers?provider=kimi&tab=accounts");
  expect(announced).toBe(1);
  await view.unmount();
});

test("the scroll buttons appear only when the chips overflow, and page the one row", async () => {
  const view = await mount();
  await scrollMetrics(view.list, { scrollWidth: 300, clientWidth: 300, scrollLeft: 0 });
  expect(view.buttons()).toHaveLength(0);

  await scrollMetrics(view.list, { scrollWidth: 1000, clientWidth: 300, scrollLeft: 0 });
  const [prev, next] = view.buttons();
  expect(prev?.textContent).toBe("«");
  expect(next?.textContent).toBe("»");
  // aria-disabled keeps a focused button focusable when it reaches its end.
  expect(prev?.getAttribute("aria-disabled")).toBe("true");
  expect(next?.getAttribute("aria-disabled")).toBe("false");

  const calls: ScrollToOptions[] = [];
  (view.list as unknown as { scrollBy: (options: ScrollToOptions) => void }).scrollBy = options => { calls.push(options); };
  await click(prev!);
  expect(calls).toHaveLength(0);
  await click(next!);
  expect(calls[0]?.left).toBe(240);

  await scrollMetrics(view.list, { scrollWidth: 1000, clientWidth: 300, scrollLeft: 700 });
  expect(view.buttons()[0]?.getAttribute("aria-disabled")).toBe("false");
  expect(view.buttons()[1]?.getAttribute("aria-disabled")).toBe("true");
  await click(view.buttons()[0]!);
  expect(calls[1]?.left).toBe(-240);

  // A chip widened without any scroll or list resize (a late web font): the stored edge says
  // "at end", but the live metrics can still scroll, so » must page instead of ignoring the press.
  Object.defineProperty(view.list, "scrollWidth", { configurable: true, value: 2000 });
  await click(view.buttons()[1]!);
  expect(calls[2]?.left).toBe(240);
  await view.unmount();
});

test("on touch the first tap shows the detail, the second follows the link, and the chip stays usable", async () => {
  const view = await mount();
  const tap = async (label: string) => {
    const chip = view.chip(label);
    await act(async () => {
      chip.dispatchEvent(new testWindow.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" } as never) as unknown as Event);
    });
    await click(chip);
  };
  const tooltip = () => view.container.querySelector("[role=tooltip]");

  await tap("Kimi");
  expect(tooltip()?.textContent).toContain("Kimi");
  expect(testWindow.location.hash).toBe("#dashboard");
  await tap("Kimi");
  expect(tooltip()).toBeNull();
  expect(testWindow.location.hash).toBe("#providers?provider=kimi&tab=accounts");

  // Another round on another chip, and back on the first: nothing is left inert.
  await tap("xAI Grok");
  expect(tooltip()?.textContent).toContain("xAI Grok");
  await tap("Kimi");
  expect(tooltip()?.textContent).toContain("Kimi");
  await tap("Kimi");
  expect(tooltip()).toBeNull();

  // A keyboard Enter on a chip that was just tapped (detail dismissed with Escape) follows the
  // link instead of being read as a second tap that only reopens the detail.
  await tap("xAI Grok");
  expect(tooltip()?.textContent).toContain("xAI Grok");
  await act(async () => {
    document.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });
  expect(tooltip()).toBeNull();
  await click(view.chip("xAI Grok"));
  expect(testWindow.location.hash).toBe("#providers?provider=xai&tab=accounts");
  await view.unmount();
});

test("a clicked chip keeps its detail closed under the resting pointer until the pointer leaves", async () => {
  const view = await mount();
  const item = view.chip("xAI Grok").parentElement!;
  const pointer = async (type: "pointerover" | "pointerout", relatedTarget: Element | null) => {
    await act(async () => {
      item.dispatchEvent(new testWindow.PointerEvent(type, { bubbles: true, pointerType: "mouse", relatedTarget } as never) as unknown as Event);
    });
  };
  const tooltip = () => view.container.querySelector("[role=tooltip]");

  await pointer("pointerover", document.body);
  expect(tooltip()?.textContent).toContain("xAI Grok");
  expect(view.chip("xAI Grok").getAttribute("aria-describedby")).toBe(tooltip()?.id ?? "missing");

  await click(view.chip("xAI Grok"));
  expect(tooltip()).toBeNull();
  // Focus moving away must not reopen the detail under a pointer that never moved.
  await act(async () => { view.chip("xAI Grok").dispatchEvent(new testWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event); });
  expect(tooltip()).toBeNull();

  await pointer("pointerout", document.body);
  await pointer("pointerover", document.body);
  expect(tooltip()?.textContent).toContain("xAI Grok");
  await view.unmount();
});
