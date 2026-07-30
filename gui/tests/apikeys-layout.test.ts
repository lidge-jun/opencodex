import { expect, test } from "bun:test";

async function apiKeysSources(): Promise<string> {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const panels = await Bun.file(new URL("../src/pages/api-keys-panels.tsx", import.meta.url)).text();
  const workspace = await Bun.file(new URL("../src/components/apikeys-workspace/ApiKeysWorkspace.tsx", import.meta.url)).text();
  return `${page}\n${panels}\n${workspace}`;
}

test("ApiKeys uses workspace shell (no classic layout toggle)", async () => {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  expect(page).toContain("ApiKeysWorkspace");
  expect(page).not.toContain("viewMode");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("ocx-apikeys-view");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");

  expect(app).toContain("<ApiKeys apiBase={API_BASE} />");
  expect(css).toContain('@import "./styles-apikeys-workspace.css"');
  expect(css).toContain(".api-auth-list");
  expect(css).toContain(".api-test-note--ok");
  expect(css).toContain(".api-test-note--error");
});

test("ApiKeys workspace avoids nested main and stacks via container query", async () => {
  const src = await Bun.file(new URL("../src/components/apikeys-workspace/ApiKeysWorkspace.tsx", import.meta.url)).text();
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles-apikeys-workspace.css", import.meta.url)).text();

  expect(src).toContain('<section className="apikeys-workspace-main"');
  expect(src).not.toContain('<main className="apikeys-workspace-main"');
  expect(src).toContain('t("api.workspace.overview")');
  expect(src).toContain('t("api.workspace.details")');
  expect(src).toContain("showKeyList={false}");
  expect(page).toContain("creatingRef");
  expect(page).toContain("if (creatingRef.current) return false");
  // Cold paint: seed Endpoints from apiBase only when it has a usable origin/host.
  expect(page).toContain("seedEndpointsFromApiBase");
  expect(page).toContain("DEFAULT_ENDPOINTS");
  expect(page).toContain("if (!url.host) return DEFAULT_ENDPOINTS");

  expect(css).toContain("container-name: apikeys-workspace");
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("@container apikeys-workspace (max-width: 720px)");
  expect(css).toContain("@media (max-width: 768px)");
  expect(css).toContain("overflow-wrap: anywhere");
  expect(css).toContain(".awi-detail-toolbar");
  expect(css).toContain(".awi-back-chevron");
});

test("ApiKeys workspace keeps endpoint, generate, models, and usage panels", async () => {
  const src = await apiKeysSources();
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const workspace = await Bun.file(new URL("../src/components/apikeys-workspace/ApiKeysWorkspace.tsx", import.meta.url)).text();

  expect(src).toContain("ApiKeysEndpointsPanel");
  expect(src).toContain("ApiKeysManagePanel");
  expect(src).toContain("ApiKeysModelsPanel");
  expect(src).toContain("ApiKeysUsagePanel");
  expect(src).toContain('t("api.endpointsTitle")');
  expect(src).toContain('t("api.generateTitle")');
  expect(src).toContain('t("api.usageChatTitle")');
  expect(src).toContain('t("api.usageResponsesTitle")');
  expect(src).toContain('awi-usage-fold');
  expect(src).toContain('t("api.workspace.usageExamples")');
  // Auth lives folded under Endpoints — not a separate overview card.
  expect(workspace).not.toContain("api-auth-list");
  expect(src).toContain('awi-inline-fold');
  expect(src).toContain('t("api.authTitle")');
  expect(src).toContain('t("api.authChatCompletions")');

  // Exactly one Messages usage example, gated on Claude inbound.
  expect(src.match(/api\.usageMessagesTitle/g)?.length).toBe(1);
  const messagesUsageIdx = src.indexOf('t("api.usageMessagesTitle")');
  expect(messagesUsageIdx).toBeGreaterThan(-1);
  const gateOpenIdx = src.lastIndexOf("claudeCodeEnabled && (", messagesUsageIdx);
  expect(gateOpenIdx).toBeGreaterThan(-1);
  const between = src.slice(gateOpenIdx, messagesUsageIdx);
  expect(between).not.toContain('t("api.usageChatTitle")');
  expect(between).not.toContain('t("api.usageResponsesTitle")');
  expect(src).toContain("gatewayInboundProtocols(claudeCodeEnabled)");
  expect(page).toContain("classifyExternalModel(row)");
  expect(page).toContain('from "../api-access-models"');
});

test("apikeys workspace i18n keys exist in every locale", async () => {
  const locales = ["en", "de", "ja", "ko", "ru", "zh"] as const;
  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).toContain('"api.workspace.overview":');
    expect(dict).toContain('"api.workspace.details":');
    expect(dict).toContain('"api.workspace.deleteKey":');
    expect(dict).toContain('"api.workspace.usageExamples":');
    expect(dict).toContain('"api.copyUrlHint":');
    expect(dict).toContain('"api.urlCopied":');
    expect(dict).toContain('"api.copyExampleHint":');
    expect(dict).toContain('"api.exampleCopied":');
  }
});
