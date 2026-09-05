import { describe, expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types";
import { isLoopbackHostname as isServerLoopbackHostname } from "../../src/server/auth-cors";
import {
  isEffectiveCodexDesktopAuthless,
  isLoopbackHostname,
  shouldInjectApiAuthHeader,
} from "../../src/codex/loopback-target";
import { NATIVE_RESERVE_MODEL } from "../../src/codex/catalog/native-models";
import {
  accountBoundNativeOpenAiSlugs,
  accountBoundNativeOpenAiSlugsBySelector,
  observedAccountBoundNativeEntries,
  observedReserveCatalogSource,
  upstreamNativeEntry,
} from "../../src/codex/catalog/metadata";
import {
  buildCatalogEntriesFromObservedState,
  finishUpstreamNativeEntry,
  mergeCatalogEntriesFromObservedState,
  type ObservedCatalogEntryBuildInput,
  type ObservedCatalogMergeInput,
} from "../../src/codex/catalog/sync";
import {
  createReserveCatalogProjection,
  isReserveCatalogProjection,
  RESERVE_METADATA_SOURCE_FIELD,
  RESERVE_LUNA_METADATA_SOURCE,
} from "../../src/codex/catalog/reserve";
import { findSupportedNativeTemplate, type RawEntry } from "../../src/codex/catalog/parsing";
import { clampCatalogModelsToObservedCodexSupport } from "../../src/codex/catalog/effort";

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexDesktopAuthless: true,
    codexAccountPickerEnabled: true,
    codexAccountNamespaces: { personal: "@main", second: "pool-account" },
    codexAccounts: [{ id: "pool-account", alias: "Second", addedAt: 0 }],
    ...overrides,
  } as OcxConfig;
}

function luna(): RawEntry {
  return finishUpstreamNativeEntry(upstreamNativeEntry(RESERVE_LUNA_METADATA_SOURCE)!, 9);
}

function actualReserve(overrides: RawEntry = {}): RawEntry {
  return {
    ...luna(),
    slug: NATIVE_RESERVE_MODEL,
    display_name: "Observed Reserve",
    supported_in_api: false,
    visibility: "hide",
    supported_reasoning_levels: [{ effort: "medium", description: "Observed effort" }],
    default_reasoning_level: "medium",
    comp_hash: null,
    available_in_plans: ["reserve"],
    upgrade: { model: "do-not-inherit" },
    availability_nux: { message: "do-not-inherit" },
    ...overrides,
  };
}

function build(
  state: OcxConfig = config(),
  observations: RawEntry[] = [],
  overrides: Partial<ObservedCatalogEntryBuildInput> = {},
): RawEntry[] {
  const mainSelectors = ["personal"];
  return buildCatalogEntriesFromObservedState({
    template: null,
    gptSlugs: [],
    goModels: [{ provider: "external", id: "model", owned_by: "external" }],
    wsEnabled: false,
    multiAgentMode: "default",
    exactComboSlugs: new Set(),
    accountSelectors: ["personal", "second"],
    accountNativeSlugsBySelector: new Map([["personal", []], ["second", []]]),
    suppressedBareNativeSlugs: new Set(),
    disabledNativeAccountSlugs: new Set(),
    multiAgentV2Enabled: false,
    reserve: createReserveCatalogProjection(
      state,
      mainSelectors,
      observedReserveCatalogSource(observations, mainSelectors),
      luna(),
    ),
    ...overrides,
  });
}

function merge(rows: RawEntry[], overrides: Partial<ObservedCatalogMergeInput> = {}): RawEntry[] {
  return mergeCatalogEntriesFromObservedState({
    catalogModels: [],
    baselineCatalogModels: [],
    routedEntries: rows.filter(row => !isReserveCatalogProjection(row)),
    accountBoundEntries: rows.filter(isReserveCatalogProjection),
    baseline: new Map(),
    featured: [],
    wsEnabled: false,
    template: null,
    disabledModels: new Set(),
    selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(["external"]),
    degradedProviderNames: new Set(),
    legacyCustomModelSlugs: new Set(),
    multiAgentMode: "default",
    multiAgentV2Enabled: false,
    exactComboSlugs: new Set(),
    hasPhysicalComboProvider: false,
    includeNativeOpenAi: true,
    policy: { nativeBackfillSlugs: [], unsupportedNativeEntries: "drop", warningPolicy: "suppress" },
    ...overrides,
  });
}

