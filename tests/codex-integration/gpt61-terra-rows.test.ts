import { afterEach, describe, expect, test } from "bun:test";
import {
  buildCatalogEntries, nativeDefaultReasoningEffort, nativeInputModalities,
  nativeOpenAiContextTier, nativeReasoningEfforts, upstreamNativeEntry,
} from "../../src/codex/catalog";
import {
  ACCOUNT_GATED_NATIVE_OPENAI_MODELS, CONFIGURED_NATIVE_OPENAI_TEMPLATE_MODEL,
  NATIVE_MAIN_DRAIN_SENTINEL_MODELS, NATIVE_OPENAI_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS, isEligibleConfiguredNativeOpenAiModel,
} from "../../src/codex/catalog/native-models";
import {
  DOCUMENTED_NATIVE_OPENAI_ADDITIONS, NATIVE_OPENAI_CONTEXT_OVERRIDES,
  nativeMultiAgentVersion, nativeOpenAiMaxInputTokens,
} from "../../src/codex/catalog/metadata";
import { nativeEffortClamp } from "../../src/codex/catalog/effort";
import { pinnedNativeModelRows } from "../../src/codex/catalog/pinned-models";
import { applyNativeUltraFastTier } from "../../src/codex/catalog/native-ultrafast";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../../src/codex/catalog/account-models";
import { buildCatalogEntriesFromObservedState } from "../../src/codex/catalog/build-entries";
import { validateDiscoveredNativeRows } from "../../src/codex/catalog/discovered-natives";
import { CODEX_CUSTOM_MODEL_CATALOG_KIND, type RawEntry } from "../../src/codex/catalog/parsing";
import {
  ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS, codexModelEntitlementStateForAccount,
  resetCodexModelEntitlementCacheForTests,
} from "../../src/codex/model-entitlements";
import { DEFAULT_SUBAGENT_MODELS, SUBAGENT_MODELS_VERSION } from "../../src/config/subagent-models";

const TERRA = "gpt-6.1-terra";
const LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];
afterEach(() => resetCodexModelEntitlementCacheForTests());

function builtTerra(modelWindows?: Record<string, number>): RawEntry | undefined {
  return buildCatalogEntriesFromObservedState({
    template: null, gptSlugs: [TERRA], goModels: [], wsEnabled: false,
    multiAgentMode: "default", multiAgentV2Enabled: false, exactComboSlugs: new Set(),
    accountSelectors: [], suppressedBareNativeSlugs: new Set(), disabledNativeAccountSlugs: new Set(),
    openaiContextCap: { modelWindows },
  }).find(row => row.slug === TERRA);
}

