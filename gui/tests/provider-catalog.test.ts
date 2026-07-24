import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  accessGroupCounts,
  curatedPresets,
  filterByAccessGroup,
  filterPresets,
  freeCatalogSections,
  isPresetActionable,
  type CatalogPreset,
} from "../src/components/provider-catalog/provider-presets";
import { FREE_PROVIDER_DIRECTORY } from "../../src/providers/free-directory";
import { deriveProviderPresets } from "../../src/providers/derive";

const rows: CatalogPreset[] = FREE_PROVIDER_DIRECTORY.map(row => ({
  id: row.id,
  label: row.label,
  adapter: row.adapter,
  baseUrl: row.baseUrl,
  auth: row.authKind,
  accessGroups: row.accessGroups,
  supportLevel: row.supportLevel,
}));

test("curated directory keeps 81 unique providers and counts glm-cn in both groups", () => {
  expect(curatedPresets(rows)).toHaveLength(81);
  expect(accessGroupCounts(rows)).toEqual({
    "recurring-or-keyless": 43,
    "recurring-uncapped": 13,
    "recurring-credit": 2,
    "signup-credit": 24,
  });
  expect(filterByAccessGroup(rows, "recurring-uncapped").some(row => row.id === "glm-cn")).toBe(true);
  expect(filterByAccessGroup(rows, "signup-credit").some(row => row.id === "glm-cn")).toBe(true);
});

test("actual preset projection keeps the 81-row directory and seven legacy free providers reachable", () => {
  const presets: CatalogPreset[] = deriveProviderPresets().filter(row => row.id !== "custom").map(row => ({
    id: row.id,
    label: row.label,
    adapter: row.adapter,
    baseUrl: row.baseUrl,
    auth: row.auth,
    keyOptional: row.keyOptional,
    freeTier: row.freeTier,
    accessGroups: row.accessGroups,
  }));
  const sections = freeCatalogSections(presets);
  expect(sections.directory).toHaveLength(81);
  expect(sections.existing.map(row => row.id)).toEqual([
    "ollama", "vllm", "lm-studio", "litellm", "opencode-free", "mimo-free", "cloudflare-workers-ai",
  ]);
});

test("search matches provider label/id and reference presets are not actionable", () => {
  expect(filterPresets(rows, "google gemini").map(row => row.id)).toEqual(["gemini"]);
  expect(isPresetActionable(rows.find(row => row.id === "duckduckgo-web")!)).toBe(false);
  expect(isPresetActionable(rows.find(row => row.id === "groq")!)).toBe(true);
});

test("provider connections only show connected accounts and configured API keys", () => {
  const panel = readFileSync(new URL("../src/components/providers/OAuthPanel.tsx", import.meta.url), "utf8");
  const pools = readFileSync(new URL("../src/hooks/useProviderAccountPools.ts", import.meta.url), "utf8");
  expect(panel).toContain("oauthStatus[provider]?.loggedIn || busy === provider");
  expect(panel).toContain('provider.authMode === "forward"');
  expect(panel).toContain('href="#codex-auth"');
  expect(panel).toContain('t("pws.tab.accounts")');
  expect(panel).toContain('t("pws.apiKeys")');
  expect(pools).toMatch(/p\.hasApiKey\s*&&\s*p\.authMode\s*!==\s*"oauth"\s*&&\s*p\.authMode\s*!==\s*"forward"/);
});

test("provider cards retain compact visual quota bars", () => {
  const cards = readFileSync(new URL("../src/components/providers/ProviderCardList.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  expect(cards).toContain('className="provider-quota"');
  expect(cards).not.toContain('layout="summary"');
  expect(css).toMatch(/\.quota-row\s*\{[^}]*grid-template-columns:/);
  expect(css).toMatch(/\.bar\s*\{[^}]*height:/);
});

test("provider cards keep content and resource rows aligned", () => {
  const cards = readFileSync(new URL("../src/components/providers/ProviderCardList.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  expect(cards).toContain('className="prov-card-resource"');
  expect(css).toMatch(/\.prov-card\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto minmax\(27px, auto\);/);
  expect(css).toMatch(/\.provider-card-grid\s*\{[^}]*align-items:\s*stretch;/);
  expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.prov-card-main\s*\{[^}]*grid-template-columns:\s*1fr;/);
});

test("classic provider workspace exposes connection intents and a compact provider grid", () => {
  const panel = readFileSync(new URL("../src/components/providers/OAuthPanel.tsx", import.meta.url), "utf8");
  const cards = readFileSync(new URL("../src/components/providers/ProviderCardList.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/pages/Providers.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  expect(panel).toContain('onAddProvider({ tier: "accounts" })');
  expect(panel).toContain('onAddProvider({ tier: "paid" })');
  expect(panel).toContain('onAddProvider({ custom: true })');
  expect(cards).toContain('className="provider-card-grid"');
  expect(cards).toContain('t("dash.tokens30d")');
  expect(page).toContain('fetch(`${apiBase}/api/usage?range=30d`)');
  expect(page).toContain('initialTier={addIntent?.tier}');
  expect(page).toContain('initialCustom={addIntent?.custom}');
  expect(css).toMatch(/\.provider-card-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
  expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.provider-card-grid\s*\{[^}]*grid-template-columns:\s*1fr;/);
});

test("providers page uses the wide content shell", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  expect(app).toContain('page === "providers" ? " main-inner--providers" : ""');
  expect(styles).toContain(".main-inner.main-inner--providers { max-width: 1440px; }");
});