describe("Reserve effective authless configuration", () => {
  test.each([undefined, "", "localhost", " LOCALHOST ", "localhost.", " LOCALHOST. ", "127.0.0.1", "::1", "[::1]"])(
    "loopback %s admits only the explicit opt-in", hostname => {
      expect(isLoopbackHostname(hostname)).toBe(true);
      expect(isServerLoopbackHostname(hostname)).toBe(true);
      expect(shouldInjectApiAuthHeader({ hostname })).toBe(false);
      expect(isEffectiveCodexDesktopAuthless(config({ hostname }))).toBe(true);
      expect(isEffectiveCodexDesktopAuthless(config({ hostname, codexDesktopAuthless: false }))).toBe(false);
      expect(isEffectiveCodexDesktopAuthless(config({ hostname, codexDesktopAuthless: undefined }))).toBe(false);
    },
  );
  test.each(["localhost..", "0.0.0.0", "::", "[::]", "192.0.2.10", "proxy.example"])(
    "non-loopback %s keeps admission and hides Reserve", hostname => {
      const state = config({ hostname });
      expect(isLoopbackHostname(hostname)).toBe(false);
      expect(isServerLoopbackHostname(hostname)).toBe(false);
      expect(shouldInjectApiAuthHeader(state)).toBe(true);
      expect(isEffectiveCodexDesktopAuthless(state)).toBe(false);
      expect(build(state).map(row => row.slug)).toEqual(["external/model"]);
    },
  );
  test("dedicated loopback listener is effective, but a remote client is never effective", () => {
    const state = config({ hostname: "0.0.0.0", unauthenticatedLoopbackListener: { enabled: true, port: 10101 } });
    expect(isEffectiveCodexDesktopAuthless(state)).toBe(true);
    expect(isEffectiveCodexDesktopAuthless({ ...state, runtimeRole: "client" })).toBe(false);
    expect(isEffectiveCodexDesktopAuthless(undefined)).toBe(false);
    expect(build({ ...state, runtimeRole: "client" }).map(row => row.slug)).toEqual(["external/model"]);
  });
});

