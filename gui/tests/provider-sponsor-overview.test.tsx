import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import ProviderSponsor from "../src/components/provider-workspace/ProviderSponsor";
import { matchingWorkspacePreset, type CatalogPreset } from "../src/components/provider-catalog/provider-presets";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const orca: CatalogPreset = {
  id: "orcarouter", label: "OrcaRouter - API", adapter: "openai-chat", auth: "key",
  baseUrl: "https://api.orcarouter.ai/v1", sponsor: "standard",
  sponsorUrl: "https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme",
  dashboardUrl: "https://www.orcarouter.ai/console",
};
const packy: CatalogPreset = {
  id: "packycode", label: "PackyCode", adapter: "openai-chat", auth: "key",
  baseUrl: "https://cf.api.fan/v1", sponsor: "standard",
  sponsorUrl: "https://www.packyapi.com/register?aff=k5KT",
  dashboardUrl: "https://www.packyapi.com/register?aff=k5KT",
};
const configured = (preset: CatalogPreset): WorkspaceItem => ({
  name: preset.id, adapter: preset.adapter, baseUrl: preset.baseUrl, authMode: preset.auth,
});
function render(preset?: CatalogPreset, item = configured(orca)) {
  return renderToStaticMarkup(<LanguageProvider><ProviderSponsor preset={preset} item={item} /></LanguageProvider>);
}

test("sponsor is matched by id, adapter and complete endpoint, tolerating trailing slash", () => {
  const item = configured(orca);
  const credentialEndpoint = new URL(item.baseUrl);
  credentialEndpoint.username = "fixture-user";
  credentialEndpoint.password = "fixture-password";
  expect(matchingWorkspacePreset({ ...item, baseUrl: `${item.baseUrl}/` }, [orca])).toBe(orca);
  for (const changed of [
    { name: "renamed" }, { adapter: "anthropic" }, { baseUrl: "https://other.example/v1" },
    { baseUrl: "https://api.orcarouter.ai/v2" }, { baseUrl: `${item.baseUrl}?key=secret` },
    { baseUrl: credentialEndpoint.href }, { baseUrl: "invalid" },
  ]) {
    expect(matchingWorkspacePreset({ ...item, ...changed }, [orca])).toBeUndefined();
    expect(render(orca, { ...item, ...changed })).toBe("");
  }
  expect(matchingWorkspacePreset(item, [])).toBeUndefined();
});

test("key and OAuth sponsor presets render disclosed links, keeping affiliate parameters", () => {
  // Only the key-auth `orcarouter` row carries `sponsor` in the registry today, so the oauth
  // case is the property that an auth mode never suppresses the block — not a second pinned row.
  for (const preset of [orca, { ...orca, id: "orcarouter-oauth", auth: "oauth" as const }]) {
    const html = render(preset, configured(preset));
    expect(html).toContain("pws-sponsor-badge");
    expect(html).toContain("utm_source=opencodex&amp;utm_medium=readme");
    expect(html).toContain('href="https://www.orcarouter.ai/console"');
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
  }
});

test("Packy preserves its affiliate link and does not repeat an identical console link", () => {
  const html = render(packy, configured(packy));
  expect(html).toContain('href="https://www.packyapi.com/register?aff=k5KT"');
  expect(html.match(/<a /g)).toHaveLength(1);
});

test("missing and non-sponsor presets render nothing; non-web links never become anchors", () => {
  expect(render()).toBe("");
  expect(render({ ...orca, sponsor: undefined })).toBe("");
  const html = render({ ...orca, sponsorUrl: "javascript:alert(1)", dashboardUrl: "data:text/html,bad" });
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("javascript:");
});

test("overview keeps the complete note exactly once in the wider editable section", () => {
  const note = "A provider limitation that must remain visible. https://example.test/details";
  const html = renderToStaticMarkup(<LanguageProvider><ProviderOverview item={{ ...configured(orca), note }} preset={orca} /></LanguageProvider>);
  expect(html.split(note)).toHaveLength(2);
  expect(html.indexOf("pws-notes-section")).toBeLessThan(html.indexOf("pws-overview-sidebar"));
});
