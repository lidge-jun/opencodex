import { expect, test } from "bun:test";

test("ApiKeys renders the single stacked layout (no layout toggle, no workspace rail)", async () => {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  expect(page).not.toContain("viewMode");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("ocx-apikeys-view");
  expect(page).not.toContain("ApiKeysWorkspace");
  expect(page).not.toContain("apikeys-workspace");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");

  expect(app).toContain("<ApiKeys apiBase={API_BASE} />");
  expect(css).not.toContain("styles-apikeys-workspace.css");
  expect(css).not.toContain("styles-claudecode-workspace.css");
});

test("ApiKeys stacked layout keeps endpoint, generate, keys table, and usage panels", async () => {
  const src = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();

  const order = [
    't("api.endpoint")',
    't("api.generateTitle")',
    't("api.activeKeys"',
    't("api.usageTitle")',
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }

  // Inline per-row delete confirmation, not a workspace detail pane.
  expect(src).toContain("confirmDelete === k.id");
  expect(src).toContain('t("api.noKeys")');
  expect(src).toContain('t("api.colKey")');
  // Double-create guard kept from the workspace era.
  expect(src).toContain("if (creatingRef.current) return false");
});

test("retired apikeys workspace i18n keys stay removed from every locale", async () => {
  const locales = ["en", "de", "ja", "ko", "ru", "zh"] as const;
  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).not.toContain('"api.workspace.');
    expect(dict).not.toContain('"claude.workspace.');
  }
});
