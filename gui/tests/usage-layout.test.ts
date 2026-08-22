import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Usage from "../src/pages/Usage";

test("Usage renders every section in one scrollable column with a sticky strip", async () => {
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  expect(page).not.toContain("viewMode");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("ocx-usage-view");
  expect(page).toContain("UsageWorkspaceBody");
  expect(page).toContain("UsageWorkspaceSection");
  expect(page).toContain("usage-workspace-");
  expect(page).toContain("usw-");
  // Sections are anchors in one document, not a swapped panel: the old `selectedSection`
  // state rendered exactly one section, which is why the page could not be read by scrolling.
  expect(page).not.toContain("selectedSection");
  expect(page).toContain("<SectionTabs");
  expect(page).toContain("sectionAnchorId");

  expect(app).toContain("<Usage apiBase={API_BASE} />");
  expect(css).toContain("styles-usage-workspace.css");
  // The strip has to stay reachable while reading down the page.
  expect(css).toContain(".section-tabs");
  expect(css).toContain("position: sticky");
});

test("Usage workspace sections mount report panels in order", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();

  const order = [
    "<UsageSummaryCards",
    "<UsageHeatmapPanel",
    "<UsageModelsTable",
    "<UsageProvidersTable",
    "<UsageCoveragePanel",
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }

  expect(src).toContain("UsageWorkspaceBody");
  expect(src).toContain("usw-section");
});

test("Usage loading and empty states guard the workspace body", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  expect(src).toContain("state.showSkeleton && !data");
  expect(src).toContain("DataSurfaceSkeleton");
  expect(src).toContain('t("usage.loading")');
  expect(src).toContain('t("usage.empty")');
  expect(src).toContain("data.summary.requests === 0");
});

test("usage workspace i18n keys exist in every locale", async () => {
  const locales = ["en", "de", "fr", "ja", "ko", "ru", "zh", "zh-TW"] as const;
  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).toContain('"usage.workspace.sections":');
    expect(dict).toContain('"usage.workspace.report":');
    expect(dict).toContain('"usage.range.available":');
    expect(dict).toContain('"usage.historyTruncated":');
    expect(dict).toContain('"usage.historyTruncatedWindow":');
    expect(dict).toContain('"api.attribution.totalRequestsAvailable":');
  }
});

test("Usage renders Available history and a persistent qualification when history is capped", async () => {
  const globalKeys = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(globalKeys.map(key => [key, Reflect.get(globalThis, key)]));
  const originalFetch = globalThis.fetch;
  const testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
  globalThis.fetch = (async () => Response.json({
    range: "30d",
    surface: "all",
    since: null,
    generatedAt: Date.now(),
    summary: {
      requests: 0,
      measuredRequests: 0,
      reportedRequests: 0,
      unreportedRequests: 0,
      unsupportedRequests: 0,
      estimatedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      coverageRatio: 1,
    },
    days: [],
    models: [],
    providers: [],
    historyTruncated: true,
    truncatedPrefixBytes: 1,
    entriesTruncated: false,
    entriesDropped: 0,
  })) as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(LanguageProvider, null, createElement(Usage, { apiBase: "http://usage-qualification-test" })));
    });
    const deadline = Date.now() + 1_000;
    while (!(container.textContent ?? "").includes("Totals cover available history only")) {
      if (Date.now() >= deadline) throw new Error("Usage qualification did not render");
      await act(async () => {
        await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
      });
    }

    expect(container.querySelector('button[aria-label="Available history"]')).not.toBeNull();
    expect(container.textContent).toContain("Totals cover available history only because older usage was not loaded.");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.fetch = originalFetch;
    clearClientResourceStoresForTests();
    testWindow.close();
    for (const key of globalKeys) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  }
});

test("Usage names the loaded window when history is truncated", async () => {
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();

  // #1497: when the proxy reports the window it actually loaded, the notice must name that
  // window instead of the generic wording — otherwise `30d` and "Available history" stay
  // indistinguishable on a busy installation. `!= null` keeps an older proxy that omits the
  // fields on the generic string rather than rendering "Invalid Date".
  expect(page).toContain("usage.historyTruncatedWindow");
  // Presence alone is not enough: a hand-edited row can carry a timestamp outside Date's
  // range, so both bounds must round-trip through Date before the detailed wording is used.
  expect(page).toContain("function renderableInstant");
  expect(page).toContain("Number.isFinite(at.getTime())");
  // A total that silently omits in-range rows is a caveat, not a status update.
  expect(page).toContain('<Notice tone="warn">');
});

test("Usage falls back to the generic caveat when a reported bound is unrenderable", async () => {
  const globalKeys = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(globalKeys.map(key => [key, Reflect.get(globalThis, key)]));
  const originalFetch = globalThis.fetch;
  const testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
  // A timestamp beyond Date's supported range. Rendering it would put the literal string
  // "Invalid Date" inside a notice whose entire purpose is to be trustworthy.
  globalThis.fetch = (async () => Response.json({
    range: "30d",
    surface: "all",
    since: null,
    generatedAt: Date.now(),
    summary: {
      requests: 0,
      measuredRequests: 0,
      reportedRequests: 0,
      unreportedRequests: 0,
      unsupportedRequests: 0,
      estimatedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      coverageRatio: 1,
    },
    days: [],
    models: [],
    providers: [],
    historyTruncated: true,
    truncatedPrefixBytes: 1,
    entriesTruncated: false,
    entriesDropped: 0,
    snapshotWindowStart: 1e18,
    snapshotWindowEnd: 1e18,
  })) as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(LanguageProvider, null, createElement(Usage, { apiBase: "http://usage-invalid-window-test" })));
    });
    const deadline = Date.now() + 1_000;
    while (!(container.textContent ?? "").includes("Totals cover available history only")) {
      if (Date.now() >= deadline) throw new Error("Usage fallback qualification did not render");
      await act(async () => {
        await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
      });
    }
    expect(container.textContent).not.toContain("Invalid Date");
    expect(container.textContent).not.toContain("request start times ranging");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.fetch = originalFetch;
    clearClientResourceStoresForTests();
    testWindow.close();
    for (const key of globalKeys) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  }
});

test("Usage source marks keep brand colors and invert only the monochrome Grok mark", async () => {
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  // Claude and Codex ship brand-colored SVGs and must not carry the mono modifier.
  expect(page).toContain('src="/provider-icons/claude-color.svg"');
  expect(page).not.toContain('usage-source-mark usage-source-mark--mono" src="/provider-icons/claude-color.svg"');
  expect(page).toContain('src="/provider-icons/openai.svg"');
  expect(page).not.toContain('usage-source-mark usage-source-mark--mono" src="/provider-icons/openai.svg"');

  // Grok ships a black monochrome mark: it is the only one that needs dark-theme inversion.
  expect(page).toContain('usage-source-mark usage-source-mark--mono" src="/provider-icons/grok.svg"');

  // Dark-theme inversion must be scoped to the mono modifier so brand hues survive.
  expect(css).toContain(':root[data-theme="dark"] .usage-source-mark--mono { filter: invert(1); }');
  expect(css).not.toContain(':root[data-theme="dark"] .usage-source-mark { filter: invert(1); }');
  // The OS dark-mode (prefers-color-scheme) path must keep the same scoping.
  expect(css).toContain(':root:not([data-theme="light"]) .usage-source-mark--mono { filter: invert(1); }');
  expect(css).not.toContain(':root:not([data-theme="light"]) .usage-source-mark { filter: invert(1); }');
});
