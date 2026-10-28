import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints, catalogHintsFromModelsApiItem } from "../../src/codex/catalog/provider-fetch";
import { deriveEntry } from "../../src/codex/catalog/sync";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxProviderConfig } from "../../src/types";

/**
 * Regression coverage for the Grok CLI subscription lane (cli-chat-proxy.grok.com).
 *
 * That lane's `/v1/models` reports the DEFAULT rung of a selectable context ladder in
 * `context_window` and the whole ladder in `context_windows`. PR #7701 reports that on 2026-10-24 all
 * four rows (grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5) read:
 *
 *   `context_window: 256000, context_windows: [256000, 500000]`
 *
 * Reading only `context_window` published 256k for models the registry already carries at
 * 500k, and it could not be corrected from configuration: `clampObservedModelLimits` lets a
 * configured window LOWER the observed one and never raise it. Independent subscription-lane
 * overflow probes confirm a 500k ceiling for Grok 4.7 and build-fast in
 * devlog/_fin/260930_grok47_build_unify/010_probe-evidence.md. This is a catalog fixture,
 * not a fresh entitlement or successful long-input inference probe for every model/account.
 */

const GROK_LANE_ITEM = {
  id: "grok-4.7",
  object: "model",
  owned_by: "xAI",
  model: "grok-4.7",
  model_family: "xai",
  context_window: 256000,
  context_windows: [256000, 500000],
  auto_compact_threshold_percent: 80,
  api_backend: "responses",
};