describe("GPT-6.1 Terra native catalog", () => {
  test("registers an ungated self-described flagship alongside GPT-5.6 Terra", () => {
    expect(NATIVE_OPENAI_MODELS).toContain(TERRA);
    expect(NATIVE_OPENAI_MODELS).toContain("gpt-5.6-terra");
    expect(SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has(TERRA)).toBe(true);
    expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(TERRA)).toBe(false);
    expect(NATIVE_MAIN_DRAIN_SENTINEL_MODELS.has(TERRA)).toBe(true);
    expect(DOCUMENTED_NATIVE_OPENAI_ADDITIONS).toContain(TERRA);
    expect(isEligibleConfiguredNativeOpenAiModel(TERRA)).toBe(false);
    // Like GPT-6.1 Sol, a roster that lags the release cannot shrink Terra's pool.
    expect(ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS.has(TERRA)).toBe(false);
    expect(ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS.has("gpt-6.1-sol")).toBe(false);
  });

  test("pins the upstream identity, client floor, native windows, v2 and Fast-only metadata", () => {
    const pins = pinnedNativeModelRows().filter(row => row.slug === TERRA);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      slug: TERRA, display_name: "GPT-6.1 Terra", priority: 7,
      context_window: 500_000, max_context_window: 872_000,
      minimal_client_version: pinnedNativeModelRows().find(row => row.slug === "gpt-6.1-sol")?.minimal_client_version,
      default_reasoning_level: "low", multi_agent_version: "v2",
      service_tiers: [{ id: "priority", name: "Fast" }], additional_speed_tiers: ["fast"],
    });
    expect(nativeReasoningEfforts(TERRA)).toEqual(LADDER);
    expect(nativeDefaultReasoningEffort(TERRA)).toBe("low");
    expect(nativeMultiAgentVersion(TERRA)).toBe("v2");
    expect(nativeInputModalities(TERRA)).toEqual(["text", "image"]);
    expect(NATIVE_OPENAI_CONTEXT_OVERRIDES[TERRA]?.maxInputTokens).toBe(872_000);
    expect(nativeOpenAiMaxInputTokens(TERRA)).toBe(500_000);
    expect(nativeOpenAiMaxInputTokens(TERRA, { modelWindows: { [TERRA]: 872_000 } })).toBe(872_000);
  });

  test("builds 500k default context with 450k compaction and retains the predecessor", () => {
    const rows = buildCatalogEntries(null, [TERRA, "gpt-5.6-terra"], []);
    expect(rows.find(row => row.slug === TERRA)).toMatchObject({
      display_name: "GPT-6.1 Terra", visibility: "list", context_window: 500_000,
      max_context_window: 872_000, auto_compact_token_limit: 450_000,
      default_reasoning_level: "low", multi_agent_version: "v2",
    });
    expect(rows.find(row => row.slug === "gpt-5.6-terra")).toBeDefined();
    expect(nativeOpenAiContextTier(TERRA)).toEqual({ defaultWindow: 500_000, longWindow: 872_000 });
  });

  test.each([872_000, 1_050_000])("long-window override %s clamps at the native ceiling", window => {
    expect(builtTerra({ [TERRA]: window })).toMatchObject({
      context_window: 872_000, max_context_window: 872_000, auto_compact_token_limit: 784_800,
    });
  });

  test("account-bound and canonical OpenAI-forward rows inherit Terra's own capabilities", () => {
    const rows = buildCatalogEntries(null, [TERRA], [{ provider: "openai", id: TERRA,
      codexForwardNativeCapabilityAlias: true, catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
      reasoningEfforts: nativeReasoningEfforts(TERRA), defaultReasoningEffort: nativeDefaultReasoningEffort(TERRA) }],
      undefined, false, "default", new Set(), ["personal"]);
    for (const [slug, maximum] of [[`personal/${TERRA}`, 872_000], [`openai/${TERRA}`, 500_000]]) {
      expect(rows.find(row => row.slug === slug)).toMatchObject({
        context_window: 500_000, max_context_window: maximum, auto_compact_token_limit: 450_000,
        default_reasoning_level: "low", multi_agent_version: "v2", input_modalities: ["text", "image"],
      });
    }
  });

  test.each([TERRA, `personal/${TERRA}`])("%s never gains Ultrafast even when enabled", slug => {
    const row: RawEntry = { ...structuredClone(upstreamNativeEntry(TERRA)), slug,
      ...(slug.includes("/") ? { opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND } : {}) };
    applyNativeUltraFastTier(row, true);
    expect(row.service_tiers).toEqual([{ id: "priority", name: "Fast", description: "1.5x speed" }]);
    expect(row.additional_speed_tiers).toEqual(["fast"]);
  });

  test("the native wire folds ultra to max and none to low", () => {
    expect(nativeEffortClamp(TERRA, "ultra")).toBe("max");
    expect(nativeEffortClamp(TERRA, "none")).toBe("low");
    expect(nativeEffortClamp(TERRA, "max")).toBeNull();
  });

  test.each([TERRA, "gpt-6.1-sol"])("%s roster evidence follows the same ungated rule", model => {
    for (const [models, expected] of [[[], "denied"], [[model], "granted"]] as const) {
      expect(codexModelEntitlementStateForAccount({
        modelsByAccount: new Map([["pool", new Set<string>(models)]]),
        clientVersionByAccount: new Map([["pool", "0.152.0"]]),
        confirmedAccountIds: new Set(["pool"]), credentialIdentities: new Map(),
      }, "pool", model)).toBe(expected);
    }
  });

  test("live discovery cannot replace Terra's pinned native context or ladder", () => {
    expect(validateDiscoveredNativeRows([{
      ...pinnedNativeModelRows().find(row => row.slug === TERRA),
      context_window: 1_050_000, max_context_window: 1_050_000,
    }])).toEqual([]);
    expect(nativeOpenAiContextTier(TERRA)).toEqual({ defaultWindow: 500_000, longWindow: 872_000 });
    expect(nativeReasoningEfforts(TERRA)).toEqual(LADDER);
  });

  test("keeps the Sol template and subagent defaults without a roster migration", () => {
    expect(CONFIGURED_NATIVE_OPENAI_TEMPLATE_MODEL).toBe("gpt-6.1-sol");
    expect(DEFAULT_SUBAGENT_MODELS).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
    expect(SUBAGENT_MODELS_VERSION).toBe(3);
  });
});
