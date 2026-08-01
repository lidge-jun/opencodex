import { expect, test } from "bun:test";
import { DICTS, type Locale } from "../src/i18n/shared";

async function apiKeysSources(): Promise<string> {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const panels = await Bun.file(new URL("../src/pages/api-keys-panels.tsx", import.meta.url)).text();
  // The endpoints/auth surface moved into its own module when the matrix landed.
  const endpointsPanel = await Bun.file(new URL("../src/pages/api-keys-endpoints-panel.tsx", import.meta.url)).text();
  const workspace = await Bun.file(new URL("../src/components/apikeys-workspace/ApiKeysWorkspace.tsx", import.meta.url)).text();
  return `${page}\n${panels}\n${endpointsPanel}\n${workspace}`;
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
  // The fold is gone: the examples are an open panel now. The dedicated test
  // below owns that assertion; this one only checks the panel still exists.
  expect(src).toContain("awi-usage-panel");
  expect(src).toContain('t("api.workspace.usageExamples")');
  // Auth is a server-driven matrix under Endpoints, not collapsed prose and not
  // a separate overview card. The prose it replaced told users that Chat
  // Completions accepts `Authorization: Bearer`, which the server rejects.
  expect(workspace).not.toContain("api-auth-list");
  expect(src).toContain("api-auth-matrix");
  expect(src).toContain('t("api.authTitle")');
  expect(src).not.toContain('t("api.authChatCompletions")');
  expect(src).not.toContain("awi-inline-fold");
  // The matrix must come from the payload, never from a hardcoded table.
  expect(src).toContain("authMatrix.map");

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

test("every locale has exactly the English api namespace", () => {
  // The previous version of this test named eight literals out of a surface
  // that had seventy-four. It passed while five locales were missing the same
  // key. Compare the loaded dictionaries instead: this catches missing AND
  // extra keys, in all six files, without searching source text.
  const locales: Locale[] = ["en", "de", "ja", "ko", "ru", "zh"];
  const englishApiKeys = Object.keys(DICTS.en).filter(key => key.startsWith("api.")).sort();

  // Activation guard: swapping the extraction back to a curated subset fails.
  expect(englishApiKeys.length).toBeGreaterThan(8);
  for (const locale of locales) {
    const localeApiKeys = Object.keys(DICTS[locale]).filter(key => key.startsWith("api.")).sort();
    expect(localeApiKeys).toEqual(englishApiKeys);
  }
  // Present in every dictionary, rendered nowhere. Deleted deliberately, so
  // the absence is asserted rather than merely happening to be true.
  expect(englishApiKeys).not.toContain("api.workspace.selectKeyHint");
});

test("the page owns vertical scroll; the model catalog is the only capped region", async () => {
  const css = await Bun.file(new URL("../src/styles-apikeys-workspace.css", import.meta.url)).text();

  // The desktop viewport lock is gone with no replacement. Its nested
  // `contain` scrollers were what kept the wheel from reaching the document.
  expect(css).not.toContain("100dvh");
  expect(css).not.toContain("overscroll-behavior: contain");
  expect(css).not.toMatch(/@media \(min-width: 1100px\)/);

  // Exactly one vertical cap on a content region, and it belongs to the table.
  const verticalCaps = [...css.matchAll(/max-height:\s*([^;]+);/g)]
    .map(match => match[1]!.trim())
    .filter(value => value !== "none");
  expect(verticalCaps).toEqual(["min(574px, 58vh)"]);
  const scrollRule = css.slice(css.indexOf(".api-models-panel > .api-models-scroll"));
  expect(scrollRule.slice(0, scrollRule.indexOf("}"))).toContain("overscroll-behavior: auto");

  // A header that scrolls away turns a long catalog into unlabeled columns.
  const stickyHead = css.slice(css.indexOf(".api-models-scroll thead th"));
  expect(stickyHead.slice(0, stickyHead.indexOf("}"))).toContain("position: sticky");

  // `.api-panel { overflow: hidden }` is shared by every panel on the tab and
  // is right for all of them except this one: a clipping ancestor eats the
  // wheel event at the end of the table instead of handing it to the page.
  // Verified in a browser — the handoff was dead until this override existed.
  const modelsPanel = css.slice(css.indexOf(".awi-overview-right > .api-models-panel"));
  expect(modelsPanel.slice(0, modelsPanel.indexOf("}"))).toContain("overflow: visible");

  // Cross-unit contract with 260731_client_config_export: its JSON block reuses
  // these selectors and inherits the wheel behavior. Scoping them to the usage
  // panel would silently re-trap that panel's scroll.
  expect(css).toMatch(/^\.api-example-pre \{/m);
  expect(css).toMatch(/^\.api-example-copy-btn \{/m);
  expect(css).not.toContain(".awi-usage-panel .api-example-pre");
  expect(css).not.toContain(".awi-usage-fold");
});

test("usage examples are document content, and the left column keeps its order", async () => {
  const panels = await Bun.file(new URL("../src/pages/api-keys-panels.tsx", import.meta.url)).text();
  const workspace = await Bun.file(new URL("../src/components/apikeys-workspace/ApiKeysWorkspace.tsx", import.meta.url)).text();

  expect(panels).not.toContain("<details className");
  expect(panels).toContain("awi-usage-panel");
  // All three examples survive the un-collapsing, Messages still gated.
  expect(panels).toContain('t("api.usageChatTitle")');
  expect(panels).toContain('t("api.usageResponsesTitle")');
  expect(panels).toContain('t("api.usageMessagesTitle")');

  // 260731_client_config_export inserts into this column; its position depends
  // on these three staying in this order.
  const order = ["ApiKeysManagePanel", "ApiKeysEndpointsPanel", "ApiKeysUsagePanel"]
    .map(name => workspace.indexOf(`<${name}`));
  expect(order.every(index => index > -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});
