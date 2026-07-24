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

test("provider browser lets its row list scroll inside the modal", () => {
  const css = readFileSync(new URL("../src/styles/provider-catalog.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.provider-catalog-browser\s*\{[^}]*min-height:\s*0;/);
  expect(css).toMatch(/\.provider-catalog-rows\s*\{[^}]*overflow-y:\s*auto;/);
});
