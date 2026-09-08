import { expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import type { TFn } from "../src/i18n/shared";
import { DEFAULT_LOG_FILTER_STATE, hasActiveLogFilters, type LogFilterState } from "../src/pages/logs-filter";
import { LogsFilterBar } from "../src/pages/logs-filter-bar";
import { logsSurfaceKeyDown } from "../src/pages/logs-surface-keydown";

test("surface radios support wrapping arrows and Home/End with roving focus", () => {
  const previousDocument = globalThis.document;
  const win = new Window();
  Object.defineProperty(globalThis, "document", { configurable: true, value: win.document });
  try {
    for (const surface of ["all", "claude", "codex", "grok"]) {
      const button = win.document.createElement("button");
      button.id = `logs-surface-${surface}`;
      win.document.body.append(button);
    }
    const selected: string[] = [];
    const key = (value: string) => ({ key: value, preventDefault() {}, } as never);
    logsSurfaceKeyDown(key("ArrowRight"), "grok", surface => selected.push(surface));
    expect(selected).toEqual(["all"]);
    expect(win.document.activeElement?.id).toBe("logs-surface-all");
    logsSurfaceKeyDown(key("Home"), "codex", surface => selected.push(surface));
    expect(selected).toEqual(["all", "all"]);
    expect(win.document.activeElement?.id).toBe("logs-surface-all");
    logsSurfaceKeyDown(key("Enter"), "all", surface => selected.push(surface));
    expect(selected).toHaveLength(2);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    win.close();
  }
});

const translate: TFn = (key, vars) => key === "logs.filter.showingCount"
  ? `Showing ${vars?.count} of ${vars?.total}` : key;

async function withFilterBar(
  initial: LogFilterState,
  exercise: (ui: { container: HTMLElement; win: Window; filters: () => LogFilterState }) => Promise<void>,
): Promise<void> {
  const win = new Window({ url: "http://localhost/#logs" });
  const values = {
    document: win.document, window: win, navigator: win.navigator,
    localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let root: Root | undefined;
  let current = initial;
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const container = document.createElement("div");
    document.body.append(container);
    function Harness() {
      const [filters, setFilters] = useState(initial);
      useEffect(() => { current = filters; }, [filters]);
      return createElement(LogsFilterBar, {
        filters, options: { models: ["model-a", "model-a-plus"], providers: ["openai", "xai"] },
        hasActiveFilters: hasActiveLogFilters(filters), filteredCount: 1, totalCount: 2,
        t: translate, onFilterChange: setFilters,
        onResetFilters: () => setFilters({ ...DEFAULT_LOG_FILTER_STATE }),
      });
    }
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    await act(async () => { root!.render(createElement(LanguageProvider, null, createElement(Harness))); });
    await exercise({ container, win, filters: () => current });
  } finally {
    try {
      if (root) await act(async () => { root!.unmount(); });
    } finally {
      win.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
}

test("LogsFilterBar changes labeled selects without dropping other filters", async () => {
  await withFilterBar({ ...DEFAULT_LOG_FILTER_STATE, conversationId: "conversation-a" }, async ui => {
    for (const [field, value] of [["provider", "xai"], ["model", "model-a"], ["time", "15m"], ["status", "errors"]] as const) {
      const select = ui.container.querySelector<HTMLSelectElement>(`select[aria-label="logs.filter.${field}.label"]`);
      expect(select).not.toBeNull();
      await act(async () => {
        select!.value = value;
        select!.dispatchEvent(new ui.win.Event("change", { bubbles: true }));
      });
      expect(select!.value).toBe(value);
    }
    const intercepted = ui.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { intercepted.click(); });
    expect(ui.filters()).toMatchObject({
      provider: "xai", model: "model-a", timeWindow: "15m", status: "errors",
      conversationId: "conversation-a", interceptedOnly: true,
    });
    expect(ui.container.querySelector('input[aria-label="logs.filter.conversation.label"]')).not.toBeNull();
  });
});

test("LogsFilterBar speed choices have non-overlapping bounds and clear both bounds on All", async () => {
  await withFilterBar({ ...DEFAULT_LOG_FILTER_STATE, provider: "openai" }, async ui => {
    const select = ui.container.querySelector<HTMLSelectElement>('select[aria-label="logs.filter.speed.label"]')!;
    for (const [value, min, max] of [
      ["slow", undefined, 15], ["medium", 15, 50], ["fast", 50, undefined], ["all", undefined, undefined],
    ] as const) {
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new ui.win.Event("change", { bubbles: true }));
      });
      expect(select.value).toBe(value);
      expect(ui.filters().minTokPerSec).toBe(min);
      expect(ui.filters().maxTokPerSec).toBe(max);
      expect(ui.filters().provider).toBe("openai");
    }
  });
});

