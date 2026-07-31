import { expect, test } from "bun:test";

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
  const locales = ["en", "de", "ja", "ko", "ru", "zh"] as const;
  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).toContain('"usage.workspace.sections":');
    expect(dict).toContain('"usage.workspace.report":');
  }
});
