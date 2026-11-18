import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureCatalogAdmissionSnapshot } from "../../src/codex/catalog-admission";
import { commitCodexCatalogCandidate, gatherCodexCatalogCandidate } from "../../src/codex/convergence";
import { resetCatalogRuntimeStateForTests, syncCatalogModels } from "../../src/codex/catalog";
import {
  buildCatalogEntriesFromObservedState,
  mergeCatalogEntriesFromObservedState,
} from "../../src/codex/catalog/build-entries";
import { upstreamNativeEntry } from "../../src/codex/catalog/metadata";
import type { CatalogModel, RawCatalog, RawEntry } from "../../src/codex/catalog/parsing";
import type { RoutedCatalogDefaults } from "../../src/config/schema/routed-catalog-defaults";
import { saveConfig } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { buildCodexModelList } from "../../src/server/codex-model-list";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";

// #6872: operator defaults for routed catalog rows sit above the inherited native template and
// below concrete provider/model declarations; provider verbosity limits always win.
const FIELDS = [
  ["includeSkillsUsageInstructions", "include_skills_usage_instructions"],
  ["includeAppsUsageInstructions", "include_apps_usage_instructions"],
  ["includePluginUsageInstructions", "include_plugin_usage_instructions"],
] as const;
const ROW_KEYS = [...FIELDS.map(([, row]) => row), "default_verbosity"];

const permissiveTemplate = (): RawEntry => ({
  slug: "gpt-5.5", display_name: "GPT-5.5", priority: 1, visibility: "list",
  base_instructions: "Fixture native instructions",
  include_skills_usage_instructions: true, include_apps_usage_instructions: true,
  include_plugin_usage_instructions: true, support_verbosity: true, default_verbosity: "medium",
});
const restrictiveTemplate = (): RawEntry => ({
  ...permissiveTemplate(),
  include_skills_usage_instructions: false, include_apps_usage_instructions: false,
  include_plugin_usage_instructions: false, support_verbosity: false,
});

const build = (
  template: RawEntry | null,
  goModels: CatalogModel[],
  routedCatalogDefaults?: RoutedCatalogDefaults,
  extra: { gptSlugs?: string[]; accountSelectors?: string[] } = {},
) => buildCatalogEntriesFromObservedState({
  template: template ? structuredClone(template) : null,
  gptSlugs: extra.gptSlugs ?? [], goModels, wsEnabled: false,
  multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
  accountSelectors: extra.accountSelectors ?? [], suppressedBareNativeSlugs: new Set(),
  disabledNativeAccountSlugs: new Set(), routedCatalogDefaults,
});
const row = (rows: RawEntry[], slug: string) => {
  const found = rows.find(entry => entry.slug === slug);
  expect(found, slug).toBeDefined();
  return found!;
};
const withoutDefaultedKeys = (entry: RawEntry) => Object.fromEntries(
  Object.entries(entry).filter(([key]) => !ROW_KEYS.includes(key)),
);
const plain: CatalogModel = { provider: "gateway", id: "task-model" };
const ALL_TRUE: RoutedCatalogDefaults = {
  includeSkillsUsageInstructions: true, includeAppsUsageInstructions: true,
  includePluginUsageInstructions: true, defaultVerbosity: "high",
};

