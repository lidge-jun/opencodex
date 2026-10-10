/**
 * Ultra Fast: name the tier the proxy is already carrying.
 *
 * PR #2994 added an `ultrafast` row to the pinned catalog and was closed unmerged with
 * the verdict that the picker gained a choice the wire could not honor —
 * `src/codex/data/upstream-models.json` advertises only `priority`, so the row was
 * fabricated metadata. That decision stands: nothing here synthesizes a catalog row.
 *
 * What #3429 reported is separately true and fixable. A caller who supplies
 * `service_tier: "ultrafast"` themselves gets the request forwarded, and then the proxy
 * records `fastOutcome: "not-requested"` and no speed label — it asserts the user asked
 * for nothing. These tests pin the corrected accounting.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { canonicalFastTierMarker, createAdapterTierMetadata, decideTier, tierObservationContext } from "../../src/providers/fastwire";
import { requestLogSpeedLabel } from "../../src/server/request-log";
import { normalizeRoutedCatalogEntry } from "../../src/codex/catalog/parsing";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import { buildCatalogEntriesFromObservedState, mergeCatalogEntriesFromObservedState, type ObservedCatalogMergeInput } from "../../src/codex/catalog/build-entries";

describe("operator ultrafast survives the build and merge boundary", () => {
  const tier = { id: "ultrafast", name: "Ultra Fast", description: "operator supplied" };
  const slug = "gateway/task-model";
  const previous = (): RawEntry => ({ slug, service_tiers: [tier], additional_speed_tiers: ["ultrafast"] });
  const build = (provider = "gateway", id = "task-model", supportsServiceTier = true) =>
    buildCatalogEntriesFromObservedState({
      template: { slug: "gpt-5.5", service_tiers: [{ id: "priority", name: "Fast" }] },
      gptSlugs: [], goModels: [{ provider, id, supportsServiceTier }], wsEnabled: false,
      multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
      accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
    });
  const merge = (catalogModels: RawEntry[], routedEntries = build(), extra: Partial<ObservedCatalogMergeInput> = {}) =>
    mergeCatalogEntriesFromObservedState({
      catalogModels, routedEntries, baselineCatalogModels: [], baseline: new Map(), featured: [],
      wsEnabled: false, template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
      gatheredProviderNames: new Set(["gateway"]), degradedProviderNames: new Set(),
      legacyCustomModelSlugs: new Set(), multiAgentMode: "default", multiAgentV2Enabled: false,
      exactComboSlugs: new Set(), hasPhysicalComboProvider: false, includeNativeOpenAi: false,
      accountBoundEntries: [], ultraFastTier: true,
      policy: { nativeBackfillSlugs: [], unsupportedNativeEntries: "drop", warningPolicy: "suppress" },
      ...extra,
    });
  const row = (rows: RawEntry[]) => rows.find(entry => entry.slug === slug)!;

  test("fresh Fast capability and the exact old Ultra Fast declaration both survive", () => {
    const old = [previous()];
    const fresh = build();
    const before = structuredClone({ old, fresh });
    const result = row(merge(old, fresh));
    expect(result.service_tiers).toEqual([...(row(fresh).service_tiers as unknown[]), tier]);
    expect(result.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    expect(result.default_service_tier).toBeNull();
    expect({ old, fresh }).toEqual(before);
    expect(row(merge(merge(old, fresh), fresh))).toEqual(result);
  });

  test("an explicit operator Ultra Fast default is preserved", () => {
    const result = row(merge([{ ...previous(), service_tier: "ultrafast", default_service_tier: "ultrafast" }]));
    expect(result.service_tier).toBe("ultrafast");
    expect(result.default_service_tier).toBe("ultrafast");
  });

  test("OFF keeps only the freshly declared Fast capability", () => {
    expect(row(merge([previous()], build(), { ultraFastTier: false })).additional_speed_tiers).toEqual(["fast"]);
  });

  test("opt-in alone and other providers or model ids cannot seed Ultra Fast", () => {
    for (const old of [[], [{ ...previous(), slug: "other/task-model" }], [{ ...previous(), slug: "gateway/other" }]]) {
      expect(row(merge(old)).additional_speed_tiers).toEqual(["fast"]);
    }
  });

  test("degraded retained rows obey the explicit flag immediately", () => {
    const extra = { degradedProviderNames: new Set(["gateway"]) };
    expect(row(merge([previous()], [], extra)).additional_speed_tiers).toEqual(["ultrafast"]);
    const disabled = row(merge([previous()], [], { ...extra, ultraFastTier: false }));
    expect(disabled.additional_speed_tiers).toBeUndefined();
    expect(disabled.service_tiers).toBeUndefined();
  });

  test("native template and backup metadata cannot seed a new routed row", () => {
    const inherited = build();
    Object.assign(row(inherited), previous());
    const result = row(merge([], inherited, { baselineCatalogModels: [previous()] }));
    expect(result.additional_speed_tiers).toBeUndefined();
    expect(result.service_tiers).toBeUndefined();
  });

  test("a provider without Fast receives only its own declared Ultra Fast", () => {
    const result = row(merge([previous()], build("gateway", "task-model", false)));
    expect(result.service_tiers).toEqual([tier]);
    expect(result.additional_speed_tiers).toEqual(["ultrafast"]);
  });

  test("disabled, deselected and removed rows are not resurrected", () => {
    expect(merge([previous()], build(), { disabledModels: new Set([slug]) })).toEqual([]);
    expect(merge([previous()], build(), { selectedModelsByProvider: new Map([["gateway", new Set<string>()]]) })).toEqual([]);
    expect(merge([previous()], [])).toEqual([]);
  });

  test("sparse declarations preserve only supplied fields and reject malformed tier ids", () => {
    const speedsOnly = row(merge([{ slug, additional_speed_tiers: [null, "ultrafast", "ultrafast"] }]));
    expect(speedsOnly.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    expect(speedsOnly.service_tiers).toEqual(row(build()).service_tiers);
    const malformed = row(merge([{ slug, service_tiers: [null, {}, { id: 1 }] }]));
    expect(malformed.additional_speed_tiers).toEqual(["fast"]);
  });

  test("duplicate persisted rows follow the writers' first-win slug policy", () => {
    const stale: RawEntry = { slug, service_tiers: [{ id: "priority", name: "Fast" }], additional_speed_tiers: ["fast"] };
    expect(row(merge([previous(), stale])).additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    expect(row(merge([stale, previous()])).additional_speed_tiers).toEqual(["fast"]);
  });
});

for (const writer of ["retained-sync", "convergence"] as const) {
  test(writer + " retains operator Ultra Fast across two catalog/cache writes and removes it when disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-ultrafast-writer-"));
    const codexHome = join(root, "codex");
    const ocxHome = join(root, "ocx");
    mkdirSync(codexHome); mkdirSync(ocxHome);
    const config = {
      port: 10100, defaultProvider: "gateway", ultraFastTier: true,
      providers: { openai: {
        adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", liveModels: false,
      }, gateway: {
        adapter: "openai-responses", baseUrl: "https://provider.invalid/v1", liveModels: false,
        models: ["task-model"], modelSupportsServiceTier: { "task-model": true },
      } },
    };
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify(config));
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [
      { slug: "gpt-5.5", visibility: "list", base_instructions: "You are Codex." },
      { slug: "gateway/task-model", service_tiers: [{ id: "ultrafast", name: "Ultra Fast", description: "operator supplied" }], additional_speed_tiers: ["ultrafast"] },
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
      for (const enabled of [true, true, false]) {
        config.ultraFastTier = enabled;
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
            .filter(row => row.slug === "gateway/task-model")));
      }
      console.log("ULTRAFAST_RESULT=" + JSON.stringify(passes));
    `;
    try {
      const result = spawnSync(process.execPath, ["--eval", script], {
        cwd: repoRoot(), env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
        encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 20_000,
      });
      expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
      const passes = JSON.parse(result.stdout.split("\n").find(line => line.startsWith("ULTRAFAST_RESULT="))!.slice("ULTRAFAST_RESULT=".length)) as RawEntry[][][];
      for (const [index, pass] of passes.entries()) for (const rows of pass) {
        expect(rows).toHaveLength(1);
        expect(rows[0]!.additional_speed_tiers).toEqual(index < 2 ? ["fast", "ultrafast"] : ["fast"]);
        expect(rows[0]!.service_tiers).toEqual(index < 2
          ? [expect.objectContaining({ id: "priority" }), { id: "ultrafast", name: "Ultra Fast", description: "operator supplied" }]
          : [expect.objectContaining({ id: "priority" })]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

describe("ultrafast intent is recognised, not mistaken for silence", () => {
  test("the caller marker folds ultrafast to its own canonical, not to priority", () => {
    // Folding it onto "priority" would be the other lie: claiming a 1.5x Fast tier was
    // requested when the caller named a different one.
    expect(canonicalFastTierMarker("ultrafast")).toBe("ultrafast");
    expect(canonicalFastTierMarker("UltraFast")).toBe("ultrafast");
    expect(canonicalFastTierMarker("  ultrafast  ")).toBe("ultrafast");
  });

  test("the existing Fast spellings are unchanged", () => {
    expect(canonicalFastTierMarker("priority")).toBe("priority");
    expect(canonicalFastTierMarker("fast")).toBe("priority");
    expect(canonicalFastTierMarker(" PRIORITY ")).toBe("priority");
  });

  test("unrelated tiers still fold to undefined", () => {
    // "auto" reaching a canonical marker would turn every default request into Fast intent.
    expect(canonicalFastTierMarker("auto")).toBeUndefined();
    expect(canonicalFastTierMarker("default")).toBeUndefined();
    expect(canonicalFastTierMarker("ultra")).toBeUndefined();
    expect(canonicalFastTierMarker("ultra-fast")).toBeUndefined();
    expect(canonicalFastTierMarker(undefined)).toBeUndefined();
    expect(canonicalFastTierMarker("")).toBeUndefined();
  });
});

describe("ultrafast gets a speed label", () => {
  test("the label is its own, so Logs cannot read it as Fast", () => {
    expect(requestLogSpeedLabel("ultrafast")).toBe("ultrafast");
    expect(requestLogSpeedLabel(" UltraFast ")).toBe("ultrafast");
  });

  test("the Fast contract is untouched", () => {
    expect(requestLogSpeedLabel("priority")).toBe("fast");
    expect(requestLogSpeedLabel("fast")).toBe("fast");
  });

  test("auto and absent still produce no label", () => {
    // A label here would put a speed badge on every ordinary request.
    expect(requestLogSpeedLabel("auto")).toBeUndefined();
    expect(requestLogSpeedLabel(undefined)).toBeUndefined();
    expect(requestLogSpeedLabel("")).toBeUndefined();
  });
});

/**
 * The catalog half. The flag PRESERVES a tier the operator supplied; it never invents one,
 * which is the line PR #2994 was closed for crossing.
 */
