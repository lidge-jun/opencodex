import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { normalizeComboConfig } from "../../src/combos";
import { saveConfig } from "../../src/config";
import { SUBAGENT_MODELS_VERSION } from "../../src/config/subagent-models";
import { comboCatalogDescriptions, deriveComboCatalogModel } from "../../src/codex/catalog/aggregation";
import { applyAutoReviewModelOverride } from "../../src/codex/catalog/auto-review";
import {
  buildCatalogEntriesFromObservedState, CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
  isOcxAuthoredRoutedEntry, mergeCatalogEntriesFromObservedState,
  resetCatalogRuntimeStateForTests, type ObservedCatalogMergeInput,
} from "../../src/codex/catalog/build-entries";
import { deriveEntry, finishUpstreamNativeEntry } from "../../src/codex/catalog/derive-entry";
import { upstreamNativeEntry } from "../../src/codex/catalog/metadata";
import { catalogHasRoutedEntries, findNativeTemplate, findSupportedNativeTemplate,
  type CatalogModel, type RawEntry } from "../../src/codex/catalog/parsing";
import { ocxRoutedNamespaceCounts } from "../../src/codex/catalog/routed-removal";
import { syncCatalogModels } from "../../src/codex/catalog/retained-sync";
import { hasOcxComboAuthorship, hasOcxRoutedAuthorship } from "../../src/codex/catalog/ownership";
import { classifyNativeRoutedResidue } from "../../src/codex/native-residue";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { resetCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import type { OcxComboConfig, OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const generated = "Routed via opencodex → combo (combo).";
const marker = { opencodex_routed_origin: "combo-v1" };
const targets = [{ provider: "fixture", model: "model" }];
const member: CatalogModel = { provider: "fixture", id: "model", contextWindow: 128_000,
  inputModalities: ["text"], reasoningEfforts: ["high"] };
const native = (): RawEntry => ({ slug: "gpt-5.6-sol", display_name: "Fixture Sol", description: "Upstream Sol description",
  priority: 9, visibility: "list", base_instructions: "You are Codex.", input_modalities: ["text"],
  supported_reasoning_levels: [{ effort: "high", description: "High" }], default_reasoning_level: "high" });
let home: TempHome;
let previousCli: string | undefined;
let network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-combo-description-catalog-");
  mkdirSync(home.codexHome);
  previousCli = process.env.CODEX_CLI_PATH;
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  if (previousCli === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCli;
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  resetCodexModelEntitlementCacheForTests();
  home.remove();
});
function comboModel(extra: Partial<OcxComboConfig> = {}): CatalogModel {
  const model = deriveComboCatalogModel("saved", normalizeComboConfig({ targets, ...extra }), [member]);
  expect(model).not.toBeNull();
  return model!;
}
function build(model: CatalogModel, template: RawEntry | null = native()): RawEntry[] {
  const slug = model.alias ?? "combo/saved";
  return buildCatalogEntriesFromObservedState({
    template, gptSlugs: ["gpt-5.6-sol"], goModels: [model], featured: [],
    wsEnabled: false, multiAgentMode: "default", multiAgentV2Enabled: false,
    exactComboSlugs: new Set([slug]), accountSelectors: ["account"],
    suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
  });
}
function merge(input: Pick<ObservedCatalogMergeInput, "catalogModels" | "routedEntries"> & Partial<ObservedCatalogMergeInput>): RawEntry[] {
  return mergeCatalogEntriesFromObservedState({
    baselineCatalogModels: [], baseline: new Map(), featured: [], wsEnabled: false,
    template: native(), disabledModels: new Set(), selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(), degradedProviderNames: new Set(), legacyCustomModelSlugs: new Set(),
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
    hasPhysicalComboProvider: false, includeNativeOpenAi: false, accountBoundEntries: [],
    policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "silent" }, ...input,
  });
}
function retain(row: RawEntry, comboDescriptions?: ReadonlyMap<string, string>): RawEntry[] {
  return merge({ catalogModels: [row], routedEntries: [], comboDescriptions,
    exactComboSlugs: new Set([String(row.slug)]), hasPhysicalComboProvider: true,
    gatheredProviderNames: new Set(["vendor"]), degradedProviderNames: new Set(["vendor"]) });
}