describe("routed row derivation with routedCatalogDefaults", () => {
  test("an absent or empty block derives today's rows on both writer paths", () => {
    for (const template of [permissiveTemplate(), null]) {
      const baseline = build(template, [plain]);
      expect(build(template, [plain], {})).toEqual(baseline);
    }
    // Unset keeps the template's own values instead of a synthesized default.
    const inherited = row(build(permissiveTemplate(), [plain]), "gateway/task-model");
    expect(inherited.include_skills_usage_instructions).toBe(true);
    expect(inherited.default_verbosity).toBe("medium");
  });

  test("each explicit false overrides an inherited true and leaves the other fields alone", () => {
    const baseline = row(build(permissiveTemplate(), [plain]), "gateway/task-model");
    for (const [config, serialized] of FIELDS) {
      const derived = row(build(permissiveTemplate(), [plain], { [config]: false }), "gateway/task-model");
      expect(derived[serialized], config).toBe(false);
      for (const [, other] of FIELDS) if (other !== serialized) expect(derived[other], other).toEqual(baseline[other]);
    }
  });

  test("each explicit true overrides an inherited false, with and without a native template", () => {
    for (const template of [restrictiveTemplate(), null]) {
      for (const [config, serialized] of FIELDS) {
        const derived = row(build(template, [plain], { [config]: true }), "gateway/task-model");
        expect(derived[serialized], `${config} template=${template !== null}`).toBe(true);
      }
      const all = row(build(template, [plain], ALL_TRUE), "gateway/task-model");
      for (const [, serialized] of FIELDS) expect(all[serialized]).toBe(true);
      // Verbosity support is never an operator default: a restrictive template keeps it off.
      expect(all.support_verbosity).toBe(template === null);
      expect(all.default_verbosity).toBe(template === null ? "high" : undefined);
    }
  });

  test("defaultVerbosity sets the advertised default only while verbosity is supported", () => {
    for (const template of [permissiveTemplate(), null]) {
      for (const level of ["low", "medium", "high"] as const) {
        const derived = row(build(template, [plain], { defaultVerbosity: level }), "gateway/task-model");
        expect(derived.support_verbosity).toBe(true);
        expect(derived.default_verbosity).toBe(level);
      }
    }
  });

  test("a default on a model without verbosity support advertises nothing", () => {
    for (const level of ["low", "medium", "high"] as const) {
      const derived = row(build(restrictiveTemplate(), [plain], { defaultVerbosity: level }), "gateway/task-model");
      expect(derived.support_verbosity).toBe(false);
      expect(derived.default_verbosity).toBeUndefined();
      expect(Object.hasOwn(derived, "default_verbosity")).toBe(false);
    }
    expect(row(build(restrictiveTemplate(), [plain], { defaultVerbosity: "high" }), "gateway/task-model"))
      .toEqual(row(build(restrictiveTemplate(), [plain]), "gateway/task-model"));
  });

  test("a provider that declares verbosity unsupported always wins", () => {
    const unsupported: CatalogModel = { ...plain, supportsVerbosity: false };
    for (const template of [permissiveTemplate(), null]) {
      const derived = row(build(template, [unsupported], ALL_TRUE), "gateway/task-model");
      expect(derived.support_verbosity).toBe(false);
      expect(derived.default_verbosity).toBeUndefined();
      expect(derived.include_skills_usage_instructions).toBe(true);
    }
  });

  test("a provider that declares verbosity support receives the default level", () => {
    const supported: CatalogModel = { ...plain, supportsVerbosity: true };
    const derived = row(build(restrictiveTemplate(), [supported], { defaultVerbosity: "medium" }), "gateway/task-model");
    expect(derived.support_verbosity).toBe(true);
    expect(derived.default_verbosity).toBe("medium");
  });

  test("defaults change only the allowlisted fields of a routed row", () => {
    for (const template of [permissiveTemplate(), restrictiveTemplate(), null]) {
      for (const model of [plain, { ...plain, codexToolMode: "shell" as const }, { provider: "cursor", id: "composer" }]) {
        const slug = `${model.provider}/${model.id}`;
        const baseline = row(build(template, [model]), slug);
        const derived = row(build(template, [model], ALL_TRUE), slug);
        expect(withoutDefaultedKeys(derived)).toEqual(withoutDefaultedKeys(baseline));
      }
    }
  });

  test("native, account-bound and Codex-forward native-capability rows are untouched", () => {
    const template = upstreamNativeEntry("gpt-5.6-sol");
    expect(template).not.toBeNull();
    const forward: CatalogModel = { provider: "openai", id: "gpt-5.6-sol", codexForwardNativeCapabilityAlias: true };
    const extra = { gptSlugs: ["gpt-5.6-sol"], accountSelectors: ["work"] };
    const baseline = build(template, [forward], undefined, extra);
    const derived = build(template, [forward], ALL_TRUE, extra);
    for (const slug of ["gpt-5.6-sol", "work/gpt-5.6-sol", "openai/gpt-5.6-sol"]) {
      expect(row(derived, slug), slug).toEqual(row(baseline, slug));
    }
  });

  test("regeneration is idempotent and clearing the block restores the original rows", () => {
    const baseline = build(permissiveTemplate(), [plain]);
    const first = build(permissiveTemplate(), [plain], { includeAppsUsageInstructions: false, defaultVerbosity: "high" });
    const second = build(permissiveTemplate(), [plain], { includeAppsUsageInstructions: false, defaultVerbosity: "high" });
    expect(second).toEqual(first);
    expect(first).not.toEqual(baseline);
    expect(build(permissiveTemplate(), [plain])).toEqual(baseline);
  });

  test("a row retained during a provider outage keeps its last derivation until regenerated", () => {
    const retained = { ...row(build(permissiveTemplate(), [plain]), "gateway/task-model") };
    const merged = mergeCatalogEntriesFromObservedState({
      catalogModels: [retained], routedEntries: [], baselineCatalogModels: [], baseline: new Map(), featured: [],
      wsEnabled: false, template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
      gatheredProviderNames: new Set(["gateway"]), degradedProviderNames: new Set(["gateway"]),
      legacyCustomModelSlugs: new Set(), multiAgentMode: "default", multiAgentV2Enabled: false,
      exactComboSlugs: new Set(), hasPhysicalComboProvider: false, includeNativeOpenAi: false,
      accountBoundEntries: [], ultraFastTier: false,
      policy: { nativeBackfillSlugs: [], unsupportedNativeEntries: "drop", warningPolicy: "suppress" },
    });
    const kept = row(merged, "gateway/task-model");
    for (const key of ROW_KEYS) expect(kept[key], key).toEqual(retained[key]);
  });
});

