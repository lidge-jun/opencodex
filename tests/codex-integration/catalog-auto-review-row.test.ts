import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyFullModelPickerOrder, buildCatalogEntriesFromObservedState,
  CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, mergeCatalogEntriesFromObservedState,
  mergeCatalogModelsWithNativeRecovery, type ObservedCatalogMergeInput, type ObservedCatalogEntryBuildInput,
} from "../../src/codex/catalog/build-entries";
import { applyAutoReviewModelOverride, applyConfiguredAutoReviewModelOverride } from "../../src/codex/catalog/auto-review";
import { clampCatalogModelsToObservedCodexSupport } from "../../src/codex/catalog/effort";
import { filterSupportedNativeSlugs, type RawEntry } from "../../src/codex/catalog/parsing";
import { desktopVisibleNativeSlugs, upstreamNativeEntry, visibleNativeSlugs } from "../../src/codex/catalog/metadata";
import { NATIVE_RESERVE_MODEL, SUPPORTED_NATIVE_OPENAI_SLUGS } from "../../src/codex/catalog/native-models";
import { effectiveSubagentRoster, SPAWN_PRIORITY_FIELD } from "../../src/codex/catalog/subagent-roster";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../../src/codex/catalog/account-models";
import { RESERVE_METADATA_SOURCE_FIELD } from "../../src/codex/catalog/reserve";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "../../src/codex/catalog/kinds";
import snapshot from "../../src/codex/data/upstream-models.json";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { CODEX_INTERNAL_OPENAI_MODELS } from "../../src/codex/control-plane-models";
import { NoEnabledOpenAiProviderError, routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";

const reviewer = "codex-auto-review";
const upstream = snapshot.models.find(row => row.slug === reviewer)!;
const nativeConfig: OcxConfig = {
  port: 10100, defaultProvider: "openai",
  providers: { openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", liveModels: false } },
};
const otherConfig: OcxConfig = {
  port: 10100, defaultProvider: "other",
  providers: { other: { adapter: "openai-chat", baseUrl: "https://provider.invalid/v1", models: ["task"], liveModels: false } },
};
function merge(catalogModels: RawEntry[] = [], includeNativeOpenAi = true, extra: Partial<ObservedCatalogMergeInput> = {}): RawEntry[] {
  return mergeCatalogEntriesFromObservedState({
    catalogModels, baselineCatalogModels: [], routedEntries: [], baseline: new Map(),
    featured: [reviewer], modelPickerOrder: [reviewer, "gpt-5.5"], wsEnabled: false,
    template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(), degradedProviderNames: new Set(), legacyCustomModelSlugs: new Set(),
    multiAgentMode: "v2", multiAgentV2Enabled: true, exactComboSlugs: new Set(),
    hasPhysicalComboProvider: false, includeNativeOpenAi, accountBoundEntries: [],
    policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" }, ...extra,
  });
}
function build(extra: Partial<ObservedCatalogEntryBuildInput> = {}): RawEntry[] {
  return buildCatalogEntriesFromObservedState({
    template: null, gptSlugs: ["gpt-5.5"], goModels: [], wsEnabled: false,
    multiAgentMode: "v2", multiAgentV2Enabled: true, exactComboSlugs: new Set(),
    accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
    ...extra,
  });
}
const reserve: RawEntry = {
  slug: `personal/${NATIVE_RESERVE_MODEL}`, visibility: "list",
  opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
  [RESERVE_METADATA_SOURCE_FIELD]: NATIVE_RESERVE_MODEL,
  supported_reasoning_levels: [{ effort: "xhigh", description: "Only xhigh" }],
  default_reasoning_level: "xhigh",
};

test.each(["v1", "v2"] as const)("reviewer receives explicit %s mode in build and merge", mode => {
  expect(reviewRow(build({ multiAgentMode: mode })).multi_agent_version).toBe(mode);
  expect(reviewRow(merge([], true, { multiAgentMode: mode })).multi_agent_version).toBe(mode);
});

test("reviewer follows the native v1 exception to explicit v2 mode", () => {
  expect(reviewRow(build({ keepNativeChatGptOnV1: true })).multi_agent_version).toBe("v1");
  expect(reviewRow(merge([], true, { keepNativeChatGptOnV1: true })).multi_agent_version).toBe("v1");
});

test("Reserve-only or native-less final catalogs omit persisted reviewers in both writers", () => {
  for (const gptSlugs of [[], [NATIVE_RESERVE_MODEL], [reviewer], ["gpt-5.5"]]) {
    const rows = build({ gptSlugs, suppressedBareNativeSlugs: new Set(["gpt-5.5"]) });
    expect(rows.some(row => row.slug === reviewer)).toBe(false);
  }
  for (const catalogModels of [[], [{ slug: NATIVE_RESERVE_MODEL }], [{ slug: "user-native" }],
    [{ slug: "gpt-5.5", opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND }]]) {
    const rows = merge([...catalogModels, structuredClone(upstream)], true, {
      accountBoundEntries: [reserve],
      policy: { nativeBackfillSlugs: [], unsupportedNativeEntries: "drop", warningPolicy: "suppress" },
    });
    expect(rows.some(row => row.slug === reviewer)).toBe(false);
  }
});

test("hidden ordinary bare native rows qualify while account-only rows do not", () => {
  const policy = { nativeBackfillSlugs: [], unsupportedNativeEntries: "drop" as const, warningPolicy: "suppress" as const };
  const rows = merge([{ slug: "gpt-5.5", visibility: "hide" }], true, { disabledModels: new Set(["gpt-5.5"]), policy });
  expect(reviewRow(rows).visibility).toBe("hide");
  const accountOnly = merge([], true, { policy, accountBoundEntries: [{ slug: "personal/gpt-5.5", visibility: "list" }] });
  expect(accountOnly.some(row => row.slug === reviewer)).toBe(false);
});

test("final effort clamp removes an orphan reviewer when its only native-looking row is Reserve", () => {
  const rows = [{ slug: "external/model", visibility: "list" }, structuredClone(reserve), structuredClone(upstream)];
  const diagnostic = clampCatalogModelsToObservedCodexSupport(rows, new Set(["medium"]));
  expect(rows.map(row => row.slug)).toEqual(["external/model"]);
  expect(diagnostic.affectedModels).toContain(reserve.slug);
});

function reviewRow(rows: RawEntry[]): RawEntry {
  const matches = rows.filter(row => row.slug === reviewer);
  expect(matches).toHaveLength(1);
  expect(matches[0]!.visibility).toBe("hide");
  return matches[0]!;
}

test("build backfills the hidden reviewer with its exact upstream ladder and no picker/spawn rank", () => {
  const rows = buildCatalogEntriesFromObservedState({
    template: null, gptSlugs: ["gpt-5.5", reviewer], goModels: [], featured: [reviewer],
    wsEnabled: false, multiAgentMode: "v2", multiAgentV2Enabled: true,
    exactComboSlugs: new Set(), accountSelectors: ["account"],
    suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
  });
  const row = reviewRow(rows);
  expect(row.supported_reasoning_levels).toEqual(upstream.supported_reasoning_levels);
  expect(row.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({ effort: "low" })]));
  expect(row.default_reasoning_level).toBe(upstream.default_reasoning_level);
  expect(row.multi_agent_version).toBe("v2");
  expect(row.priority).toBe(upstream.priority);
  expect(rows.some(entry => entry.slug === `account/${reviewer}`)).toBe(false);
  applyFullModelPickerOrder(rows, [reviewer, "gpt-5.5"]);
  expect(row.priority).toBe(upstream.priority);
  expect(row[SPAWN_PRIORITY_FIELD]).toBeUndefined();
});

