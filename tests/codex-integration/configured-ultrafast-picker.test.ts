import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxProviderConfig } from "../../src/types";
import { captureFastPolicyAuthority, fastPolicyForModel } from "../../src/providers/service-tier";
import { decideTier } from "../../src/providers/fastwire";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";
import { configuredUltraFastSlugs, retainedFlexPolicyBySlug } from "../../src/codex/catalog/configured-tiers";
import { buildCatalogEntriesFromObservedState, mergeCatalogEntriesFromObservedState, type ObservedCatalogMergeInput } from "../../src/codex/catalog/build-entries";
import type { CatalogModel, RawEntry } from "../../src/codex/catalog/parsing";
import { repoRoot } from "../helpers/repo-root";

const slug = "gateway/task-model";
/** An operator explicitly declares the supported tier on an otherwise unknown gateway. */
function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses", baseUrl: "https://provider.invalid/v1", liveModels: false,
    models: ["task-model"], modelSupportsServiceTier: { "task-model": true },
    fastWire: { kind: "service-tier", canonicalToWire: { priority: "priority", ultrafast: "ultrafast" }, foreignCallerTiers: "verbatim" },
    ...overrides,
  };
}

/** Exercise the production config projection instead of trusting a catalog's capability hints. */
function hinted(config = provider(), model: CatalogModel = { provider: "gateway", id: "task-model" }): CatalogModel {
  return applyProviderConfigHints("gateway", config, model);
}

/** Build ordinary routed rows through the same observed-state builder used by both writers. */
function build(models: CatalogModel[] = [hinted()]): RawEntry[] {
  return buildCatalogEntriesFromObservedState({
    template: null, gptSlugs: [], goModels: models, wsEnabled: false,
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
    accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
  });
}

/** Merge detached observations with explicit captured declarations and the operator opt-in. */
function merge(old: RawEntry[] = [], extra: Partial<ObservedCatalogMergeInput> = {}): RawEntry[] {
  return mergeCatalogEntriesFromObservedState({
    catalogModels: old, routedEntries: build(), baselineCatalogModels: [], baseline: new Map(), featured: [],
    wsEnabled: false, template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(["gateway"]), degradedProviderNames: new Set(),
    legacyCustomModelSlugs: new Set(), multiAgentMode: "default", multiAgentV2Enabled: false,
    exactComboSlugs: new Set(), hasPhysicalComboProvider: false, includeNativeOpenAi: false,
    accountBoundEntries: [], ultraFastTier: true, configuredUltraFastSlugs: configuredUltraFastSlugs([hinted()]),
    policy: { nativeBackfillSlugs: [], unsupportedNativeEntries: "drop", warningPolicy: "suppress" },
    ...extra,
  });
}

