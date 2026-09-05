import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { DEFAULT_LOG_FILTER_STATE, type LogFilterState } from "../src/pages/logs-filter";
import { LogsFilterBar } from "../src/pages/logs-filter-bar";
import { logsSurfaceKeyDown } from "../src/pages/logs-surface-keydown";

test("Logs mounts the shared rich-filter predicate and filter bar", async () => {
  const source = await Bun.file(new URL("../src/pages/Logs.tsx", import.meta.url)).text();
  expect(source).toContain('import { LogsFilterBar } from "./logs-filter-bar";');
  expect(source).toContain("filterLogs(logs, filters, filterClockNow)");
  expect(source).toContain("extractLogFilterOptions(logs)");
  expect(source).not.toContain("logMatchesSurface(log, surfaceFilter)");
  expect(source).not.toContain("logMatchesModelQuery(log, modelFilter)");
});

test("relative time filters refresh their clock when the log snapshot is unchanged", async () => {
  const source = await Bun.file(new URL("../src/pages/Logs.tsx", import.meta.url)).text();
  expect(source).toContain("const [filterClockNow, setFilterClockNow] = useState(() => Date.now());");
  expect(source).toContain("window.setInterval(() => setFilterClockNow(Date.now()), LOGS_FILTER_CLOCK_INTERVAL_MS)");
  expect(source).toContain("filterLogs(logs, filters, filterClockNow)");
});

test("LogsFilterBar exposes every engine filter field and reset affordance", async () => {
  const source = await Bun.file(new URL("../src/pages/logs-filter-bar.tsx", import.meta.url)).text();
  for (const key of [
    "filters.surface", "filters.interceptedOnly", "filters.provider", "filters.model",
    "filters.timeWindow", "filters.minTokPerSec", "filters.maxTokPerSec", "filters.status",
    "filters.conversationId",
  ]) {
    expect(source).toContain(key);
  }
  expect(source).toContain('t("logs.filter.reset")');
});

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

test("LogsFilterBar renders labeled controls, count, and reset interaction", async () => {
  const win = new Window({ url: "http://localhost/#logs" });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    actEnvironment: (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const container = document.createElement("div");
    document.body.append(container);
    const updates: LogFilterState[] = [];
    const root = createRoot(container);
    const filters = { ...DEFAULT_LOG_FILTER_STATE };
    await act(async () => {
      root.render(createElement(LanguageProvider, null,
        createElement(LogsFilterBar, {
          filters: { ...filters, status: "errors" },
          options: { models: ["gpt-test"], providers: ["openai"] },
          hasActiveFilters: true,
          filteredCount: 1,
          totalCount: 2,
          t: ((key: string, vars?: Record<string, string | number>) => key === "logs.filter.showingCount" ? `Showing ${vars?.count} of ${vars?.total}` : key) as never,
          onFilterChange: next => updates.push(next),
          onResetFilters: () => updates.push(filters),
        }),
      ));
    });
    expect(container.querySelector('select[aria-label="logs.filter.status.label"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="logs.filter.provider.label"]')).not.toBeNull();
    expect(container.textContent).toContain("Showing 1 of 2");
    const reset = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("logs.filter.reset"));
    expect(reset).toBeTruthy();
    await act(async () => { reset!.click(); });
    expect(updates.at(-1)).toEqual(filters);
    await act(async () => { root.unmount(); });
  } finally {
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: previous.document },
      window: { configurable: true, value: previous.window },
      navigator: { configurable: true, value: previous.navigator },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
    win.close();
  }
});