test("routed-only build and merge do not add or retain the native reviewer", () => {
  expect(merge([{ ...structuredClone(upstream), visibility: "list" }], false).some(row => row.slug === reviewer)).toBe(false);
  const rows = buildCatalogEntriesFromObservedState({
    template: null, gptSlugs: [], goModels: [], wsEnabled: false,
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
    accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
  });
  expect(rows.some(row => row.slug === reviewer)).toBe(false);
});

test("merge backfills a single hidden reviewer outside native replacement authority", () => {
  const row = reviewRow(merge());
  expect(row.supported_reasoning_levels).toEqual(upstream.supported_reasoning_levels);
  expect(row.supported_in_api).toBe(true);
  expect(row.priority).toBe(upstream.priority);
  expect(upstreamNativeEntry(reviewer)).toBeNull();
  expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(reviewer)).toBe(false);
});

test("merge preserves the first live row over duplicate persisted/generated rows and forces hide", () => {
  const live: RawEntry = { ...structuredClone(upstream), visibility: "list", display_name: "Live reviewer", comp_hash: "live", supported_reasoning_levels: [{ effort: "low", description: "Live Low" }] };
  const before = structuredClone(live);
  const rows = merge([live, { ...structuredClone(upstream), display_name: "Duplicate" }], true, {
    baselineCatalogModels: [{ ...structuredClone(upstream), display_name: "Baseline" }],
    routedEntries: [structuredClone(upstream)],
  });
  const expected = { ...before, visibility: "hide", multi_agent_version: "v2", opencodex_multi_agent_version_origin: "v1" };
  delete expected.prefer_websockets;
  expect(reviewRow(rows)).toEqual(expected);
  expect(live).toEqual(before);
  expect(merge(rows)).toEqual(rows);
});