describe("Reserve catalog metadata is not permission", () => {
  test("offline inputs expose only the main selector and retain external models", () => {
    const first = build();
    expect(first.map(row => row.slug)).toEqual(["personal/gpt-reserve", "external/model"]);
    const reserve = first[0]!;
    expect(reserve[RESERVE_METADATA_SOURCE_FIELD]).toBe("gpt-5.6-luna");
    expect(reserve.supported_in_api).toBe(true);
    expect(reserve.available_in_plans).toBeUndefined();
    expect(reserve.supported_reasoning_levels).toEqual(luna().supported_reasoning_levels);
    expect(build()).toEqual(first);
    expect(build(config({ codexDesktopAuthless: false })).map(row => row.slug)).toEqual(["external/model"]);
    expect(createReserveCatalogProjection(config(), [], null, luna())).toBeUndefined();
  });

  test("a real hidden Reserve source wins without mutating its metadata", () => {
    const original = actualReserve();
    const before = structuredClone(original);
    const reserve = build(config(), [original])[0]!;
    expect(reserve[RESERVE_METADATA_SOURCE_FIELD]).toBe("gpt-reserve");
    expect(reserve.display_name).toBe("personal / Observed Reserve");
    expect(reserve.comp_hash).toBeNull();
    expect(reserve.supported_reasoning_levels).toEqual([{ effort: "medium", description: "Observed effort" }]);
    expect(reserve.available_in_plans).toBeUndefined();
    expect(reserve.upgrade).toBeUndefined();
    expect(reserve.availability_nux).toBeUndefined();
    expect(original).toEqual(before);
    expect(observedAccountBoundNativeEntries([original])).toEqual([original]);
    expect(findSupportedNativeTemplate({ models: [original] })).toBeNull();
  });

  test("adapted rows never become real observations or generic native exports", () => {
    const adapted = build()[0]!;
    const disguised = { ...adapted, slug: NATIVE_RESERVE_MODEL };
    expect(observedReserveCatalogSource([adapted, disguised], ["personal"])).toBeNull();
    expect(observedAccountBoundNativeEntries([disguised])).toEqual([]);
    const actual = actualReserve();
    expect(accountBoundNativeOpenAiSlugs([actual])).not.toContain(NATIVE_RESERVE_MODEL);
    for (const slugs of accountBoundNativeOpenAiSlugsBySelector(config(), [actual]).values()) {
      expect(slugs).not.toContain(NATIVE_RESERVE_MODEL);
    }
    expect(observedReserveCatalogSource([{ slug: NATIVE_RESERVE_MODEL, supported_in_api: false }], ["personal"])).toBeNull();
  });

  test("observed source overrides a previous adaptation, without copying another selector", () => {
    const adapted = merge(build());
    const original = actualReserve({ display_name: "Fresh Reserve" });
    const next = build(config(), [...adapted, original]);
    expect(next.find(isReserveCatalogProjection)?.display_name).toBe("personal / Fresh Reserve");
    expect(next.find(isReserveCatalogProjection)?.[RESERVE_METADATA_SOURCE_FIELD]).toBe("gpt-reserve");
    const qualified = next.find(isReserveCatalogProjection)!;
    expect(observedReserveCatalogSource([qualified], ["renamed"])).toBeNull();
    const direct = build(config(), [original], { disabledNativeAccountSlugs: new Set(["personal/gpt-reserve"]) });
    expect(direct.map(row => row.slug)).toEqual(["external/model"]);
  });

  test("merge retains the actual source and never widens its reasoning or compression metadata", () => {
    const rows = build(config(), [actualReserve()]);
    const result = merge(rows, { catalogModels: [actualReserve({ supported_reasoning_levels: [{ effort: "ultra" }] })] });
    const reserve = result.find(isReserveCatalogProjection)!;
    expect(reserve.comp_hash).toBeNull();
    expect(reserve.supported_reasoning_levels).toEqual([{ effort: "medium", description: "Observed effort" }]);
    expect(reserve[RESERVE_METADATA_SOURCE_FIELD]).toBe("gpt-reserve");
    expect(merge(build(config(), result), { catalogModels: result })).toEqual(result);
  });

  test("repeated adaptation remains deterministic and disabling removes only the choice", () => {
    const first = merge(build());
    expect(merge(build(config(), first), { catalogModels: first })).toEqual(first);
    const off = merge(build(config({ codexDesktopAuthless: false })), { catalogModels: first });
    expect(off.map(row => row.slug)).toEqual(["external/model"]);
    for (const disabled of ["personal/gpt-reserve", "gpt-reserve"]) {
      const result = merge(build(), { disabledModels: new Set([disabled]) });
      expect(result.find(isReserveCatalogProjection)?.visibility).toBe("hide");
      expect(result.find(row => row.slug === "external/model")?.visibility).toBe("list");
    }
  });

  test("default multi-agent mode preserves the selected source; explicit overrides still apply", () => {
    expect(merge(build()).find(isReserveCatalogProjection)?.multi_agent_version).toBe("v1");
    const disabled = actualReserve({ multi_agent_version: "disabled" });
    const rows = build(config(), [disabled], { multiAgentV2Enabled: true });
    expect(rows.find(isReserveCatalogProjection)?.multi_agent_version).toBe("disabled");
    expect(merge(rows, { multiAgentV2Enabled: true }).find(isReserveCatalogProjection)?.multi_agent_version).toBe("disabled");
    for (const mode of ["v1", "v2"] as const) {
      const explicit = build(config(), [disabled], { multiAgentMode: mode });
      expect(merge(explicit, { multiAgentMode: mode }).find(isReserveCatalogProjection)?.multi_agent_version).toBe(mode);
    }
  });

  test("final clamp omits incompatible Reserve in-place without inventing efforts", () => {
    const rows = merge(build(config(), [actualReserve({
      supported_reasoning_levels: [{ effort: "xhigh", description: "Only xhigh" }],
      default_reasoning_level: "xhigh",
    })]));
    const before = [...rows];
    const diagnostic = clampCatalogModelsToObservedCodexSupport(rows, new Set(["medium"]));
    expect(rows).not.toEqual(before);
    expect(rows.map(row => row.slug)).toEqual(["external/model"]);
    expect(diagnostic.affectedModels).toContain("personal/gpt-reserve");
    expect(diagnostic.removedEfforts).toContain("xhigh");
  });

  test("partial effort intersection keeps only source efforts and a surviving default", () => {
    const rows = merge(build(config(), [actualReserve({
      supported_reasoning_levels: [
        { effort: "low", description: "Source low" },
        { effort: "high", description: "Source high" },
      ],
      // Supported by the runtime but not by this source's actual ladder.
      default_reasoning_level: "medium",
    })]));
    clampCatalogModelsToObservedCodexSupport(rows, new Set(["medium", "high"]));
    expect(rows.find(isReserveCatalogProjection)).toMatchObject({
      supported_reasoning_levels: [{ effort: "high", description: "Source high" }],
      default_reasoning_level: "high",
    });
  });
});