describe("configured Ultra Fast in the native Codex speed picker", () => {
  test("an explicit eligible mapping publishes a choice without changing the default", () => {
    const row = merge()[0]!;
    expect(row.service_tiers.map((tier: { id: string }) => tier.id)).toEqual(["priority", "ultrafast"]);
    expect(row.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    expect(row.default_service_tier).toBeNull();
    expect(row.service_tier).toBeUndefined();
    expect(merge([], { ultraFastTier: false })[0]!.service_tiers).toEqual(row.service_tiers);
    expect(decideTier(fastPolicyForModel(provider(), "task-model", "gateway"), undefined, "ultrafast"))
      .toEqual({ kind: "set", value: "ultrafast" });
  });

  test.each([
    ["ordinary Fast", { fastWire: undefined }],
    ["unclassified gateway", { modelSupportsServiceTier: {} }],
    ["provider opt-out", { supportsServiceTier: false }],
    ["model opt-out", { supportsServiceTier: true, modelSupportsServiceTier: { "task-model": false } }],
    ["wire disabled", { fastWire: null }],
    ["incompatible adapter", { adapter: "anthropic" }],
    ["different wire", { fastWire: { kind: "model-variant", canonicalToWire: { ultrafast: "ultrafast" }, foreignCallerTiers: "drop" } }],
    ["priority is not Ultra Fast", { fastWire: { kind: "service-tier", canonicalToWire: { ultrafast: "priority" }, foreignCallerTiers: "verbatim" } }],
  ] as [string, Partial<OcxProviderConfig>][])("%s cannot manufacture Ultra Fast", (_name, override) => {
    const model = hinted(provider(override), { provider: "gateway", id: "task-model", supportsUltraFastTier: true });
    expect(model.supportsUltraFastTier).toBe(false);
    expect(configuredUltraFastSlugs([model]).size).toBe(0);
    expect(merge([], { routedEntries: build([model]), configuredUltraFastSlugs: configuredUltraFastSlugs([model]) })[0]!
      .additional_speed_tiers ?? []).not.toContain("ultrafast");
  });

  test("a similarly named model and combo aliases do not inherit the declaration", () => {
    const model = hinted();
    expect(hinted(provider(), { provider: "gateway", id: "gpt-6-astra" }).supportsUltraFastTier).toBe(false);
    expect(configuredUltraFastSlugs([{ ...model, provider: "combo", nativeAlias: true, alias: "gpt-6-astra" }]).size).toBe(0);
    expect(configuredUltraFastSlugs([model, { ...model, supportsUltraFastTier: false }]).size).toBe(0);
    expect([...configuredUltraFastSlugs([{ ...model, alias: "gateway/friendly" }])]).toEqual(["gateway/friendly"]);
  });

  test("frozen gathering uses the captured wire authority", () => {
    const original = provider();
    const captured = Object.freeze(original);
    captureFastPolicyAuthority("gateway", captured, false);
    delete original.fastWire!.canonicalToWire.ultrafast;
    expect(hinted(captured).supportsUltraFastTier).toBe(true);
    expect(hinted(provider({ fastWire: original.fastWire })).supportsUltraFastTier).toBe(false);
  });

  test("repeated sync is stable and withdrawing configuration defeats operator retention", () => {
    const first = merge();
    const before = structuredClone(first);
    expect(merge(first)).toEqual(first);
    const removed = merge(first, { configuredUltraFastSlugs: new Set() })[0]!;
    expect(removed.additional_speed_tiers).toEqual(["fast"]);
    expect(removed.opencodex_managed_ultrafast).toBeUndefined();
    expect(first).toEqual(before);
    const degraded = merge(first, { routedEntries: [], configuredUltraFastSlugs: new Set(), degradedProviderNames: new Set(["gateway"]) })[0]!;
    expect(degraded.additional_speed_tiers ?? []).not.toContain("ultrafast");
  });

  test("a hand-supplied tier still follows its existing separate opt-in", () => {
    const operator = [{ slug, service_tiers: [{ id: "ultrafast", name: "My tier" }], additional_speed_tiers: ["ultrafast"] }];
    const retained = merge(operator, { configuredUltraFastSlugs: new Set() })[0]!;
    expect(retained.service_tiers.at(-1).name).toBe("My tier");
    expect(merge(operator, { configuredUltraFastSlugs: new Set(), ultraFastTier: false })[0]!.additional_speed_tiers).toEqual(["fast"]);
    // Current configuration takes precedence, but never imports the old expensive default.
    expect(merge([{ ...operator[0], default_service_tier: "ultrafast" }])[0]!.default_service_tier).toBeNull();
  });

  test("degraded retained rows drop revoked Flex but preserve authorized Flex", () => {
    const stored = merge();
    const flex = { id: "flex", name: "Flex" };
    stored[0]!.service_tiers.push(flex);
    stored[0]!.additional_speed_tiers.push("flex");
    const configured = provider({
      fastWire: { kind: "service-tier", canonicalToWire: { priority: "priority", flex: "flex" }, foreignCallerTiers: "verbatim" },
    });
    const run = (active: typeof configured) => merge(stored, {
      routedEntries: [], degradedProviderNames: new Set(["gateway"]),
      configuredUltraFastSlugs: new Set(),
      retainedFlexPolicyBySlug: retainedFlexPolicyBySlug({ gateway: active }, stored, []),
    })[0]!;
    expect(run(configured).additional_speed_tiers).toContain("flex");
    const revoked = run(provider());
    expect(revoked.service_tiers.map((tier: { id: string }) => tier.id)).not.toContain("flex");
    expect(revoked.additional_speed_tiers).not.toContain("flex");
    expect(run(provider({ modelSupportsServiceTier: { "task-model": false } })).additional_speed_tiers)
      .not.toContain("flex");
    expect(stored[0]!.additional_speed_tiers).toContain("flex");
  });

  test("retained Flex policy excludes physical combo providers and combo aliases without discovery", () => {
    const flexProvider = provider({
      fastWire: { kind: "service-tier", canonicalToWire: { priority: "priority", flex: "flex" }, foreignCallerTiers: "verbatim" },
    });
    const check = (providers: Record<string, OcxProviderConfig>, rowSlug: string) =>
      retainedFlexPolicyBySlug(providers, [{ slug: rowSlug }], []).get(rowSlug);

    expect(check({ combo: flexProvider }, "combo/task-model")).toBe(false);
    expect(check({ combo: { ...flexProvider, alias: "bundle" } }, "bundle/task-model")).toBe(false);
    expect(check({ gateway: { ...flexProvider, alias: "combo" } }, "combo/task-model")).toBe(false);
    expect(check({ gateway: flexProvider }, "gateway/task-model")).toBe(true);
  });

  test("degraded retained encoded slugs resolve adapter-only native IDs before Flex policy", () => {
    const rowSlug = "gateway/a-b";
    const base = provider({
      models: [],
      supportsServiceTier: true,
      modelSupportsServiceTier: {},
      modelAdapters: { "a/b": "openai-chat" },
      fastWire: {
        kind: "service-tier", canonicalToWire: { priority: "priority", flex: "flex" },
        foreignCallerTiers: "verbatim",
      },
    });
    const retainedPolicy = (config: OcxProviderConfig) =>
      retainedFlexPolicyBySlug({ gateway: config }, [{ slug: rowSlug }], []).get(rowSlug);

    // Without decoding, a-b incorrectly inherits the provider's Responses adapter
    // and permits Flex, although the native a/b Chat route cannot forward that tier.
    expect(fastPolicyForModel(base, "a-b", "gateway").forwardCallerTier).toBe(true);
    expect(fastPolicyForModel(base, "a/b", "gateway").forwardCallerTier).toBe(false);
    expect(retainedPolicy(base)).toBe(false);
    // A verified Chat service-tier opt-in makes that exact native route eligible.
    expect(retainedPolicy({ ...base, chatServiceTier: true })).toBe(true);
  });

  test("selection and disabled-model policy still remove the entire row", () => {
    expect(merge([], { disabledModels: new Set([slug]) })).toEqual([]);
    expect(merge([], { selectedModelsByProvider: new Map([["gateway", new Set<string>()]]) })).toEqual([]);
  });
});

for (const writer of ["retained-sync", "convergence"] as const) {
  test(writer + " updates both app catalog and cache across declaration changes", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-configured-ultrafast-"));
    const codexHome = join(root, "codex");
    const ocxHome = join(root, "ocx");
    mkdirSync(codexHome); mkdirSync(ocxHome);
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
      port: 10100, defaultProvider: "gateway", ultraFastTier: true,
      providers: { openai: {
        adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", liveModels: false,
      }, gateway: provider({ modelSupportsServiceTier: { "task-model": true, "custom-task": true } }) },
      customModels: [{ id: "custom-task", provider: "gateway", modelId: "custom-task" }],
    }));
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [
      { slug: "gpt-5.5", visibility: "list", base_instructions: "You are Codex." },
    ] }));
    const script = `
      const { readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const { saveConfig } = require("./src/config");
      const config = JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME, "config.json"), "utf8"));
      const { syncCatalogModels, invalidateCodexModelsCache } = require("./src/codex/catalog");
      const { captureCatalogAdmissionSnapshot } = require("./src/codex/catalog-admission");
      const { gatherCodexCatalogCandidate, commitCodexCatalogCandidate } = require("./src/codex/convergence");
      const passes = [];
      for (const enabled of [false, true, true, false]) {
        const mapping = config.providers.gateway.fastWire.canonicalToWire;
        if (enabled) mapping.ultrafast = "ultrafast"; else delete mapping.ultrafast;
        saveConfig(config);
        if (${writer === "retained-sync"}) {
          const result = await syncCatalogModels(config, { allowWhenDesiredDisabled: true });
          if (result.refreshOutcome !== "committed") throw new Error(JSON.stringify(result));
          invalidateCodexModelsCache({ allowWhenDesiredDisabled: true });
        } else {
          const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config));
          if (gathered.kind !== "candidate") throw new Error(JSON.stringify(gathered));
          const result = await commitCodexCatalogCandidate(gathered.candidate, 1000);
          if (result.kind !== "committed") throw new Error(JSON.stringify(result));
        }
        passes.push(["opencodex-catalog.json", "models_cache.json"].map(file =>
          JSON.parse(readFileSync(join(process.env.CODEX_HOME, file), "utf8")).models
            .filter(row => row.slug.startsWith("gateway/"))));
      }
      console.log("PICKER_RESULT=" + JSON.stringify(passes));
    `;
    try {
      const result = spawnSync(process.execPath, ["--eval", script], {
        cwd: repoRoot(), env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
        encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
      });
      expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
      const passes = JSON.parse(result.stdout.split("\n").find(line => line.startsWith("PICKER_RESULT="))!.slice("PICKER_RESULT=".length)) as RawEntry[][][];
      for (const [index, pass] of passes.entries()) for (const rows of pass) {
        expect(rows.map(row => row.slug).sort()).toEqual(["gateway/custom-task", slug]);
        for (const row of rows) {
          expect(row.additional_speed_tiers).toEqual(index === 1 || index === 2 ? ["fast", "ultrafast"] : ["fast"]);
          expect(row.default_service_tier).toBeNull();
          expect(row.service_tiers.map((tier: { id: string }) => tier.id)).toEqual(index === 1 || index === 2 ? ["priority", "ultrafast"] : ["priority"]);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);
}
