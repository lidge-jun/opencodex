import { routedSlug } from "../../src/providers/slug-codec";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { SUBAGENT_MODELS_VERSION } from "../../src/config/subagent-models";
import type { OcxConfig } from "../../src/types";
import { captureCatalogAdmissionSnapshot } from "../../src/codex/catalog-admission";
import { convergeCodexCatalog } from "../../src/codex/convergence";
import { loadBundledCodexCatalog, resetCatalogRuntimeStateForTests, syncCatalogModels } from "../../src/codex/catalog";
import type { RawCatalog, RawEntry } from "../../src/codex/catalog/parsing";
import { clearModelCache, markModelsFetchFailure } from "../../src/codex/model-cache";
import { loadPersistedCodexRuntime, resetCodexRuntimeResolveCacheForTests, resolveCodexRuntime } from "../../src/codex/runtime";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { resolveCodexCatalogSerializationDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { effectiveSubagentRoster } from "../../src/codex/catalog/sync";
import { buildCatalogEntriesFromObservedState, mergeCatalogEntriesFromObservedState, CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, applyFullModelPickerOrder, deriveEntry, mergeCatalogEntriesForSync, SPAWN_PRIORITY_FIELD } from "../../src/codex/catalog/sync";

test("native-first picker order preserves Go subagent ranks and is repeatable", () => {
  const rows: any[] = [
    { slug: "opencode-go/glm-5.3", priority: 0 },
    { slug: "gpt-5.6-sol", priority: 9 },
    { slug: "gpt-6-astra", priority: 9 },
  ];
  const order = ["gpt-6-astra", "gpt-5.6-sol", "opencode-go/glm-5.3"];
  applyFullModelPickerOrder(rows, order);
  expect([...rows].sort((a,b) => a.priority-b.priority).map(r => r.slug)).toEqual(order);
  expect(rows.map(r => r[SPAWN_PRIORITY_FIELD])).toEqual([0,9,9]);
  const once = structuredClone(rows);
  applyFullModelPickerOrder(rows, order);
  expect(rows).toEqual(once);
});

test("existing routed-only ordering retains its behavior", () => {
  const rows: any[] = [{ slug: "opencode-go/glm-5.3", priority: 1000 }];
  applyFullModelPickerOrder(rows, ["opencode-go/glm-5.3"]);
  expect(rows).toEqual([{ slug: "opencode-go/glm-5.3", priority: 1000 }]);
});

test("full picker helper treats a null passthrough order as absent", () => {
  const rows = [{ slug: "gpt-5.5", priority: 9 }, { slug: "opencode-go/model", priority: 0 }];
  const before = structuredClone(rows);
  // Production callers coalesce null; the exported boundary must also tolerate it directly.
  applyFullModelPickerOrder(rows, null as unknown as readonly string[]);
  expect(rows).toEqual(before);
});


test("sync refreshes native spawn rank when featured models change", () => {
  const sol = deriveEntry(null, "gpt-5.6-sol", "Sol", 105);
  const order = ["gpt-5.6-sol"];
  applyFullModelPickerOrder([sol], order);
  expect(sol[SPAWN_PRIORITY_FIELD]).toBe(105);

  const baseline = new Map([["gpt-5.6-sol", 9]]);
  const promoted = mergeCatalogEntriesForSync([sol], [], baseline, ["gpt-5.6-sol"], false);
  applyFullModelPickerOrder(promoted, order);
  expect(promoted.find(entry => entry.slug === sol.slug)?.[SPAWN_PRIORITY_FIELD]).toBe(0);

  const demoted = mergeCatalogEntriesForSync(promoted, [], baseline, ["opencode-go/glm-5.3"], false);
  applyFullModelPickerOrder(demoted, order);
  expect(demoted.find(entry => entry.slug === sol.slug)?.[SPAWN_PRIORITY_FIELD]).toBe(101);
});

test("fresh routed rows do not inherit a previously ordered native template's guidance rank", () => {
  const ids = ["fresh-a", "fresh-b", "fresh-c", "fresh-d", "fresh-e", "fresh-f"];
  const slugs = ids.map(id => routedSlug("opencode-go", id));
  const featured = slugs.slice(0, 5);
  const order = ["gpt-5.5", slugs[5]!, ...featured.toReversed()];
  const template = deriveEntry(null, "gpt-5.5", "Previously ordered native", 0);
  template[SPAWN_PRIORITY_FIELD] = 9;
  const previousTemplate = structuredClone(template);
  const rows = buildCatalogEntriesFromObservedState({
    template,
    gptSlugs: ["gpt-5.5"],
    goModels: ids.map(id => ({
      provider: "opencode-go", id,
      reasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "xhigh",
    })),
    featured, modelPickerOrder: order,
    wsEnabled: false, multiAgentMode: "v2", multiAgentV2Enabled: true,
    exactComboSlugs: new Set(), accountSelectors: [],
    suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
  });

  const featuredRows = featured.map(slug => rows.find(row => row.slug === slug)!);
  expect(featuredRows.map(row => row[SPAWN_PRIORITY_FIELD] ?? row.priority)).toEqual([0, 1, 2, 3, 4]);
  const expectedCandidates = featured.map(model => ({ model, efforts: ["high", "xhigh"] }));
  const before = effectiveSubagentRoster(featured, "v2", rows);
  expect(before.candidates).toEqual(expectedCandidates);
  expect(before.advertised).toEqual(expectedCandidates);

  applyFullModelPickerOrder(rows, order);
  expect(effectiveSubagentRoster(featured, "v2", rows)).toEqual(before);
  expect(rows.toSorted((a, b) => Number(a.priority) - Number(b.priority)).map(row => row.slug)).toEqual(order);
  expect(template).toEqual(previousTemplate);
});


test("bare native ids and routed slugs match exactly, without suffix aliases", () => {
  const rows: any[] = [
    { slug: "openai/gpt-5.6-sol", priority: 2 },
    { slug: "gpt-5.6-sol", priority: 9 },
    { slug: "other/gpt-5.6-sol", priority: 3 },
  ];
  applyFullModelPickerOrder(rows, ["gpt-5.6-sol", "openai/gpt-5.6-sol"]);
  expect(rows.map(row => row.priority)).toEqual([1, 0, 5]);
  expect(rows.map(row => row[SPAWN_PRIORITY_FIELD])).toEqual([2, 9, 3]);
});

test.each([
  { order: [] as string[] },
  { order: ["gpt-5.6-sol", "opencode-go/glm-5.3"], after: ["opencode-go/glm-5.3"] },
  { order: ["gpt-5.6-sol", "opencode-go/glm-5.3"], before: ["opencode-go/glm-5.3"], after: [] },
  { order: ["gpt-5.6-sol", "opencode-go/team/model"], modelId: "team/model", before: ["other/model", "opencode-go/team/model"], after: ["opencode-go/team/model", "other/model"] },

  { order: ["", "opencode-go/glm-5.3"] },
  { order: [" ", "opencode-go/glm-5.3"] },
  { order: [""] },
  { order: ["opencode-go/team/model"], modelId: "team/model" },
  { order: ["opencode-go/glm-5.3"] },
  { order: ["other/model", "opencode-go/glm-5.3"] },
])("degraded discovery refreshes ranks and remains stable for %j", ({ order, modelId = "glm-5.3", before = [], after = [] }) => {
  for (const accountSelectors of [[], ["account-a", "account-b"]]) {
    const slug = routedSlug("opencode-go", modelId);
    const fresh = (modelPickerOrder: readonly string[], featured: readonly string[] = []) => buildCatalogEntriesFromObservedState({
      template: null, gptSlugs: [],
      goModels: [{ id: modelId, provider: "opencode-go", displayName: "GLM 5.3", reasoningEfforts: ["high", "max"] }],
      featured, modelPickerOrder, wsEnabled: false, multiAgentMode: "default",
      exactComboSlugs: new Set(), accountSelectors, suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false,
    });
    const merge = (catalogModels: Record<string, unknown>[], routedEntries: Record<string, unknown>[], modelPickerOrder: readonly string[], degraded: boolean, featured: readonly string[] = []) =>
      mergeCatalogEntriesFromObservedState({
        catalogModels, routedEntries, modelPickerOrder, accountSelectors,
        baselineCatalogModels: [], baseline: new Map(), featured, wsEnabled: false,
        template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
        gatheredProviderNames: new Set(["opencode-go"]),
        degradedProviderNames: new Set(degraded ? ["opencode-go"] : []),
        legacyCustomModelSlugs: new Set(), multiAgentMode: "default", multiAgentV2Enabled: false,
        exactComboSlugs: new Set(), hasPhysicalComboProvider: false, includeNativeOpenAi: true,
        accountBoundEntries: [],
        policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" },
      });
    const fullOrder = ["gpt-5.6-sol", slug];
    const previous = merge([], fresh(fullOrder, before), fullOrder, false, before);
    const saved = structuredClone(previous);
    const healthy = merge(previous, fresh(order, after), order, false, after);
    const degraded = merge(previous, [], order, true, after);
    const row = (entries: Record<string, unknown>[]) => entries.find(entry => entry.slug === slug)!;
    expect(row(degraded).priority).toBe(row(healthy).priority);
    expect(row(degraded)[SPAWN_PRIORITY_FIELD]).toBe(row(healthy)[SPAWN_PRIORITY_FIELD]);
    expect(merge(degraded, [], order, true, after)).toEqual(degraded);
    expect(previous).toEqual(saved);
  }
});


test("full ordering ignores empty entries and accepts raw upstream ids with slashes", () => {
  const slug = routedSlug("vendor", "team/model");
  const rows = [{ slug, priority: 1000 }, { slug: "gpt-5.6-sol", priority: 9 }];
  applyFullModelPickerOrder(rows, ["", "gpt-5.6-sol", "vendor/team/model"]);
  expect(rows.map(row => row.priority)).toEqual([1, 0]);
  const exact = [{ slug, priority: 5 }];
  applyFullModelPickerOrder(exact, ["gpt-5.6-sol", slug, "vendor/team/model"]);
  expect(exact[0]!.priority).toBe(1);
});

describe("picker ordering through production catalog writers", () => {
  const ids = ["ordering-a", "ordering-b", "ordering-c", "ordering-d", "ordering-e", "ordering-f"];
  const slugs = ids.map(id => routedSlug("opencode-go", id));
  const configuredEfforts = ["high", "xhigh"];
  const envKeys = ["CODEX_HOME", "OPENCODEX_HOME", "CODEX_CLI_PATH"] as const;
  let previousEnv: Array<string | undefined>;
  let previousFetch: typeof fetch;
  let root: string;
  let codexHome: string;
  let catalogPath: string;
  let fetchCalls: number;
  let runtimeCommand: string;

  // Same executable-fixture protocol as codex-convergence-account-selectors.test.ts:
  // a forced resolver refresh must receive the same version and catalog as a warm read.
  function createRuntimeFixture(catalog: RawCatalog): string {
    const script = join(root, "fixture-codex.js");
    writeFileSync(script, [
      'if (process.argv.includes("--version")) {',
      '  console.log("codex-cli 0.145.0");',
      '} else {',
      `  process.stdout.write(${JSON.stringify(JSON.stringify(catalog))});`,
      '}',
    ].join("\n"));
    if (process.platform === "win32") {
      const command = join(root, "fixture-codex.cmd");
      writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
      return command;
    }
    const command = join(root, "fixture-codex");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
    chmodSync(command, 0o755);
    return command;
  }

  function assertRuntimeIdentity(): void {
    const resolved = resolveCodexRuntime({ discoverAlternatives: false });
    expect(resolved.runtime.command).toBe(runtimeCommand);
    expect(resolved.runtime.version).toBe("0.145.0");
    const persisted = loadPersistedCodexRuntime();
    expect(persisted?.command).toBe(runtimeCommand);
    expect(persisted?.selectedVersion).toBe("0.145.0");
  }

  beforeEach(() => {
    previousEnv = envKeys.map(key => process.env[key]);
    previousFetch = globalThis.fetch;
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-picker-writers-")));
    codexHome = join(root, "codex");
    const opencodexHome = join(root, "ocx");
    mkdirSync(codexHome);
    mkdirSync(opencodexHome);
    process.env.CODEX_HOME = codexHome;
    process.env.OPENCODEX_HOME = opencodexHome;
    catalogPath = join(codexHome, "custom-catalog.json");
    writeFileSync(join(codexHome, "config.toml"),
      'model_catalog_json = "custom-catalog.json"\n[features]\nmulti_agent_v2 = true\n');
    resetCatalogRuntimeStateForTests();
    resetCodexRuntimeResolveCacheForTests();
    resetCodexModelEntitlementCacheForTests();
    const native = deriveEntry(null, "gpt-5.5", "Native fixture", 9);
    const catalog = { models: [native] };
    runtimeCommand = createRuntimeFixture(catalog);
    process.env.CODEX_CLI_PATH = runtimeCommand;
    // Resolve the real fixture executable before admission captures runtime provenance.
    expect(loadBundledCodexCatalog()?.models?.[0]?.slug).toBe("gpt-5.5");
    assertRuntimeIdentity();
    writeFileSync(catalogPath, JSON.stringify(catalog));
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("catalog writer fixture must not make a network request");
    }) as typeof fetch;
  });

  afterEach(() => {
    try {
      const database = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
      for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
    } finally {
      globalThis.fetch = previousFetch;
      envKeys.forEach((key, index) => {
        const value = previousEnv[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      resetCatalogRuntimeStateForTests();
      resetCodexRuntimeResolveCacheForTests();
      resetCodexModelEntitlementCacheForTests();
      removeTreeWithRetry(root);
    }
  });

  function config(featured = slugs.slice(0, 5), order: string[] = []): OcxConfig {
    return {
      port: 10100,
      defaultProvider: "opencode-go",
      multiAgentMode: "v2",
      subagentModels: featured,
      subagentModelsVersion: SUBAGENT_MODELS_VERSION,
      modelPickerOrder: order,
      providers: {
        openai: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward" },
        "opencode-go": {
          adapter: "openai-chat", baseUrl: "https://catalog-fixture.invalid/v1", authMode: "key",
          apiKey: "ordering-fixture-key", liveModels: false, models: [...ids],
          modelReasoningEfforts: Object.fromEntries(ids.map(id => [id, [...configuredEfforts]])),
          modelDefaultReasoningEfforts: Object.fromEntries(ids.map(id => [id, "xhigh"])),
        },
      },
    };
  }

  async function writeCatalog(writer: "convergence" | "retained", next: OcxConfig, degraded = false): Promise<RawEntry[]> {
    assertRuntimeIdentity();
    const requestedRoster = [...next.subagentModels!];
    saveConfig(next);
    const saved = loadConfig();
    expect(saved.subagentModelsVersion).toBe(SUBAGENT_MODELS_VERSION);
    expect(saved.subagentModels).toEqual(requestedRoster);
    expect(next.subagentModels).toEqual(requestedRoster);
    if (degraded) {
      // Preserve disk rows without a discovery cache; built-in metadata augmentation still runs.
      clearModelCache("opencode-go");
      markModelsFetchFailure("opencode-go");
    }
    if (writer === "convergence") {
      const result = await convergeCodexCatalog(captureCatalogAdmissionSnapshot(next), {
        action: "converge", scope: "catalog", reason: "management-mutation", mode: "explicit", deadlineMs: 5_000,
      });
      expect(result.catalogRefresh).toMatchObject({ status: "committed", degraded });
    } else {
      const result = await syncCatalogModels(next);
      expect(result.path).toBe(catalogPath);
      expect(result.skippedReason).toBeUndefined();
    }
    assertRuntimeIdentity();
    expect(fetchCalls).toBe(0);
    return (JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog).models ?? [];
  }

  function roster(rows: RawEntry[], featured: string[]) {
    const beforeAssertions = JSON.stringify(rows);
    const result = effectiveSubagentRoster(featured, "v2", rows);
    expect(result.candidates.map(candidate => candidate.model)).toEqual(featured);
    expect(result.candidates).toHaveLength(5);
    expect(result.advertised).toEqual(result.candidates);
    for (const candidate of result.candidates) expect(candidate.efforts).toEqual(configuredEfforts);
    for (const slug of slugs) {
      const row = rows.find(row => row.slug === slug);
      expect(row).toBeDefined();
      expect(row!.default_reasoning_level).toBe("xhigh");
      const levels = row!.supported_reasoning_levels;
      expect(Array.isArray(levels)).toBe(true);
      expect((levels as Array<{ effort: string }>).map(level => level.effort)).toEqual(configuredEfforts);
    }
    // Full catalog comparisons below must still compare untouched metadata, not matcher nodes.
    expect(JSON.stringify(rows)).toBe(beforeAssertions);
    return result;
  }

  for (const writer of ["convergence", "retained"] as const) {
    const filteredOrder = ["gpt-5.5", slugs[5]!, ...slugs.slice(0, 5).reverse(), " gpt-5.5 "];
    const malformedOrders: Array<{ label: string; input: unknown; filtered: string[] }> = [
      { label: "string scalar", input: "gpt-5.5", filtered: [] },
      { label: "number scalar", input: 7, filtered: [] },
      { label: "boolean scalar", input: true, filtered: [] },
      { label: "object", input: { 0: "gpt-5.5", length: 1 }, filtered: [] },
      {
        label: "mixed array",
        input: [null, 7, "", " \t", filteredOrder[0], false, filteredOrder[1], {}, ...filteredOrder.slice(2)],
        // Significant surrounding whitespace remains part of the original spelling.
        filtered: filteredOrder,
      },
    ];

    test.each(malformedOrders)(`${writer} tolerates $label passthrough order in healthy and retained discovery`, async ({ input, filtered }) => {
      const control = config(slugs.slice(0, 5), filtered);
      const expected = await writeCatalog(writer, control);
      if (filtered.length > 0) {
        // Trimming the final nonblank string would incorrectly override the native rank.
        expect(expected.find(row => row.slug === "gpt-5.5")?.priority).toBe(0);
      }
      const expectedRoster = roster(expected, control.subagentModels!);
      // Model configuration is passthrough at runtime; exercise the writers, not the normalizer.
      const malformed = Object.assign(config(control.subagentModels), { modelPickerOrder: input });
      const actual = await writeCatalog(writer, malformed);
      expect(actual).toEqual(expected);
      expect(roster(actual, control.subagentModels!)).toEqual(expectedRoster);

      const priorCatalog = readFileSync(catalogPath);
      const cachePath = join(codexHome, "models_cache.json");
      const priorCache = existsSync(cachePath) ? readFileSync(cachePath) : null;
      const restoreSeed = () => {
        writeFileSync(catalogPath, priorCatalog);
        if (priorCache === null) rmSync(cachePath, { force: true });
        else writeFileSync(cachePath, priorCache);
      };
      const retainedControl = config(control.subagentModels, filtered);
      const retainedMalformed = Object.assign(config(control.subagentModels), { modelPickerOrder: input });
      for (const candidate of [retainedControl, retainedMalformed]) {
        candidate.providers["opencode-go"]!.liveModels = true;
        candidate.providers["opencode-go"]!.models = [];
      }
      // Both sides activate identical Go metadata augmentation and failure/cooldown state.
      // Only the malformed order differs; a static healthy catalog is not this counterfactual.
      restoreSeed();
      const expectedRetained = await writeCatalog(writer, retainedControl, true);
      const expectedRetainedRoster = roster(expectedRetained, control.subagentModels!);
      expect(expectedRetainedRoster).toEqual(expectedRoster);
      restoreSeed();
      const retained = await writeCatalog(writer, retainedMalformed, true);
      expect(retained).toEqual(expectedRetained);
      expect(roster(retained, control.subagentModels!)).toEqual(expectedRetainedRoster);
    }, 30_000);

    test(`${writer} applies full display order without changing five eligible Go candidates`, async () => {
      const initial = config();
      const before = roster(await writeCatalog(writer, initial), initial.subagentModels!);
      // Bring the sixth routed model above every featured model in the display.
      const order = ["gpt-5.5", slugs[5]!, ...slugs.slice(0, 5).reverse()];
      const ordered = config(initial.subagentModels, order);
      const rows = await writeCatalog(writer, ordered);
      expect(rows.filter(row => order.includes(String(row.slug)))
        .sort((a, b) => Number(a.priority) - Number(b.priority)).map(row => row.slug)).toEqual(order);
      expect(roster(rows, ordered.subagentModels!)).toEqual(before);
      expect(roster(await writeCatalog(writer, ordered), ordered.subagentModels!)).toEqual(before);
    }, 30_000);

    test(`${writer} refreshes retained outage ranks after a full-picker and featured-roster change`, async () => {
      const previous = await writeCatalog(writer, config(slugs.slice(0, 5), ["gpt-5.5", ...slugs]));
      for (const row of previous) {
        if (slugs.includes(String(row.slug))) row.ordering_retained_fixture = true;
      }
      // Promote the formerly excluded sixth model, demote the first, and clear full ordering.
      const featured = slugs.slice(1).reverse();
      const next = config(featured, [slugs[0]!]);
      const healthy = await writeCatalog(writer, next);
      const expectedRoster = roster(healthy, featured);
      writeFileSync(catalogPath, JSON.stringify({ models: previous }));
      next.providers["opencode-go"]!.liveModels = true;
      next.providers["opencode-go"]!.models = [];
      const retained = await writeCatalog(writer, next, true);
      expect(roster(retained, featured)).toEqual(expectedRoster);
      for (const slug of slugs) {
        const actual = retained.find(row => row.slug === slug)!;
        const expected = healthy.find(row => row.slug === slug)!;
        expect(actual.ordering_retained_fixture).toBe(true);
        expect(actual.priority).toBe(expected.priority);
        expect(actual[SPAWN_PRIORITY_FIELD]).toBe(expected[SPAWN_PRIORITY_FIELD]);
      }
      expect(await writeCatalog(writer, next, true)).toEqual(retained);
    }, 30_000);
  }
});