test("native recovery preserves a persisted reviewer without admitting it to visible native authority", () => {
  const persisted: RawEntry = { ...structuredClone(upstream), comp_hash: "cache-reviewer" };
  const recovered = mergeCatalogModelsWithNativeRecovery([], [[persisted, structuredClone(upstream)]]);
  expect(reviewRow(merge(recovered)).comp_hash).toBe("cache-reviewer");
  expect(filterSupportedNativeSlugs(recovered)).toEqual([]);
});

test("reviewer stays out of native picker, Desktop, public native lists and both subagent surfaces", () => {
  const rows = merge();
  const row = reviewRow(rows);
  expect(filterSupportedNativeSlugs(rows)).not.toContain(reviewer);
  expect(visibleNativeSlugs(nativeConfig)).not.toContain(reviewer);
  expect(desktopVisibleNativeSlugs(nativeConfig)).not.toContain(reviewer);
  for (const surface of ["v1", "v2"] as const) {
    const roster = effectiveSubagentRoster([reviewer], surface, rows);
    expect(roster.candidates.some(model => model.model === reviewer)).toBe(false);
    expect(roster.advertised).toEqual([]);
  }
  expect(row.supported_reasoning_levels).toEqual(upstream.supported_reasoning_levels);
  clampCatalogModelsToObservedCodexSupport(rows, new Set(["high"]));
  expect(row.supported_reasoning_levels).toEqual(upstream.supported_reasoning_levels);
});

test("root/provider/per-model overrides keep precedence without stamping the reviewer", () => {
  const rows = merge([], true, { routedEntries: [
    { slug: "other/task", description: "Routed via opencodex → other", visibility: "list" },
    { slug: "other/provider-review", visibility: "list" },
    { slug: "other/model-review", visibility: "list" },
    { slug: "other/root-review", visibility: "list" },
  ] });
  const row = reviewRow(rows);
  const before = structuredClone(row);
  expect(applyAutoReviewModelOverride(rows, "other/root-review")).toBe("applied");
  expect(row).toEqual(before);
  const config: OcxConfig = structuredClone(otherConfig);
  config.providers.other!.autoReviewModel = "provider-review";
  config.providers.other!.autoReviewModelOverrides = { task: "model-review" };
  expect(applyConfiguredAutoReviewModelOverride(rows, "other/root-review", config)).toBe("applied");
  expect(rows.find(entry => entry.slug === "other/task")?.auto_review_model_override).toBe("other/model-review");
  expect(rows.find(entry => entry.slug === "other/provider-review")?.auto_review_model_override).toBe("other/provider-review");
  expect(rows.find(entry => entry.slug === "gpt-5.5")?.auto_review_model_override).toBe("other/root-review");
  expect(row).toEqual(before);
  applyConfiguredAutoReviewModelOverride(rows, undefined, config);
  expect(rows.find(entry => entry.slug === "other/task")?.auto_review_model_override).toBe("other/model-review");
  expect(row).toEqual(before);
});

test("an explicit override may target the hidden reviewer without stamping that row", () => {
  const rows = merge();
  const row = reviewRow(rows);
  const before = structuredClone(row);
  expect(applyAutoReviewModelOverride(rows, reviewer)).toBe("applied");
  expect(rows.find(entry => entry.slug === "gpt-5.5")?.auto_review_model_override).toBe(reviewer);
  expect(row).toEqual(before);
});