test.each(["pointer", "keyboard"] as const)("LogsFilterBar %s reset restores focus to All and clears every field", async activation => {
  await withFilterBar({
    ...DEFAULT_LOG_FILTER_STATE, surface: "grok", status: "errors", provider: "xai",
    model: "model-a", timeWindow: "1h", minTokPerSec: 50, interceptedOnly: true,
    conversationId: "conversation-a", conversationQueryHash: "cached-hash",
  }, async ui => {
    expect(ui.container.textContent).toContain("Showing 1 of 2");
    const reset = ui.container.querySelector<HTMLButtonElement>(".logs-filter-status button")!;
    expect(reset).not.toBeNull();
    reset.focus();
    expect(document.activeElement).toBe(reset);
    const all = ui.container.querySelector<HTMLButtonElement>("#logs-surface-all")!;
    const focus = jest.spyOn(all, "focus");
    try {
      // Native buttons dispatch click with detail=0 for keyboard activation.
      // Browser QA separately exercises Enter/Space's native event synthesis.
      await act(async () => {
        reset.dispatchEvent(new ui.win.MouseEvent("click", {
          bubbles: true, cancelable: true, detail: activation === "keyboard" ? 0 : 1,
        }));
      });
      expect(document.activeElement).toBe(all);
      expect(all.getAttribute("aria-checked")).toBe("true");
      expect(all.tabIndex).toBe(0);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      focus.mockRestore();
    }
    expect(ui.filters()).toEqual(DEFAULT_LOG_FILTER_STATE);
    expect(ui.container.querySelector(".logs-filter-status")).toBeNull();
    expect(ui.container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("");
    expect(ui.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(ui.container.querySelector<HTMLSelectElement>('select[aria-label="logs.filter.speed.label"]')!.value).toBe("all");
  });
});

test("LogsFilterBar rendered radios move selection, focus and the single tab stop together", async () => {
  await withFilterBar({ ...DEFAULT_LOG_FILTER_STATE }, async ui => {
    const radio = (surface: string) => ui.container.querySelector<HTMLButtonElement>(`#logs-surface-${surface}`)!;
    radio("all").focus();
    const moves = [
      ["ArrowLeft", "grok"], ["ArrowRight", "all"], ["ArrowDown", "claude"],
      ["ArrowUp", "all"], ["End", "grok"], ["Home", "all"],
    ] as const;
    for (const [key, expected] of moves) {
      const event = new ui.win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => { document.activeElement!.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
      expect(ui.filters().surface).toBe(expected);
      expect(document.activeElement).toBe(radio(expected));
      expect(radio(expected).getAttribute("aria-checked")).toBe("true");
      const radios = [...ui.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      expect(radios.filter(button => button.tabIndex === 0)).toEqual([radio(expected)]);
      expect(radios.filter(button => button.getAttribute("aria-checked") === "true")).toEqual([radio(expected)]);
    }
    const unrelated = new ui.win.KeyboardEvent("keydown", { key: "q", bubbles: true, cancelable: true });
    await act(async () => { radio("all").dispatchEvent(unrelated); });
    expect(unrelated.defaultPrevented).toBe(false);
    expect(ui.filters().surface).toBe("all");
    expect(document.activeElement).toBe(radio("all"));
  });
});