describe("models-API context ladder", () => {
  test("a published ladder outranks the default rung beside it", () => {
    const hints = catalogHintsFromModelsApiItem("xai", GROK_LANE_ITEM);
    expect(hints.contextWindow).toBe(500000);
  });

  test("every rung is read, in any order, and the widest wins", () => {
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: [500000, 256000],
    }).contextWindow).toBe(500000);
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: [256000, 400000, 500000],
    }).contextWindow).toBe(500000);
  });

  test("a lane that publishes no ladder is unchanged", () => {
    const { context_windows: _ladder, ...withoutLadder } = GROK_LANE_ITEM;
    expect(catalogHintsFromModelsApiItem("xai", withoutLadder).contextWindow).toBe(256000);
  });

  test("the ladder does not outrank a recognized capability or metadata field", () => {
    // Precedence is unchanged for every field that already resolved a window: the ladder only
    // fills the slot the default rung used to fill.
    expect(catalogHintsFromModelsApiItem("hub", {
      id: "hub-row",
      capabilities: { context_length: 922000 },
      context_window: 256000,
      context_windows: [256000, 500000],
    }).contextWindow).toBe(922000);
    expect(catalogHintsFromModelsApiItem("zed", {
      id: "zed-row",
      context_length: 32768,
      context_window: 256000,
      context_windows: [256000, 500000],
    }).contextWindow).toBe(32768);
  });

  test("invalid rungs are ignored, and a ladder with none falls back to the default rung", () => {
    for (const context_windows of [
      [0, -1, 1.5, "500000", Number.MAX_SAFE_INTEGER + 1],
      [],
      "500000",
      null,
      { 0: 500000 },
    ]) {
      expect(catalogHintsFromModelsApiItem("xai", {
        ...GROK_LANE_ITEM, context_windows,
      }).contextWindow).toBe(256000);
    }
  });

  test("valid rungs survive malformed neighbors", () => {
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: [null, NaN, Infinity, "500000", 0, 500000, -1, 1.5],
    }).contextWindow).toBe(500000);
  });

  for (const id of ["grok-4.5", "grok-4.6", "grok-4.7", "grok-4.7-build-fast"]) {
    test(`${id} publishes the widest rung through config projection and Codex serialization`, () => {
      const registry = getProviderRegistryEntry("xai")!;
      const provider: OcxProviderConfig = { ...registry, authMode: "oauth" };
      const hints = catalogHintsFromModelsApiItem("xai", { ...GROK_LANE_ITEM, id });
      const model = applyProviderConfigHints("xai", provider, { provider: "xai", id, ...hints });
      expect(model.contextWindow).toBe(500000);
      expect(model.reasoningEfforts).toEqual(id === "grok-4.5"
        ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"]);
      expect(model.supportsFlexTier).toBe(false);
      const entry = deriveEntry(null, `xai/${id}`, "Grok", 1, model);
      expect(entry.context_window).toBe(500000);
      expect(entry.max_context_window).toBe(500000);
      expect(entry.opencodex_capability_provenance.context_window).toBe(500000);
      expect(entry.service_tiers?.some((tier: { id: string }) => tier.id === "flex") ?? false).toBe(false);
    });
  }

  test("configured windows and Context caps still lower the widest observed rung", () => {
    const id = GROK_LANE_ITEM.id;
    const provider: OcxProviderConfig = { ...getProviderRegistryEntry("xai")!, authMode: "oauth" };
    const model = { provider: "xai", id, ...catalogHintsFromModelsApiItem("xai", GROK_LANE_ITEM) };
    const lower = applyProviderConfigHints("xai", {
      ...provider, modelContextWindows: { [id]: 300000 }, modelMaxInputTokens: { [id]: 450000 },
    }, model);
    expect(lower.contextWindow).toBe(300000);
    expect(lower.maxInputTokens).toBe(300000);
    const capped = applyProviderConfigHints("xai", provider, model, 200000);
    expect(capped.contextWindow).toBe(200000);
    expect(capped.contextCapped).toBe(true);
    expect(applyProviderConfigHints("xai", {
      ...provider, modelContextWindows: { [id]: 900000 },
    }, model).contextWindow).toBe(500000);
  });

  for (const { label, authMode, item, overrides, window, compact } of [
    { label: "provider-wide limit", authMode: "oauth", item: GROK_LANE_ITEM,
      overrides: { contextWindow: 300000 }, window: 300000, compact: 270000 },
    { label: "partial model map", authMode: "oauth", item: GROK_LANE_ITEM,
      overrides: { contextWindow: 300000, modelContextWindows: { "grok-4.6": 200000 } }, window: 300000, compact: 270000 },
    { label: "higher explicit model limit", authMode: "oauth", item: GROK_LANE_ITEM,
      overrides: { contextWindow: 300000, modelContextWindows: { "grok-4.7": 400000 } }, window: 400000, compact: 360000 },
    { label: "lower explicit model limit", authMode: "oauth", item: GROK_LANE_ITEM,
      overrides: { contextWindow: 300000, modelContextWindows: { "grok-4.7": 200000 } }, window: 200000, compact: 180000 },
    { label: "case-varied explicit model limit", authMode: "oauth", item: GROK_LANE_ITEM,
      overrides: { contextWindow: 300000, modelContextWindows: { "GROK-4.7": 200000 } }, window: 200000, compact: 180000 },
    { label: "unconfigured OAuth ladder", authMode: "oauth", item: GROK_LANE_ITEM,
      overrides: {}, window: 500000, compact: 450000 },
    { label: "key-auth observed limit", authMode: "key", item: { id: "grok-4.7", context_window: 256000 },
      overrides: { contextWindow: 300000 }, window: 256000, compact: 230400 },
    { label: "key-auth smaller model limit", authMode: "key", item: { id: "grok-4.3", context_window: 131072 },
      overrides: { contextWindow: 300000 }, window: 131072, compact: 117964 },
  ] satisfies { label: string; authMode: "oauth" | "key"; item: typeof GROK_LANE_ITEM | { id: string; context_window: number };
    overrides: Partial<OcxProviderConfig>; window: number; compact: number }[]) {
    test(`capture preserves ${label} through hints and serialization`, () => {
      const registry = getProviderRegistryEntry("xai")!;
      const configured: OcxProviderConfig = {
        adapter: registry.adapter, baseUrl: registry.baseUrl, authMode, ...overrides,
      };
      const original = structuredClone(configured);
      const captured = captureProviderGather("xai", configured, {
        kind: "observed", resolve: () => ({ apiKey: "fixture-token", observed: true }),
      });
      const model = applyProviderConfigHints("xai", captured.provider, {
        provider: "xai", id: item.id, ...catalogHintsFromModelsApiItem("xai", item),
      });
      const entry = deriveEntry(null, `xai/${item.id}`, "Grok", 1, model);
      expect(entry).toMatchObject({
        context_window: window, max_context_window: window, auto_compact_token_limit: compact,
        opencodex_capability_provenance: { context_window: window },
      });
      expect(configured).toEqual(original);
      expect(Object.isFrozen(captured.provider)).toBe(true);
    });
  }

  test("capture preserves a case-varied explicit output limit beneath registry enrichment", () => {
    const registry = getProviderRegistryEntry("xai")!;
    const captured = captureProviderGather("xai", {
      adapter: registry.adapter, baseUrl: registry.baseUrl, authMode: "oauth",
      modelMaxOutputTokens: { "GROK-4.7": 12345 },
    }, { kind: "observed", resolve: () => ({ apiKey: "fixture-token", observed: true }) });
    const model = applyProviderConfigHints("xai", captured.provider, {
      provider: "xai", id: GROK_LANE_ITEM.id, ...catalogHintsFromModelsApiItem("xai", GROK_LANE_ITEM),
    });
    expect(model.maxOutputTokens).toBe(12345);
    expect(captured.provider.modelMaxOutputTokens).not.toHaveProperty("grok-4.7");
  });

  test("inspection is bounded, so an oversized ladder cannot pad the read", () => {
    const padded = [...Array.from({ length: 8 }, () => 256000), 500000];
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: padded,
    }).contextWindow).toBe(256000);
    expect(catalogHintsFromModelsApiItem("xai", {
      ...GROK_LANE_ITEM, context_windows: [500000, ...Array.from({ length: 8 }, () => 256000)],
    }).contextWindow).toBe(500000);
  });
});