test("router keeps the exact reviewer wire id and fails without canonical OpenAI", () => {
  expect([...CODEX_INTERNAL_OPENAI_MODELS]).toEqual([reviewer]);
  expect(readFileSync(repoPath("src/router.ts"), "utf8")).toMatch(/import\s*\{[^}]*\bCODEX_INTERNAL_OPENAI_MODELS\b[^}]*\}\s*from\s*["']\.\/codex\/control-plane-models["']/);
  expect(routeModel(nativeConfig, reviewer)).toMatchObject({ providerName: "openai", modelId: reviewer });
  expect(() => routeModel(otherConfig, reviewer)).toThrow(NoEnabledOpenAiProviderError);
});

for (const writer of ["retained-sync", "convergence"] as const) {
  for (const includeNative of [true, false]) {
    test(`${writer} ${includeNative ? "keeps" : "omits"} the reviewer across two catalog/cache writes`, () => {
      const base = repoPath(".tmp", "auto-review-verification");
      mkdirSync(base, { recursive: true });
      const root = mkdtempSync(join(base, "writer-"));
      const codexHome = join(root, "codex");
      const ocxHome = join(root, "ocx");
      mkdirSync(codexHome); mkdirSync(ocxHome);
      const config = includeNative ? nativeConfig : otherConfig;
      writeFileSync(join(ocxHome, "config.json"), JSON.stringify(config));
      writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
      writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [
        { slug: "gpt-5.5", visibility: "list", display_name: "GPT-5.5", priority: 1, base_instructions: "You are Codex." },
        { ...structuredClone(upstream), visibility: "list", comp_hash: "persisted" },
      ] }));
      const script = `
        const { readFileSync } = require("node:fs");
        const { join } = require("node:path");
        const config = JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME, "config.json"), "utf8"));
        const { syncCatalogModels } = require("./src/codex/catalog");
        require("./src/config").saveConfig(config);
        const { captureCatalogAdmissionSnapshot } = require("./src/codex/catalog-admission");
        const { gatherCodexCatalogCandidate, commitCodexCatalogCandidate } = require("./src/codex/convergence");
        (async () => {
          const passes = [];
          for (let i = 0; i < 2; i++) {
            if (${writer === "retained-sync"}) {
              const synced = await syncCatalogModels(config, { allowWhenDesiredDisabled: true });
              if (synced.refreshOutcome !== "committed") throw new Error(JSON.stringify(synced));
              require("./src/codex/catalog").invalidateCodexModelsCache({ allowWhenDesiredDisabled: true });
            }
            else {
              const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config));
              if (gathered.kind !== "candidate") throw new Error(JSON.stringify(gathered));
              const committed = await commitCodexCatalogCandidate(gathered.candidate, 1000);
              if (committed.kind !== "committed") throw new Error(JSON.stringify(committed));
            }
            passes.push(["opencodex-catalog.json", "models_cache.json"].map(file =>
              JSON.parse(readFileSync(join(process.env.CODEX_HOME, file), "utf8")).models
                .filter(row => row.slug === "codex-auto-review")));
          }
          if (${writer === "convergence" && includeNative}) {
            const { startServer } = require("./src/server");
            const server = startServer(0);
            try {
              const raw = await fetch(new URL("/v1/models", server.url));
              if (raw.status !== 200) throw new Error("public model list status: " + raw.status);
              const data = await raw.json();
              if (data.data.some(row => row.id === "codex-auto-review")) throw new Error("reviewer leaked into public models");
              const rich = await fetch(new URL("/v1/models?client_version=0.160.0", server.url));
              if (rich.status !== 200) throw new Error("Codex model list status: " + rich.status);
              const catalog = await rich.json();
              const internal = catalog.models.filter(row => row.slug === "codex-auto-review");
              if (internal.length !== 1 || internal[0].visibility !== "hide") throw new Error("missing hidden reviewer in Codex HTTP catalog");
            } finally { await server.stop(true); }
          }
          console.log("AUTO_REVIEW_RESULT=" + JSON.stringify(passes));
        })();
      `;
      try {
        const result = spawnSync(process.execPath, ["--eval", script], {
          cwd: repoRoot(), env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
          encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
        });
        expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
        const passes = JSON.parse(result.stdout.split("\n").find(line => line.startsWith("AUTO_REVIEW_RESULT="))!.slice("AUTO_REVIEW_RESULT=".length)) as RawEntry[][][];
        for (const pass of passes) for (const rows of pass) {
          if (includeNative) {
            expect(reviewRow(rows).comp_hash).toBe("persisted");
            expect(rows[0]!.supported_reasoning_levels).toEqual(upstream.supported_reasoning_levels);
          } else expect(rows).toEqual([]);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}