describe("routed rows and the ultrafast opt-in", () => {
  const operatorRow = () => ({
    slug: "kimi/k3",
    service_tier: "ultrafast",
    default_service_tier: "ultrafast",
    service_tiers: [
      { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
      { id: "ultrafast", name: "Ultra Fast", description: "operator supplied" },
    ],
    additional_speed_tiers: ["fast", "ultrafast"],
  });

  test("with the flag OFF every tier field is stripped, exactly as before", () => {
    const entry = normalizeRoutedCatalogEntry(operatorRow(), false, undefined, { ultraFastTier: false });
    expect(entry.service_tier).toBeUndefined();
    expect(entry.service_tiers).toBeUndefined();
    expect(entry.default_service_tier).toBeUndefined();
    expect(entry.additional_speed_tiers).toBeUndefined();
  });

  test("with the flag ON the operator's ultrafast survives regeneration", () => {
    // The whole reported symptom: a hand-edited catalog lost the tier on every sync.
    const entry = normalizeRoutedCatalogEntry(operatorRow(), false, undefined, { ultraFastTier: true });
    expect(entry.service_tiers).toEqual([{ id: "ultrafast", name: "Ultra Fast", description: "operator supplied" }]);
    expect(entry.additional_speed_tiers).toEqual(["ultrafast"]);
    expect(entry.service_tier).toBe("ultrafast");
    expect(entry.default_service_tier).toBe("ultrafast");
  });

  test("the flag never smuggles Fast onto a routed row", () => {
    // Routed rows are stripped because a clone of a native template would otherwise inherit
    // OpenAI's priority tier. Preserving ultrafast must not reopen that.
    const entry = normalizeRoutedCatalogEntry(operatorRow(), false, undefined, { ultraFastTier: true });
    const ids = (entry.service_tiers as Array<{ id: string }>).map(tier => tier.id);
    expect(ids).not.toContain("priority");
    expect(entry.additional_speed_tiers).not.toContain("fast");
  });

  test("the flag invents nothing when the operator supplied no ultrafast", () => {
    // A row carrying only the upstream Fast tier is stripped whether the flag is on or off:
    // upstream advertises no ultrafast, so there is nothing to preserve.
    const fastOnly = {
      slug: "kimi/k3",
      service_tiers: [{ id: "priority", name: "Fast" }],
      additional_speed_tiers: ["fast"],
    };
    const entry = normalizeRoutedCatalogEntry(fastOnly, false, undefined, { ultraFastTier: true });
    expect(entry.service_tiers).toBeUndefined();
    expect(entry.additional_speed_tiers).toBeUndefined();
  });
});

/**
 * The wire decision, which the unit tests above cannot see.
 *
 * Adversarial review caught this: recognising `ultrafast` as a canonical marker routed it
 * into the canonical-wire lookup, and because it is deliberately unmapped the lookup fell
 * through to `drop`. That made recognition strictly WORSE than leaving it unrecognised —
 * before, it was a foreign tier and `foreignCallerTiers: "verbatim"` forwarded it. Every
 * suite still passed, because none of them asserted the decision.
 */
describe("an unmapped canonical tier is forwarded, not dropped", () => {
  const policy = {
    capability: true,
    eligibility: "eligible",
    fastWire: {
      kind: "service-tier",
      canonicalToWire: { priority: "priority" },
      foreignCallerTiers: "verbatim",
    },
    forwardCallerTier: true,
  } as unknown as Parameters<typeof decideTier>[0];

  test("ultrafast reaches the provider instead of being stripped", () => {
    expect(decideTier(policy, undefined, "ultrafast")).toEqual({ kind: "forward-caller" });
  });

  test("mapped Fast spellings still resolve to the wire value", () => {
    expect(decideTier(policy, undefined, "priority")).toEqual({ kind: "set", value: "priority" });
    expect(decideTier(policy, undefined, "fast")).toEqual({ kind: "set", value: "priority" });
  });

  test("unrelated and absent tiers are unchanged", () => {
    expect(decideTier(policy, undefined, "auto")).toEqual({ kind: "forward-caller" });
    expect(decideTier(policy, undefined, undefined)).toEqual({ kind: "forward-caller" });
  });
});

describe("the Fast toggle does not claim to have suppressed a different tier", () => {
  const observe = (callerTier: string, fastMode: boolean | undefined) => {
    const policy = {
      capability: true,
      eligibility: "eligible",
      fastWire: {
        kind: "service-tier",
        canonicalToWire: { priority: "priority" },
        foreignCallerTiers: "verbatim",
      },
      forwardCallerTier: true,
    } as unknown as Parameters<typeof tierObservationContext>[0];
    const context = tierObservationContext(policy, fastMode, callerTier);
    const decision = decideTier(policy, fastMode, callerTier);
    const wireValue = decision.kind === "set" ? decision.value : decision.kind === "drop" ? null : callerTier;
    return createAdapterTierMetadata(context, decision, "service-tier", wireValue)?.outcome;
  };

  test("force-default suppressing a real Fast request is recorded as suppression", () => {
    const outcome = observe("priority", false);
    expect(outcome?.callerFastSuppressedByConfig).toBe(true);
  });

  test("force-default turning away ultrafast is a dropped tier, not a suppressed Fast", () => {
    // The Fast toggle did not suppress a 1.5x Fast request; it turned away a different one.
    const outcome = observe("ultrafast", false);
    expect(outcome?.callerFastSuppressedByConfig).toBeUndefined();
    expect(outcome?.callerTierDropped).toBe(true);
  });
});
