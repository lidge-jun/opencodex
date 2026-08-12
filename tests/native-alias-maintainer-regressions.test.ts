import { expect, test } from "bun:test";
import {
  catalogHasRoutedEntries,
  type CatalogModel,
  type RawEntry,
} from "../src/codex/catalog/parsing";
import {
  buildCatalogEntries,
  mergeCatalogEntriesForSync,
  mergeCatalogModelsWithNativeRecovery,
} from "../src/codex/catalog/sync";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "../src/codex/catalog/kinds";

function aliasModel(slug: string): CatalogModel {
  return {
    id: `alias-${slug}`,
    provider: "combo",
    alias: slug,
    nativeAlias: true,
    displayName: `Routed ${slug}`,
    owned_by: "combo",
    contextWindow: 128_000,
    maxInputTokens: 100_000,
    inputModalities: ["text", "image"],
    reasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "medium",
  };
}

test("native-alias catalog rows are routed state, never pristine backup input", () => {
  expect(catalogHasRoutedEntries({
    models: [{
      slug: "gpt-5.6-sol",
      owned_by: "combo",
      opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
    }],
  })).toBe(true);
});

test("native recovery copies nested reasoning metadata instead of mutating the source", () => {
  const source: RawEntry = {
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    service_tiers: [{ id: "priority", display_name: "Fast" }],
  };
  const merged = mergeCatalogModelsWithNativeRecovery([], [[source]]);
  const recovered = merged.find(row => row.slug === "gpt-5.6-sol");
  expect(recovered).toBeDefined();
  const levels = recovered!.supported_reasoning_levels as Array<Record<string, unknown>>;
  levels.push({ effort: "ultra", description: "Ultra" });
  const tiers = recovered!.service_tiers as Array<Record<string, unknown>>;
  tiers[0]!.display_name = "Changed";
  expect(source.supported_reasoning_levels).toEqual([{ effort: "medium", description: "Medium" }]);
  expect(source.service_tiers).toEqual([{ id: "priority", display_name: "Fast" }]);
  expect(recovered).not.toBe(source);
  expect(recovered!.supported_reasoning_levels).not.toBe(source.supported_reasoning_levels);
  expect(recovered!.service_tiers).not.toBe(source.service_tiers);
});

test("disabled native slugs do not leak through account-qualified clones", () => {
  const slug = "gpt-5.5";
  const rows = buildCatalogEntries(
    null, [slug], [], undefined, false, "default", new Set(), ["main"],
    new Set([slug]), new Set([slug]),
  );
  expect(rows.find(row => row.slug === slug)).toBeUndefined();
  expect(rows.find(row => row.slug === `main/${slug}`)).toBeUndefined();
});

test("disabling a shadowed native row keeps its compatibility combo but removes the account clone", () => {
  const slug = "gpt-5.6-sol";
  const rows = buildCatalogEntries(
    null, [slug], [aliasModel(slug)], undefined, false, "default", new Set([slug]), ["main"],
    new Set([slug]), new Set([slug]),
  );
  expect(rows.find(row => row.slug === slug)?.opencodex_catalog_kind).toBe(CODEX_NATIVE_ALIAS_CATALOG_KIND);
  expect(rows.find(row => row.slug === `main/${slug}`)).toBeUndefined();
});

test("duplicate native aliases keep the first combo deterministically", () => {
  const slug = "gpt-5.6-sol";
  const first = { ...aliasModel(slug), id: "first", displayName: "First" };
  const second = { ...aliasModel(slug), id: "second", displayName: "Second" };
  const rows = buildCatalogEntries(null, [slug], [first, second], undefined, false, "default", new Set([slug]));
  expect(rows.filter(row => row.slug === slug)).toHaveLength(1);
  expect(rows.find(row => row.slug === slug)?.display_name).toBe("First");
});

test("transient preservation keeps a native alias without input modalities", () => {
  const slug = "gpt-5.6-sol";
  const existing: RawEntry = {
    slug,
    display_name: "Nova Sol",
    owned_by: "combo",
    opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
    visibility: "list",
  };
  const rows = mergeCatalogEntriesForSync(
    [existing], [], new Map(), [], false, new Set(), null, new Set(), new Set(),
    "default", new Set([slug]), false, true, [], new Set([slug]),
  );
  expect(rows.find(row => row.slug === slug)).toBeDefined();
});

test("native aliases retain upstream multi-agent pins in default mode", () => {
  for (const [slug, expected] of [["gpt-5.6-sol", "v2"], ["gpt-5.6-luna", "v1"]] as const) {
    const rows = buildCatalogEntries(
      null,
      [slug],
      [aliasModel(slug)],
      undefined,
      false,
      "default",
      new Set([slug]),
    );
    expect(rows.find(row => row.slug === slug)?.multi_agent_version).toBe(expected);
  }
});

test("a featured bare native alias does not feature its account-qualified OpenAI clone", () => {
  const slug = "gpt-5.6-sol";
  const rows = buildCatalogEntries(
    null,
    [slug],
    [aliasModel(slug)],
    [slug],
    false,
    "default",
    new Set([slug]),
    ["main"],
  );
  const routed = rows.find(row => row.slug === slug)!;
  const account = rows.find(row => row.slug === `main/${slug}`)!;
  expect(routed.priority).toBe(0);
  expect(account.priority).not.toBe(0);

  const exactRows = buildCatalogEntries(
    null,
    [slug],
    [aliasModel(slug)],
    [`main/${slug}`],
    false,
    "default",
    new Set([slug]),
    ["main"],
  );
  expect(exactRows.find(row => row.slug === `main/${slug}`)?.priority).toBe(0);
});
