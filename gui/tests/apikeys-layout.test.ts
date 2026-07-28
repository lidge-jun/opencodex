import { expect, test } from "bun:test";

async function apiKeysSources(): Promise<string> {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const panels = await Bun.file(new URL("../src/pages/api-keys-panels.tsx", import.meta.url)).text();
  return `${page}\n${panels}`;
}

test("ApiKeys renders the single stacked layout (no layout toggle, no workspace rail)", async () => {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const src = await apiKeysSources();
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
  expect(css).toContain(".api-auth-list");
  expect(css).toContain(".api-test-note--ok");
  expect(css).toContain(".api-test-note--error");
  expect(src).toContain('className="api-auth-list');
  expect(src).toContain("api-test-note--ok");
});

test("ApiKeys stacked layout keeps endpoint, generate, keys table, and usage panels", async () => {
  const src = await apiKeysSources();
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();

  const order = [
    't("api.endpointsTitle")',
    't("api.generateTitle")',
    't("api.activeKeys"',
    't("api.usageChatTitle")',
    't("api.usageResponsesTitle")',
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }

  // Exactly one Messages usage example, gated on Claude inbound.
  expect(src.match(/api\.usageMessagesTitle/g)?.length).toBe(1);
  const messagesUsageIdx = src.indexOf('t("api.usageMessagesTitle")');
  expect(messagesUsageIdx).toBeGreaterThan(-1);
  const gateOpenIdx = src.lastIndexOf("claudeCodeEnabled && (", messagesUsageIdx);
  expect(gateOpenIdx).toBeGreaterThan(-1);
  // No other usage title may sit between the gate and the Messages title.
  const between = src.slice(gateOpenIdx, messagesUsageIdx);
  expect(between).not.toContain('t("api.usageChatTitle")');
  expect(between).not.toContain('t("api.usageResponsesTitle")');
  expect(src).toContain("gatewayInboundProtocols(claudeCodeEnabled)");
  expect(page).toContain("classifyExternalModel(row)");
  expect(page).toContain('from "../api-access-models"');

  // Inline per-row delete confirmation, not a workspace detail pane.
  expect(src).toContain("confirmDelete === k.id");
  expect(src).toContain('t("api.noKeys")');
  expect(src).toContain('t("api.colKey")');
  // Double-create guard kept from the workspace era.
  expect(page).toContain("if (creatingRef.current) return false");
});

test("retired apikeys workspace i18n keys stay removed from every locale", async () => {
  const locales = ["en", "de", "ja", "ko", "ru", "zh", "zh-TW"] as const;
  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).not.toContain('"api.workspace.');
    expect(dict).not.toContain('"claude.workspace.');
  }
});