describe("retained combo descriptions (#7229)", () => {
  const oldNativeAlias = () => build(comboModel({ alias: "gpt-5.6-sol", nativeAlias: true, description: "Old" }))
    .find(row => row.slug === "gpt-5.6-sol")!;

  test("retained native alias replaces its stale marked description with the current override", () => {
    const old = oldNativeAlias();
    expect(old).toMatchObject({ description: "Old", ...marker });
    const rows = retain(old, new Map([["gpt-5.6-sol", "New"]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: "gpt-5.6-sol", description: "New", ...marker });
    expect(old.description).toBe("Old");
  });

  test("clearing a retained native alias description restores generated text and removes its marker", () => {
    const rows = retain(oldNativeAlias(), new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: "gpt-5.6-sol", description: generated });
    expect(rows[0]).not.toHaveProperty("opencodex_routed_origin");
  });

  test("legacy merges without comboDescriptions preserve the retained description and marker", () => {
    const old = oldNativeAlias();
    expect(retain(old)).toEqual([old]);
  });

  test("a retained slash alias with generated combo authorship gains the current description", () => {
    const old = build(comboModel({ alias: "vendor/custom" })).find(row => row.slug === "vendor/custom")!;
    expect(old).toMatchObject({ owned_by: "combo", description: generated });
    expect(old).not.toHaveProperty("opencodex_routed_origin");
    const rows = retain(old, new Map([["vendor/custom", "New"]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: "vendor/custom", description: "New", ...marker });
  });

  test("an exact combo slug and owned_by alone cannot rewrite a foreign retained row", () => {
    const foreign = { slug: "vendor/custom", owned_by: "combo", description: "Another tool's description",
      priority: 5, visibility: "list", input_modalities: ["text"] };
    expect(hasOcxComboAuthorship(foreign)).toBe(false);
    const rows = retain(foreign, new Map([["vendor/custom", "New"]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(foreign);
    expect(rows[0]).not.toHaveProperty("opencodex_routed_origin");
  });

  test("config descriptions use public aliases, exclude disabled combos, and omit empty overrides", () => {
    expect(comboCatalogDescriptions({ disabledModels: ["combo/disabled"], combos: {
      saved: { targets, description: " Canonical " },
      aliased: { targets, alias: " vendor/custom ", description: " Alias " },
      disabled: { targets, alias: "vendor/disabled", description: "Hidden" },
      empty: { targets, description: "" }, blank: { targets, description: "   " }, absent: { targets },
    } })).toEqual(new Map([["combo/saved", "Canonical"], ["vendor/custom", "Alias"]]));
  });
});

describe("described combo catalog rows (#7229)", () => {
  for (const [label, identity] of [
    ["ordinary combo", {}], ["namespaced alias", { alias: "vendor/custom" }],
    ["bare alias", { alias: "fast-coding" }],
    ["native alias", { alias: "gpt-5.6-sol", nativeAlias: true, displayName: "My Sol combo" }],
  ] as const) test(`${label} carries the override while account-native descriptions stay unchanged`, () => {
    for (const template of [null, native()]) {
      const cfg = { ...identity, description: "  Code quickly  " };
      const model = comboModel(cfg);
      expect(model.description).toBe("Code quickly");
      const rows = build(model, template);
      expect(rows.find(row => row.slug === (model.alias ?? "combo/saved"))).toMatchObject({ description: "Code quickly", ...marker });
      const account = rows.find(row => row.slug === "account/gpt-5.6-sol");
      const baseline = build(comboModel(identity), template).find(row => row.slug === "account/gpt-5.6-sol");
      expect(account).toBeDefined();
      expect(account?.description).toBe(baseline?.description);
      expect(account).not.toHaveProperty("opencodex_routed_origin");
    }
  });

  test("unset and empty descriptions produce identical bytes with the generated description and no marker", () => {
    const absent = comboModel();
    expect(absent).not.toHaveProperty("description");
    const rows = build(absent);
    expect(rows.find(row => row.slug === "combo/saved")).toMatchObject({ description: generated });
    expect(rows.find(row => row.slug === "combo/saved")).not.toHaveProperty("opencodex_routed_origin");
    expect(JSON.stringify(build(comboModel({ description: "" })))).toBe(JSON.stringify(rows));
    expect(JSON.stringify(build(comboModel({ description: "   " })))).toBe(JSON.stringify(rows));
  });

  test("derivation strips a stale template marker and ignores non-combo description overrides", () => {
    const template = { ...native(), ...marker };
    const without = deriveEntry(template, "combo/saved", generated, 5, comboModel(), new Set(["combo/saved"]));
    expect(without.description).toBe(generated);
    expect(without).not.toHaveProperty("opencodex_routed_origin");
    const provider = deriveEntry(template, "fixture/model", "Routed via opencodex → fixture (fixture).", 5,
      { ...member, description: "Must not override providers" });
    expect(provider.description).toBe("Routed via opencodex → fixture (fixture).");
    expect(provider).not.toHaveProperty("opencodex_routed_origin");
  });

  test("removing a described combo removes its row and restores a pristine foreign baseline shadow", () => {
    const rawPristine = { slug: "vendor/custom", description: "Foreign pristine description", display_name: "Foreign original",
      input_modalities: ["text"], priority: 5, visibility: "list", custom_metadata: { preserved: true } };
    const pristine = merge({ catalogModels: [rawPristine], routedEntries: [] })[0]!;
    const row = build(comboModel({ alias: "vendor/custom", description: "Combo replacement" }))
      .find(entry => entry.slug === pristine.slug)!;
    const installed = merge({ catalogModels: [pristine], baselineCatalogModels: [pristine], routedEntries: [row],
      exactComboSlugs: new Set([pristine.slug]) });
    expect(installed.find(entry => entry.slug === pristine.slug)).toMatchObject({ description: "Combo replacement", ...marker });
    const restored = merge({ catalogModels: installed, baselineCatalogModels: [pristine], routedEntries: [] });
    expect(restored.filter(entry => entry.slug === pristine.slug)).toEqual([pristine]);
    expect(restored.some(entry => entry.opencodex_routed_origin === "combo-v1")).toBe(false);
    const ordinary = build(comboModel({ description: "Remove me" })).find(entry => entry.slug === "combo/saved")!;
    expect(merge({ catalogModels: [ordinary], routedEntries: [] }).some(entry => entry.slug === "combo/saved")).toBe(false);
  });

  test("foreign arbitrary descriptions survive, and unknown marker values confer no ownership", () => {
    const foreign = { slug: "foreign/model", description: "Another tool's custom description", priority: 5, visibility: "list" };
    for (const row of [foreign, { ...foreign, opencodex_routed_origin: "combo-v2" }]) {
      expect(hasOcxRoutedAuthorship(row)).toBe(false);
      expect(hasOcxComboAuthorship(row)).toBe(false);
      expect(isOcxAuthoredRoutedEntry(row)).toBe(false);
      expect(ocxRoutedNamespaceCounts({ models: [row] }).size).toBe(0);
      const retained = merge({ catalogModels: [row], routedEntries: [] });
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject(row);
    }
    expect(catalogHasRoutedEntries({ models: [{ slug: "bare", description: "Foreign", opencodex_routed_origin: "combo-v2" }] })).toBe(false);
  });

  test("marked rows are excluded from native templates independently of owned_by or catalog kind", () => {
    const marked = { ...native(), ...marker };
    const real = { ...native(), slug: "gpt-5.5" };
    for (const find of [findNativeTemplate, findSupportedNativeTemplate]) {
      expect(find({ models: [marked] })).toBeNull();
      expect(find({ models: [marked, real] })).toBe(real);
      expect(find({ models: [{ ...marked, opencodex_routed_origin: "unknown" }] })).not.toBeNull();
    }
  });

  test("marked combo ownership counts bare and namespaced aliases under combo and protects bare-only catalogs", () => {
    const rows = ["combo/saved", "vendor/custom", "fast-coding"].map(slug => ({ slug, owned_by: "combo", description: "Custom", ...marker }));
    expect(isOcxAuthoredRoutedEntry(rows[0]!)).toBe(true);
    expect(isOcxAuthoredRoutedEntry(rows[1]!)).toBe(true);
    expect(ocxRoutedNamespaceCounts({ models: rows })).toEqual(new Map([["combo", 3]]));
    expect(catalogHasRoutedEntries({ models: [rows[2]!] })).toBe(true);
    expect(hasOcxRoutedAuthorship({ slug: "combo/legacy", description: generated })).toBe(true);
    expect(hasOcxComboAuthorship({ slug: "combo/legacy", description: generated })).toBe(true);
  });

  test("a described exact alias stays admitted through provider allowlist and pending namespace filters", () => {
    const row = build(comboModel({ alias: "vendor/custom", description: "Exact combo" })).find(entry => entry.slug === "vendor/custom")!;
    for (const pendingProviderNames of [new Set<string>(), new Set(["vendor"])]) {
      const rows = merge({ catalogModels: [], routedEntries: [row], exactComboSlugs: new Set(["vendor/custom"]),
        selectedModelsByProvider: new Map([["vendor", new Set(["vendor/other"])]]),
        gatheredProviderNames: new Set(["vendor"]), pendingProviderNames });
      expect(rows.filter(entry => entry.slug === "vendor/custom")).toEqual([row]);
    }
  });

  test("auto-review classifies a bare marked row as routed when applying and clearing root overrides", () => {
    const row = { slug: "fast-coding", description: "Custom", ...marker };
    const real = native();
    const rows: RawEntry[] = [row, real];
    expect(applyAutoReviewModelOverride(rows, "gpt-5.6-sol")).toBe("applied");
    expect(row).not.toHaveProperty("opencodex_auto_review_root");
    expect(real).toHaveProperty("opencodex_auto_review_root");
    expect(applyAutoReviewModelOverride(rows, undefined)).toBe("absent");
    expect(rows[0]?.auto_review_model_override).toBeNull();
  });

  test("native residue detection recognizes a bare marked catalog through the public classifier", () => {
    const path = join(home.codexHome, "custom-catalog.json");
    writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "custom-catalog.json"\n');
    writeFileSync(path, JSON.stringify({ models: [{ slug: "fast-coding", description: "Custom", ...marker }] }));
    expect(classifyNativeRoutedResidue()).toEqual({ kind: "residue", surface: "catalog", path });
    writeFileSync(path, JSON.stringify({ models: [{ slug: "fast-coding", description: "Foreign", opencodex_routed_origin: "unknown" }] }));
    expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
  });
});

function installCodexFixture(): string {
  const catalog = { models: [finishUpstreamNativeEntry(upstreamNativeEntry("gpt-5.6-sol")!, 9)] };
  const script = home.path("fixture-codex.js");
  writeFileSync(script, [
    'if (process.argv.includes("--version")) console.log("codex-cli 0.145.0");',
    `else process.stdout.write(${JSON.stringify(JSON.stringify(catalog))});`,
  ].join("\n"));
  const executable = home.path(process.platform === "win32" ? "fixture-codex.cmd" : "fixture-codex");
  if (process.platform === "win32") writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
    chmodSync(executable, 0o755);
  }
  process.env.CODEX_CLI_PATH = executable;
  resetCatalogRuntimeStateForTests(); resetCodexRuntimeResolveCacheForTests(); resetCodexModelEntitlementCacheForTests();
  const path = join(home.codexHome, "custom-catalog.json");
  writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "custom-catalog.json"\n');
  writeFileSync(path, JSON.stringify(catalog));
  return path;
}

function fixtureConfig(): OcxConfig {
  return {
    port: 10100, defaultProvider: "fixture", subagentModels: [], subagentModelsVersion: SUBAGENT_MODELS_VERSION,
    providers: { openai: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward" },
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false,
      models: ["model"], modelContextWindows: { model: 128_000 }, modelInputModalities: { model: ["text"] },
      modelReasoningEfforts: { model: ["high"] } } },
    combos: { saved: { targets } },
  };
}

test("real sync is byte-idempotent with a description and after clearing it matches an absent field", async () => {
  const path = installCodexFixture();
  const cfg = fixtureConfig();
  const sync = async () => {
    saveConfig(cfg);
    const result = await syncCatalogModels(cfg, { allowWhenDesiredDisabled: true });
    expect(result.refreshOutcome).toBe("committed");
    expect(result.skippedReason).toBeUndefined();
    expect(result.path).toBe(path);
    return readFileSync(path, "utf8");
  };
  const absent = await sync();
  expect(await sync()).toBe(absent);
  cfg.combos!.saved!.description = "A custom catalog description";
  const described = await sync();
  expect(JSON.parse(described).models.find((row: RawEntry) => row.slug === "combo/saved"))
    .toMatchObject({ description: "A custom catalog description", ...marker });
  expect(await sync()).toBe(described);
  cfg.combos!.saved!.description = "";
  const cleared = await sync();
  expect(cleared).toBe(absent);
  expect(JSON.parse(cleared).models.find((row: RawEntry) => row.slug === "combo/saved"))
    .not.toHaveProperty("opencodex_routed_origin");
  expect(await sync()).toBe(cleared);
}, 30_000);

test("real sync reprojects current config descriptions onto a native alias retained while its provider is disabled", async () => {
  const path = installCodexFixture();
  const cfg = fixtureConfig();
  cfg.combos!.saved = { targets, alias: "gpt-5.6-sol", nativeAlias: true,
    displayName: "Retained Sol combo", description: "Old" };
  const sync = async () => {
    saveConfig(cfg);
    const result = await syncCatalogModels(cfg, { allowWhenDesiredDisabled: true });
    expect(result.refreshOutcome).toBe("committed");
    expect(result.path).toBe(path);
    return (JSON.parse(readFileSync(path, "utf8")).models as RawEntry[])
      .find(row => row.slug === "gpt-5.6-sol");
  };
  expect(await sync()).toMatchObject({ description: "Old", ...marker });
  cfg.providers.fixture!.disabled = true;
  cfg.combos!.saved!.description = "New";
  expect(comboCatalogDescriptions(cfg)).toEqual(new Map([["gpt-5.6-sol", "New"]]));
  expect(await sync()).toMatchObject({ description: "New", ...marker });
  delete cfg.combos!.saved!.description;
  expect(comboCatalogDescriptions(cfg).size).toBe(0);
  const cleared = await sync();
  expect(cleared).toMatchObject({ description: generated });
  expect(cleared).not.toHaveProperty("opencodex_routed_origin");
}, 30_000);
