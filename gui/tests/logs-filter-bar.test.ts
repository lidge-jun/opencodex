import { expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import type { TFn } from "../src/i18n/shared";
import { DEFAULT_LOG_FILTER_STATE, hasActiveLogFilters, type LogFilterState } from "../src/pages/logs-filter";
import { LogsFilterBar } from "../src/pages/logs-filter-bar";
import { chooseOption, selectTrigger, selectValue } from "./helpers/custom-select";

/** A filter dropdown (the app's Select trigger), found by its accessible name. */
const filterSelect = (field: string) => `[role="combobox"][aria-label="logs.filter.${field}.label"]`;

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
      const select = selectTrigger(ui.container, filterSelect(field));
      await chooseOption(select, value);
      expect(selectValue(select)).toBe(value);
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
    const select = selectTrigger(ui.container, filterSelect("speed"));
    for (const [value, min, max] of [
      ["slow", undefined, 15], ["medium", 15, 50], ["fast", 50, undefined], ["all", undefined, undefined],
    ] as const) {
      await chooseOption(select, value);
      expect(selectValue(select)).toBe(value);
      expect(ui.filters().minTokPerSec).toBe(min);
      expect(ui.filters().maxTokPerSec).toBe(max);
      expect(ui.filters().provider).toBe("openai");
    }
  });
});

test.each(["pointer", "keyboard"] as const)("LogsFilterBar %s reset restores focus to persistent search and clears every field", async activation => {
  await withFilterBar({
    ...DEFAULT_LOG_FILTER_STATE, status: "errors", provider: "xai",
    model: "model-a", timeWindow: "1h", minTokPerSec: 50, interceptedOnly: true,
    conversationId: "conversation-a", conversationQueryHash: ["cached-hash"],
  }, async ui => {
    expect(ui.container.textContent).toContain("Showing 1 of 2");
    const reset = ui.container.querySelector<HTMLButtonElement>(".logs-filter-status button")!;
    expect(reset).not.toBeNull();
    reset.focus();
    expect(document.activeElement).toBe(reset);
    const search = ui.container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const focus = jest.spyOn(search, "focus");
    try {
      // Native buttons dispatch click with detail=0 for keyboard activation.
      // Browser QA separately exercises Enter/Space's native event synthesis.
      await act(async () => {
        reset.dispatchEvent(new ui.win.MouseEvent("click", {
          bubbles: true, cancelable: true, detail: activation === "keyboard" ? 0 : 1,
        }));
      });
      expect(document.activeElement === search).toBe(true);
      expect(search.isConnected).toBe(true);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      focus.mockRestore();
    }
    expect(ui.filters()).toEqual(DEFAULT_LOG_FILTER_STATE);
    expect(ui.container.querySelector(".logs-filter-status")).toBeNull();
    expect(ui.container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("");
    expect(ui.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(selectValue(selectTrigger(ui.container, filterSelect("speed")))).toBe("all");
  });
});

test("LogsFilterBar has no surface radios or hidden client controls", async () => {
  await withFilterBar({ ...DEFAULT_LOG_FILTER_STATE }, async ui => {
    expect(ui.container.querySelector('[role="radiogroup"]') === null).toBe(true);
    expect(ui.container.querySelector('[role="radio"]') === null).toBe(true);
    expect(ui.container.querySelector('[id^="logs-surface-"]') === null).toBe(true);
    expect([...ui.container.querySelectorAll('[role="combobox"]')].map(node => node.getAttribute("aria-label")))
      .toEqual(["provider", "model", "time", "speed", "status", "protocol"].map(field => `logs.filter.${field}.label`));
  });
});

test("LogsFilterBar folds the secondary filters behind a Filters disclosure that keeps them mounted", async () => {
  await withFilterBar({ ...DEFAULT_LOG_FILTER_STATE }, async ui => {
    const toggle = [...ui.container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")]
      .find(button => button.textContent?.includes("logsV2.filters"))!;
    expect(toggle).toBeDefined();
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    // Folded fields stay reachable by label so their state survives the fold.
    expect(panel.querySelector(filterSelect("provider"))).not.toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
  });
});

test("LogsFilterBar shows each folded filter as a chip that clears only itself", async () => {
  await withFilterBar({
    ...DEFAULT_LOG_FILTER_STATE, provider: "xai", status: "errors", minTokPerSec: 50, conversationId: "conversation-a",
  }, async ui => {
    const chips = () => [...ui.container.querySelectorAll<HTMLButtonElement>('button[aria-label^="logsV2.removeFilter"]')];
    expect(chips()).toHaveLength(3);
    const toggle = [...ui.container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")]
      .find(button => button.textContent?.includes("logsV2.filters"))!;
    expect(toggle.textContent).toContain("3");
    const statusChip = chips().find(chip => chip.textContent?.includes("logs.filter.status.label"))!;
    await act(async () => { statusChip.click(); });
    expect(ui.filters()).toMatchObject({ status: "all", provider: "xai", minTokPerSec: 50, conversationId: "conversation-a" });
    expect(chips()).toHaveLength(2);
  });
});