describe("routedCatalogDefaults through the catalog writers", () => {
  let home: TempHome;
  let path: string;
  const native = (): RawEntry => ({ ...permissiveTemplate(), include_apps_usage_instructions: false });
  const source = () => JSON.stringify({ models: [native()] });
  const config = (routedCatalogDefaults?: RoutedCatalogDefaults): OcxConfig => ({
    port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", subagentModels: [],
    catalogAutoRefresh: { enabled: false },
    ...(routedCatalogDefaults === undefined ? {} : { routedCatalogDefaults }),
    providers: {
      openai: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward", models: ["gpt-5.5"] },
      fixture: { adapter: "openai-responses", baseUrl: "https://routed-defaults.invalid/v1", liveModels: false, models: ["model"] },
      limited: {
        adapter: "openai-responses", baseUrl: "https://routed-defaults-limited.invalid/v1",
        liveModels: false, models: ["model"], supportsVerbosity: false,
      },
    },
  });
  const read = (): RawCatalog => JSON.parse(readFileSync(path, "utf8"));
  const rowOf = (catalog: RawCatalog, slug: string) => row(catalog.models ?? [], slug);
  const liveList = (next: OcxConfig): RawCatalog => buildCodexModelList({
    config: next, nativeSlugs: ["gpt-5.5"], availableAccountNativeSlugs: [], accountNativeSlugs: [],
    accountNativeSlugsBySelector: new Map(),
    goOrdered: [{ provider: "fixture", id: "model" }, { provider: "limited", id: "model", supportsVerbosity: false }],
    exactComboSlugs: new Set(), accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledModels: new Set(),
  });
  const converge = async (next: OcxConfig) => {
    saveConfig(next);
    const result = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(next));
    if (result.kind !== "candidate") throw new Error(JSON.stringify(result));
    const committed = await commitCodexCatalogCandidate(result.candidate, 1_000);
    expect(committed.kind).toBe("committed");
    return read();
  };
  const sync = async (next: OcxConfig) => {
    saveConfig(next);
    const outcome = await syncCatalogModels(next, { allowWhenDesiredDisabled: true });
    expect(outcome.refreshOutcome).toBe("committed");
    return { catalog: read(), written: outcome.catalogWritten };
  };
  const DEFAULTS: RoutedCatalogDefaults = { includeAppsUsageInstructions: true, includeSkillsUsageInstructions: false, defaultVerbosity: "high" };

  beforeEach(() => {
    home = createTempHome("ocx-routed-defaults-");
    mkdirSync(home.codexHome);
    path = join(home.codexHome, "fixture-catalog.json");
    writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "fixture-catalog.json"\n', "utf8");
    writeFileSync(path, source(), "utf8");
    resetCatalogRuntimeStateForTests();
  });
  afterEach(async () => {
    resetCatalogRuntimeStateForTests();
    await removeTreeAfterBackgroundWork(home.root);
    home.remove();
  });

  const expectApplied = (catalog: RawCatalog) => {
    const routed = rowOf(catalog, "fixture/model");
    expect(routed.include_apps_usage_instructions).toBe(true);
    expect(routed.include_skills_usage_instructions).toBe(false);
    expect(routed.include_plugin_usage_instructions).toBe(true);
    expect(routed.default_verbosity).toBe("high");
    const limited = rowOf(catalog, "limited/model");
    expect(limited.support_verbosity).toBe(false);
    expect(limited.default_verbosity).toBeUndefined();
  };

  test("convergence applies the defaults, repeats byte-identically and clearing restores the rows", async () => {
    const before = await converge(config());
    const nativeBefore = rowOf(before, "gpt-5.5");
    expect(rowOf(before, "fixture/model").include_apps_usage_instructions).toBe(false);
    const applied = await converge(config(DEFAULTS));
    expectApplied(applied);
    expect(rowOf(applied, "gpt-5.5")).toEqual(nativeBefore);
    const bytes = readFileSync(path, "utf8");
    await converge(config(DEFAULTS));
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const cleared = await converge(config());
    expect(rowOf(cleared, "fixture/model")).toEqual(rowOf(before, "fixture/model"));
    expect(rowOf(cleared, "limited/model")).toEqual(rowOf(before, "limited/model"));
  });

  test("retained sync and the live model list apply the same defaults", async () => {
    const before = (await sync(config())).catalog;
    const first = await sync(config(DEFAULTS));
    expectApplied(first.catalog);
    expect(rowOf(first.catalog, "gpt-5.5")).toEqual(rowOf(before, "gpt-5.5"));
    expectApplied(liveList(config(DEFAULTS)));
    const second = await sync(config(DEFAULTS));
    expect(second.written).toBe(false);
    const cleared = (await sync(config())).catalog;
    expect(rowOf(cleared, "fixture/model")).toEqual(rowOf(before, "fixture/model"));
    expect(rowOf(liveList(config()), "fixture/model").include_apps_usage_instructions).toBe(false);
  });
});
