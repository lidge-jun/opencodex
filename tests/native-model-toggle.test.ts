import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  accountBoundNativeOpenAiSlugs,
  accountBoundNativeDisplayName,
  accountBoundNativeModelSlugs,
  applyNativeVisibility,
  buildCatalogEntries,
  CODEX_ACCOUNT_BOUND_CATALOG_KIND,
  desktopAllowlistSuppressedNativeSlugs,
  disabledNativeSlugs,
  mergeCatalogEntriesForSync,
  NATIVE_OPENAI_MODELS,
  nativeContextLimits,
  nativeModelRows,
  observedAccountBoundNativeEntries,
  observedAccountBoundNativeOpenAiSlugs,
  shouldIncludeAccountBoundNativeOpenAi,
  shouldIncludeNativeOpenAi,
  trustedAccountBoundNativeCatalogSlug,
  visibleCodexAccountSelectors,
  visibleNativeSlugs,
} from "../src/codex/catalog";
import { handleManagementAPI } from "../src/server/management-api";
import { applyMultiAgentMode, applyNativeOpenAiContextOverride } from "../src/codex/catalog/parsing";
import { NATIVE_GPT56_CONTEXT_WINDOW, NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW, nativeOpenAiContextWindow } from "../src/codex/catalog";
import type { OcxConfig } from "../src/types";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../src/codex/catalog/native-models";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../src/codex/model-entitlements";

afterEach(() => resetCodexModelEntitlementCacheForTests());

// Most of this file exercises visibility/window mechanics on Sol/Terra/Luna rows. They are
// account-gated now, so give them a confirmed main roster up front; the two gating-specific
// tests below reset the cache to assert the unconfirmed baseline first.
beforeEach(() => {
  seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
});

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...overrides } as OcxConfig;
}

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "high", description: "native high" },
    ],
    shell_type: "shell_command",
    comp_hash: "native-comp-hash",
  };
}

describe("native GPT model toggles (bare slugs in disabledModels)", () => {
  test("disabledNativeSlugs picks bare ids only; routed namespaced ids are ignored", () => {
    const set = disabledNativeSlugs({ disabledModels: ["gpt-5.4", "kiro/claude-opus-4.6", "gpt-5.6-luna"] });
    expect([...set].sort()).toEqual(["gpt-5.4", "gpt-5.6-luna"]);
  });

  test("visibleNativeSlugs omits disabled natives from the bare availability list", () => {
    const all = visibleNativeSlugs({ disabledModels: [] });
    // Use gpt-5.6-sol: guaranteed present (documented native addition, always in the list
    // regardless of whether a live catalog exists — CI has no catalog file).
    const filtered = visibleNativeSlugs({ disabledModels: ["gpt-5.6-sol", "cursor/gpt-5.4"] });
    expect(all).toContain("gpt-5.6-sol");
    expect(filtered).not.toContain("gpt-5.6-sol");
    // Routed blocklist entries never affect the native list.
    expect(filtered.length).toBe(all.length - 1);
  });

  test("nativeModelRows hides account-gated ids until an authenticated roster confirms them", () => {
    resetCodexModelEntitlementCacheForTests();
    const rows = nativeModelRows({ disabledModels: ["gpt-5.6-sol"] });
    expect(rows.map(r => r.slug)).toEqual(
      NATIVE_OPENAI_MODELS.filter(slug => !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)),
    );

    seedCodexModelEntitlementsForTests(
      "main",
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-daybreak-blue-latest"],
    );
    const confirmed = nativeModelRows({ disabledModels: ["gpt-5.6-sol"] });
    expect(confirmed.map(r => r.slug)).toEqual(NATIVE_OPENAI_MODELS);
    expect(confirmed.find(r => r.slug === "gpt-5.6-sol")?.disabled).toBe(true);
    expect(confirmed.find(r => r.slug === "gpt-5.5")?.disabled).toBe(false);
    // Known context metadata rides along for the dashboard.
    expect(confirmed.find(r => r.slug === "gpt-5.6-sol")?.contextWindow).toBe(272_000);

    expect(nativeModelRows({ disabledModels: [] }).map(row => row.slug))
      .toContain("gpt-daybreak-blue-latest");
  });

  test("Direct bare rows use only main entitlement while Pool may use any eligible account", () => {
    seedCodexModelEntitlementsForTests("pool-a", ["gpt-daybreak-blue-latest"]);
    const direct = makeConfig({
      providers: { openai: { authMode: "forward", codexAccountMode: "direct" } },
    });
    const pool = makeConfig({
      providers: { openai: { authMode: "forward", codexAccountMode: "pool" } },
    });

    expect(nativeModelRows(direct).map(row => row.slug)).not.toContain("gpt-daybreak-blue-latest");
    expect(nativeModelRows(pool).map(row => row.slug)).toContain("gpt-daybreak-blue-latest");
  });

  test("a per-model window sets the native row and never exceeds the measured ceiling", () => {
    // The lever the dashboard's context button writes. It reaches the same accessors the cap
    // does, so /api/models and the on-disk catalog cannot disagree about the same slug.
    const overlay = { providers: { openai: { modelContextWindows: { "gpt-5.6-sol": 500_000 } } } } as never;
    const rows = nativeModelRows(overlay);
    expect(rows.find(r => r.slug === "gpt-5.6-sol")?.contextWindow).toBe(500_000);
    // The input ceiling follows the narrowed window — advertising 922k input under a 500k
    // window would be the same over-advertising this unit exists to fix.
    expect(rows.find(r => r.slug === "gpt-5.6-sol")?.maxInputTokens).toBe(500_000);
    // A sibling slug is untouched: this lever is per-model.
    expect(rows.find(r => r.slug === "gpt-5.6-terra")?.contextWindow).toBe(272_000);

    // Above the measured ceiling the overlay is inert. A user value must never widen what the
    // upstream actually accepts.
    const tooWide = { providers: { openai: { modelContextWindows: { "gpt-5.6-sol": 2_000_000 } } } } as never;
    expect(nativeModelRows(tooWide).find(r => r.slug === "gpt-5.6-sol")?.contextWindow).toBe(922_000);

    // provider-wide window applies to every native slug, and the cap still wins when lower.
    const both = {
      providers: { openai: { contextWindow: 500_000 } },
      providerContextCaps: { openai: 350_000 },
    } as never;
    expect(nativeModelRows(both).find(r => r.slug === "gpt-5.6-sol")?.contextWindow).toBe(350_000);
  });

  test("a per-model soft budget lowers compaction without changing native hard limits", () => {
    const configured = {
      providers: { openai: { modelAutoCompactTokenLimits: { "gpt-5.6-sol": 120_000 } } },
    } as never;
    const row = nativeModelRows(configured).find(item => item.slug === "gpt-5.6-sol");
    expect(row).toMatchObject({
      contextWindow: 272_000,
      maxInputTokens: 272_000,
      autoCompactTokenLimit: 120_000,
    });

    const oversized = {
      providers: { openai: { modelAutoCompactTokenLimits: { "gpt-5.6-sol": 2_000_000 } } },
    } as never;
    expect(nativeModelRows(oversized).find(item => item.slug === "gpt-5.6-sol"))
      .toMatchObject({ contextWindow: 272_000, maxInputTokens: 272_000, autoCompactTokenLimit: 244_800 });
  });

  test("the on-disk catalog entry lands at the same width as the dashboard row", () => {
    // Regression: applyNativeOpenAiContextOverride used to re-read the static table and apply
    // only the cap, so a saved per-model window showed up in /api/models and was written back
    // at 922,000 in the Codex catalog.
    const limits = { providers: { openai: {
      modelContextWindows: { "gpt-5.6-sol": 500_000 },
      modelAutoCompactTokenLimits: { "gpt-5.6-sol": 120_000 },
    } } } as never;
    const entry: Record<string, unknown> = { slug: "gpt-5.6-sol", context_window: 922_000, max_context_window: 922_000 };
    applyNativeOpenAiContextOverride(entry as never, nativeContextLimits(limits));
    expect(entry.context_window).toBe(500_000);
    expect(entry.max_context_window).toBe(500_000);
    expect(entry.auto_compact_token_limit).toBe(120_000);
  });

  test("the on-disk catalog preserves a lower retained native compaction threshold", () => {
    const retained = {
      slug: "gpt-5.4-mini",
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 100_000,
    };
    applyNativeOpenAiContextOverride(retained as never, nativeContextLimits({}));
    expect(retained.auto_compact_token_limit).toBe(100_000);

    const configured = {
      providers: { openai: { modelAutoCompactTokenLimits: { "gpt-5.4-mini": 80_000 } } },
    } as never;
    const lowered = { ...retained };
    applyNativeOpenAiContextOverride(lowered as never, nativeContextLimits(configured));
    expect(lowered.auto_compact_token_limit).toBe(80_000);
  });

  test("the advertised native window stays inside the measured ceiling after Codex spends 95% of it", () => {
    // The regression this pins: Codex does not treat context_window as a label, it spends
    // context_window * effective_context_window_percent (95% by default, codex-rs
    // turn_context.rs). Shipping 1,050,000 here meant a 997,500-token budget against a
    // ceiling measured at 922,000 — the client filled past what the upstream accepts.
    const CODEX_EFFECTIVE_PERCENT = 0.95;
    const MEASURED_CEILING = 922_000; // 921,508 accepted / 922,013 refused, 2026-08-17
    const rows = nativeModelRows({});
    const gpt56 = rows.filter(row => row.slug.startsWith("gpt-5.6-") || row.slug.includes("daybreak"));
    expect(gpt56.length).toBeGreaterThan(0);
    for (const row of gpt56) {
      const budget = Math.floor(row.contextWindow! * CODEX_EFFECTIVE_PERCENT);
      expect(budget).toBeLessThanOrEqual(MEASURED_CEILING);
    }
    // And the window is a cap held under the ceiling, not back-solved to sit right on it:
    // 970,000 would pass the check above (921,500) while leaving no room at all.
    expect(rows.find(row => row.slug === "gpt-5.6-sol")?.contextWindow).toBe(272_000);
  });

  test("the native /api/models rows carry the input ceiling, not just the window", async () => {
    // 1,050,000 is the window; 922,000 is the largest input the upstream accepts. A row that
    // reports only the window tells the dashboard the whole thing is usable as input.
    const rows = nativeModelRows({});
    const sol = rows.find(row => row.slug === "gpt-5.6-sol");
    expect(sol?.contextWindow).toBe(272_000);
    expect(sol?.maxInputTokens).toBe(272_000);
    // A cap lowers both numbers together — an input ceiling above the capped window would
    // be nonsense.
    const capped = nativeModelRows({ providerContextCaps: { openai: 272_000 } });
    const cappedSol = capped.find(row => row.slug === "gpt-5.6-sol");
    expect(cappedSol?.contextWindow).toBe(272_000);
    expect(cappedSol?.maxInputTokens).toBe(272_000);
    // A native model with no separate ceiling keeps reporting just its window.
    const gpt55 = rows.find(row => row.slug === "gpt-5.5");
    expect(gpt55?.contextWindow).toBe(272_000);
    expect(gpt55?.maxInputTokens).toBeUndefined();
  });

  test("the native 1M switch raises the Codex 272k default up to the measured ceiling", () => {
    const raised = nativeModelRows({ providerContextCaps: { openai: 922_000 } });
    expect(raised.find(r => r.slug === "gpt-5.6-sol")).toMatchObject({
      contextWindow: 922_000,
      maxInputTokens: 922_000,
    });
    expect(raised.find(r => r.slug === "gpt-5.6-luna")?.contextWindow).toBe(922_000);
    // A value above the ceiling clamps; gpt-5.5 cannot be invented wider.
    const over = nativeModelRows({ providerContextCaps: { openai: 2_000_000 } });
    expect(over.find(r => r.slug === "gpt-5.6-sol")?.contextWindow).toBe(922_000);
    expect(raised.find(r => r.slug === "gpt-5.5")?.contextWindow).toBe(272_000);
    expect(raised.find(r => r.slug === "gpt-5.4")?.contextWindow).toBe(1_000_000);
  });

  test("nativeModelRows applies providerContextCaps.openai as a ceiling (#1430)", () => {
    const rows = nativeModelRows({
      disabledModels: [],
      providerContextCaps: { openai: 272_000 },
    });
    expect(rows.find(r => r.slug === "gpt-5.6-sol")?.contextWindow).toBe(272_000);
    expect(rows.find(r => r.slug === "gpt-5.6-luna")?.contextWindow).toBe(272_000);
    // gpt-5.5 (272k native) is unchanged by the same cap.
    expect(rows.find(r => r.slug === "gpt-5.5")?.contextWindow).toBe(272_000);
    // A cap for another provider leaves natives untouched.
    const other = nativeModelRows({ providerContextCaps: { "openai-apikey": 128_000 } });
    expect(other.find(r => r.slug === "gpt-5.6-sol")?.contextWindow).toBe(272_000);
  });

  test("native aliases suppress their native dashboard row and activate Desktop allowlist pruning", () => {
    const config = makeConfig({
      disabledModels: ["gpt-5.6-sol", "gpt-5.5"],
      combos: {
        nova: {
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Nova1 - Sol",
          targets: [{ provider: "nova", model: "codex/gpt-5.6-sol" }],
        },
      },
    });
    const rows = nativeModelRows(config);
    expect(rows.some(row => row.slug === "gpt-5.6-sol")).toBe(false);
    expect(rows.find(row => row.slug === "gpt-5.5")?.disabled).toBe(true);
    expect(desktopAllowlistSuppressedNativeSlugs(config))
      .toEqual(new Set(["gpt-5.6-sol", "gpt-5.5"]));
    expect(desktopAllowlistSuppressedNativeSlugs(makeConfig({
      disabledModels: ["gpt-5.5"],
    }))).toEqual(new Set());
  });

  test("configured public selectors replace bare picker rows with account-qualified native clones", () => {
    const template = nativeTemplate();
    template.comp_hash = "native-compaction-hash";
    const entries = buildCatalogEntries(
      template,
      ["gpt-5.5"],
      [{ provider: "litellm-local", id: "qwen3.6" }],
      ["gpt-5.5"],
      false,
      "default",
      new Set(),
      ["main-account", "side.account"],
    );
    applyNativeVisibility(entries, new Set(), true);

    const bare = entries.find(entry => entry.slug === "gpt-5.5");
    const main = entries.find(entry => entry.slug === "main-account/gpt-5.5");
    const side = entries.find(entry => entry.slug === "side.account/gpt-5.5");
    const routed = entries.find(entry => entry.slug === "litellm-local/qwen3.6");
    expect(bare?.visibility).toBe("hide");
    expect(main).toMatchObject({
      display_name: "main-account / 5.5",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      comp_hash: "native-compaction-hash",
      visibility: "list",
      priority: 0,
    });
    expect(main?.description).toBe(bare?.description);
    expect(side?.display_name).toBe("side.account / 5.5");
    expect(side?.priority).toBe(1);
    expect(side?.model_messages).toEqual(bare?.model_messages);
    expect(routed?.priority).toBeGreaterThan(side?.priority as number);
    expect(entries.every(entry => Number.isInteger(entry.priority))).toBe(true);
  });

  // gpt-daybreak-blue-latest is now a GLOBALLY allowlisted native (owner decision, devlog
  // 260816_.../011), so it is no longer an "unknown observed id" and cannot stand in for one
  // here. gpt-future-unlisted plays that role instead; the invariant under test is unchanged.
  test("observed account-only native ids stay qualified and do not expand the bare set", () => {
    const observedEntries = [
      { ...nativeTemplate(), slug: "gpt-future-unlisted", visibility: "list", supported_in_api: true },
      { ...nativeTemplate(), slug: "gpt-hidden-future", visibility: "hide", supported_in_api: true },
      { ...nativeTemplate(), slug: "gpt-not-an-api-model", visibility: "list", supported_in_api: false },
      { ...nativeTemplate(), slug: "provider/gpt-future-unlisted", visibility: "list", supported_in_api: true },
    ];
    expect(accountBoundNativeOpenAiSlugs(observedEntries)).toContain("gpt-future-unlisted");
    expect(accountBoundNativeOpenAiSlugs(observedEntries)).not.toContain("gpt-hidden-future");
    expect(accountBoundNativeOpenAiSlugs(observedEntries)).not.toContain("gpt-not-an-api-model");

    const entries = buildCatalogEntries(
      nativeTemplate(),
      ["gpt-5.5"],
      [],
      [],
      false,
      "default",
      new Set(),
      ["team"],
      new Set(),
      new Set(),
      undefined,
      accountBoundNativeOpenAiSlugs(observedEntries),
    );
    expect(entries.find(entry => entry.slug === "gpt-future-unlisted")).toBeUndefined();
    expect(entries.find(entry => entry.slug === "team/gpt-future-unlisted")).toMatchObject({
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      visibility: "list",
    });

    expect(observedAccountBoundNativeEntries([{
      ...nativeTemplate(),
      slug: "gpt-future-unlisted",
      visibility: "hide",
      supported_in_api: true,
      opencodex_account_observed_native: true,
    }])).toHaveLength(1);
    expect(observedAccountBoundNativeOpenAiSlugs(observedEntries)).toEqual(["gpt-future-unlisted"]);
  });

  test("gpt-daybreak-blue-latest has one native capability template when selected for emission", () => {
    const entries = buildCatalogEntries(
      nativeTemplate(),
      [...NATIVE_OPENAI_MODELS],
      [],
      [],
      false,
      "default",
      new Set(),
      [],
      new Set(),
      new Set(),
    );
    const bare = entries.filter(entry => entry.slug === "gpt-daybreak-blue-latest");
    // Exactly one row: entitlement decides whether the caller passes this slug into the builder;
    // once selected, its overlap with the capability-alias list must not duplicate it.
    expect(bare).toHaveLength(1);
    // Capability is inherited from gpt-5.6-sol, so it is a recursive-capable v2 delegate.
    expect(bare[0]?.multi_agent_version).toBe("v2");
  });

  test("a minimal hand-edited cache row is ignored", () => {
    const handEdited = [{ slug: "gpt-future-unlisted", visibility: "list", supported_in_api: true }];
    expect(accountBoundNativeOpenAiSlugs(handEdited)).not.toContain("gpt-future-unlisted");
    expect(observedAccountBoundNativeEntries(handEdited)).toEqual([]);
  });

  // The shape check is NOT a trust control, and this pins that so the next reader does not
  // assume it is one. `models_cache.json` is a user-owned file with no signature or source
  // identity to verify, so a complete hand-written row is indistinguishable from a real
  // observation and is accepted. That is acceptable here only because it grants nothing new:
  // `router.ts` already routes any bare `gpt-*` id under an account selector regardless of the
  // catalog, so the effect is advertisement in discovery, not a newly reachable route. If this
  // test ever needs to flip to rejection, the fix is a real provenance signal, not a longer
  // list of fields to match.
  test("full-shape unified_exec and legacy shell_command rows are accepted", () => {
    const forged = (shell_type: string) => [{
      slug: "gpt-not-a-real-model",
      visibility: "list",
      supported_in_api: true,
      base_instructions: "anything non-empty",
      comp_hash: null,
      shell_type,
      supported_reasoning_levels: [{ effort: "high" }],
      model_messages: {},
    }];

    expect(accountBoundNativeOpenAiSlugs(forged("unified_exec"))).toContain("gpt-not-a-real-model");
    expect(accountBoundNativeOpenAiSlugs(forged("shell_command"))).toContain("gpt-not-a-real-model");
  });

  test("exact account disables hide only the matching generated picker row", () => {
    const entries = buildCatalogEntries(
      nativeTemplate(),
      ["gpt-5.5"],
      [],
      [],
      false,
      "default",
      new Set(),
      ["desktop", "team"],
    );
    applyNativeVisibility(entries, new Set(["team/gpt-5.5"]), true);

    expect(entries.find(entry => entry.slug === "gpt-5.5")?.visibility).toBe("hide");
    expect(entries.find(entry => entry.slug === "desktop/gpt-5.5")?.visibility).toBe("list");
    expect(entries.find(entry => entry.slug === "team/gpt-5.5")?.visibility).toBe("hide");

    const untrusted = [{ slug: "team/gpt-5.5", visibility: "list" }];
    applyNativeVisibility(untrusted, new Set(["team/gpt-5.5"]), true);
    expect(untrusted[0]?.visibility).toBe("list");
  });

  test("featured routed rows follow complete account-qualified priority groups", () => {
    const entries = buildCatalogEntries(
      nativeTemplate(),
      ["gpt-5.5"],
      [{ provider: "vendor", id: "model" }],
      ["gpt-5.5", "vendor/model"],
      false,
      "default",
      new Set(),
      ["one", "two", "three"],
    );
    applyNativeVisibility(entries, new Set(), true);

    const visible = entries
      .filter(entry => entry.visibility === "list")
      .sort((left, right) => Number(left.priority) - Number(right.priority));
    expect(visible.slice(0, 4).map(entry => entry.slug)).toEqual([
      "one/gpt-5.5",
      "two/gpt-5.5",
      "three/gpt-5.5",
      "vendor/model",
    ]);
    expect(visible.slice(0, 4).map(entry => entry.priority)).toEqual([0, 1, 2, 3]);
  });

  test("generated-row ownership uses only the nonsemantic marker and qualified slug shape", () => {
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "side/gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBe("gpt-5.6-sol");
    expect(trustedAccountBoundNativeCatalogSlug({ slug: "side/gpt-5.6-sol" })).toBeUndefined();
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "/gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBeUndefined();
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "side/",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBeUndefined();
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBeUndefined();
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "side/nested/gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBeUndefined();
  });

  test("native metadata helpers trust only marked, well-shaped account rows", () => {
    const trusted = {
      slug: "side/gpt-5.6-luna",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: 115_200,
      multi_agent_version: "v2",
    };
    const malformed = {
      ...trusted,
      slug: "side/nested/gpt-5.6-luna",
    };
    const unmarked = {
      ...trusted,
      slug: "provider/gpt-5.6-luna",
      opencodex_catalog_kind: undefined,
    };

    applyNativeOpenAiContextOverride(trusted);
    applyNativeOpenAiContextOverride(malformed);
    applyNativeOpenAiContextOverride(unmarked);
    expect(trusted).toMatchObject({
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 244_800,
    });
    expect(malformed).toMatchObject({
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: 115_200,
    });
    expect(unmarked).toMatchObject({
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: 115_200,
    });

    applyMultiAgentMode([trusted, malformed, unmarked], "default");
    expect(trusted.multi_agent_version).toBe("v1");
    expect(malformed.multi_agent_version).toBeUndefined();
    expect(unmarked.multi_agent_version).toBeUndefined();
  });

  test("native availability mirrors the built-in OpenAI auth-mode default", () => {
    const canonical = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as const;
    expect(shouldIncludeNativeOpenAi({ providers: {} })).toBe(true);
    expect(shouldIncludeNativeOpenAi({ providers: { openai: canonical } })).toBe(true);
    expect(shouldIncludeNativeOpenAi({
      providers: { openai: { ...canonical, authMode: "forward" } },
    })).toBe(true);
    expect(shouldIncludeNativeOpenAi({
      providers: { openai: { ...canonical, authMode: "key" } },
    })).toBe(false);
    expect(shouldIncludeNativeOpenAi({
      providers: { openai: { ...canonical, baseUrl: "https://api.example.test/v1" } },
    })).toBe(false);
    expect(shouldIncludeNativeOpenAi({
      providers: { openai: { ...canonical, disabled: true } },
    })).toBe(true);
    expect(shouldIncludeAccountBoundNativeOpenAi({ providers: {} })).toBe(false);
    expect(shouldIncludeAccountBoundNativeOpenAi({ providers: { openai: canonical } })).toBe(true);
    expect(shouldIncludeAccountBoundNativeOpenAi({
      providers: { openai: { ...canonical, disabled: true } },
    })).toBe(false);
    expect(shouldIncludeAccountBoundNativeOpenAi({
      providers: { openai: { ...canonical, authMode: "key" } },
    })).toBe(false);
  });

  test("case-distinct routing selectors remain distinguishable in picker labels", () => {
    expect(accountBoundNativeDisplayName("work", nativeTemplate())).toBe("work / 5.5");
    expect(accountBoundNativeDisplayName("Work", nativeTemplate())).toBe("Work / 5.5");
  });

  test("catalog discovery uses public selectors only and drops mappings to missing accounts", () => {
    const config = {
      codexAccounts: [{
        id: "stored-side-account",
        email: "private@example.test",
        alias: "Private Display Name",
        isMain: false,
      }],
      codexAccountNamespaces: {
        desktop: "@main",
        team: "stored-side-account",
        removed: "missing-account",
      },
    };
    expect(visibleCodexAccountSelectors(config)).toEqual(["desktop", "team"]);
    expect(accountBoundNativeModelSlugs(config, ["gpt-5.5"])).toEqual([
      "desktop/gpt-5.5",
      "team/gpt-5.5",
    ]);
    expect(JSON.stringify(accountBoundNativeModelSlugs(config, ["gpt-5.5"])))
      .not.toContain("stored-side-account");
  });

  test("picker visibility hides generated catalog rows without deleting routing bindings", () => {
    const codexAccountNamespaces = { desktop: "@main", team: "stored-side-account" };
    const config = {
      codexAccounts: [{ id: "stored-side-account", isMain: false }],
      codexAccountNamespaces,
      codexAccountPickerEnabled: false,
    };

    expect(visibleCodexAccountSelectors(config)).toEqual([]);
    expect(accountBoundNativeModelSlugs(config, ["gpt-5.5"])).toEqual([]);
    expect(config.codexAccountNamespaces).toBe(codexAccountNamespaces);

    config.codexAccountPickerEnabled = true;
    expect(visibleCodexAccountSelectors(config)).toEqual(["desktop", "team"]);

    expect(visibleCodexAccountSelectors({
      codexAccounts: config.codexAccounts,
      codexAccountNamespaces: {},
      codexAccountPickerEnabled: true,
    })).toEqual([]);
  });

  test("catalog sync flips supported natives to visibility hide and restores list on re-enable", () => {
    const native = nativeTemplate();
    const disabledOnce = mergeCatalogEntriesForSync(
      [native], [], new Map(), [], false, new Set(), null, new Set(["gpt-5.5"]),
    );
    expect(disabledOnce.find(e => e.slug === "gpt-5.5")?.visibility).toBe("hide");

    // Re-enable: the SAME preserved (hidden) entry flips back to list on the next sync.
    const reEnabled = mergeCatalogEntriesForSync(
      disabledOnce, [], new Map(), [], false, new Set(), null, new Set(),
    );
    expect(reEnabled.find(e => e.slug === "gpt-5.5")?.visibility).toBe("list");
  });

  test("visibility hide survives the upstream-upgrade branch for synthesized 5.6 entries", () => {
    // Fallback-quality luna (display_name === slug) gets upgraded to the snapshot entry AND
    // must still come out hidden when disabled — the flip runs as the last pass.
    const synthesizedLuna = {
      ...nativeTemplate(),
      slug: "gpt-5.6-luna",
      display_name: "gpt-5.6-luna",
    };
    const merged = mergeCatalogEntriesForSync(
      [synthesizedLuna], [], new Map(), [], false, new Set(), null, new Set(["gpt-5.6-luna"]),
    );
    const luna = merged.find(e => e.slug === "gpt-5.6-luna");
    expect(luna?.display_name).toBe("GPT-5.6-Luna"); // upgrade branch fired
    expect(luna?.visibility).toBe("hide"); // ...and could not clobber the hide flag
  });

  test("backfilled missing natives are synthesized hidden while disabled", () => {
    // Catalog has ONE native (the template source); every other supported slug is backfilled.
    const merged = mergeCatalogEntriesForSync(
      [nativeTemplate()], [], new Map(), [], false, new Set(), nativeTemplate() as never, new Set(["gpt-5.6-terra"]),
    );
    const terra = merged.find(e => e.slug === "gpt-5.6-terra");
    expect(terra).toBeDefined();
    expect(terra?.visibility).toBe("hide");
    // A non-disabled backfilled sibling stays picker-visible.
    expect(merged.find(e => e.slug === "gpt-5.6-sol")?.visibility).toBe("list");
  });

  test("applyNativeVisibility never touches routed or unsupported entries", () => {
    const entries = [
      { slug: "kiro/claude-opus-4.6", visibility: "list" },
      { slug: "gpt-legacy-unsupported", visibility: "list" },
    ];
    applyNativeVisibility(entries, new Set(["kiro/claude-opus-4.6", "gpt-legacy-unsupported"]));
    expect(entries[0].visibility).toBe("list");
    expect(entries[1].visibility).toBe("list");
  });

  test("disabled native state is mirrored onto its account-qualified clones", () => {
    const entries = [{
      slug: "side/gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      visibility: "list",
    }];
    applyNativeVisibility(entries, new Set(["gpt-5.6-sol"]), true);
    expect(entries[0].visibility).toBe("hide");
  });

  test("management API surfaces: /api/models leads with native rows; subagent available drops disabled bare slugs", async () => {
    resetCodexModelEntitlementCacheForTests();
    const config = makeConfig({ disabledModels: ["gpt-5.6-sol"] });

    const modelsRes = await handleManagementAPI(
      new Request("http://localhost/api/models"), new URL("http://localhost/api/models"), config,
    );
    const rows = await modelsRes!.json() as Array<{ namespaced: string; native?: boolean; disabled: boolean }>;
    const nativeRows = rows.filter(r => r.native);
    expect(nativeRows.map(r => r.namespaced)).toEqual(
      NATIVE_OPENAI_MODELS.filter(slug => !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)),
    );

    // A confirmed roster makes the gated rows selectable again; a bare disable still wins.
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol"]);
    const confirmedRes = await handleManagementAPI(
      new Request("http://localhost/api/models"), new URL("http://localhost/api/models"), config,
    );
    const confirmedRows = (await confirmedRes!.json() as Array<{ namespaced: string; native?: boolean; disabled: boolean }>)
      .filter(r => r.native);
    expect(confirmedRows.map(r => r.namespaced)).toContain("gpt-5.6-sol");
    expect(confirmedRows.find(r => r.namespaced === "gpt-5.6-sol")?.disabled).toBe(true);
    // Native rows lead the response so the GUI pins the group first.
    expect(rows[0]?.native).toBe(true);

    const subRes = await handleManagementAPI(
      new Request("http://localhost/api/subagent-models"), new URL("http://localhost/api/subagent-models"), config,
    );
    const sub = await subRes!.json() as { available: string[] };
    // Bare disabled slugs flow through the existing namespaced-string filter automatically.
    expect(sub.available).not.toContain("gpt-5.6-sol");
    expect(sub.available).toContain("gpt-5.6-terra");
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";

describe("#2574 a stale on-disk row is what a subagent reads", () => {
  /**
   * Reproduced against a live install: the resolver returns 922,000 for gpt-5.6-sol while
   * ~/.codex/opencodex-catalog.json still held 272,000 from an earlier sync. With
   * effective_context_window_percent = 95 that renders as 258,400 — the exact number reported.
   *
   * The subagent roster reads the persisted catalog rather than re-deriving from config, so a
   * row that predates the current limits is served verbatim. The override is correct; what is
   * missing is any assertion that the WRITTEN row matches what the resolver would produce.
   */
  test("a raised cap opts the family into the wider window, and the row follows", () => {
    // The 1M opt-in is expressed as a raised providerContextCaps.openai, not a per-model
    // window. With the default cap the family stays at 272k; raising it past the opt-in
    // threshold is what makes 922k the correct width.
    const optedIn = nativeContextLimits({ providerContextCaps: { openai: 1_050_000 } } as never);
    expect(nativeOpenAiContextWindow("gpt-5.6-sol", optedIn)).toBe(NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW);

    // A row written before that opt-in carries the narrow width. Re-applying the override with
    // the current limits is what repairs it — which is exactly what a stale on-disk catalog
    // never gets, because the subagent roster reads the file rather than re-deriving.
    const stale: Record<string, unknown> = {
      slug: "gpt-5.6-sol",
      context_window: NATIVE_GPT56_CONTEXT_WINDOW,
      effective_context_window_percent: 95,
    };
    applyNativeOpenAiContextOverride(stale as never, optedIn);
    expect(stale.context_window).toBe(NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW);

    // 272,000 x 95% = 258,400 — the number reported in the issue, and what a client renders
    // from the stale row.
    expect(Math.floor(NATIVE_GPT56_CONTEXT_WINDOW * 0.95)).toBe(258_400);
  });

  test("the written row agrees with the resolver for the whole 5.6 family", () => {
    // This is the invariant whose absence let a stale row survive unnoticed: whatever a
    // subagent reads from disk must equal what the request path would compute.
    const limits = nativeContextLimits({ providerContextCaps: { openai: 1_050_000 } } as never);
    for (const slug of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const row: Record<string, unknown> = { slug, context_window: NATIVE_GPT56_CONTEXT_WINDOW };
      applyNativeOpenAiContextOverride(row as never, limits);
      expect(row.context_window).toBe(nativeOpenAiContextWindow(slug, limits));
    }
  });

  test("a provider cap still narrows the family below the opt-in window", () => {
    // The lift must not become unconditional: an operator cap is still authoritative.
    const capped = nativeContextLimits({ providerContextCaps: { openai: 300_000 } } as never);
    const row: Record<string, unknown> = { slug: "gpt-5.6-sol", context_window: NATIVE_GPT56_CONTEXT_WINDOW };
    applyNativeOpenAiContextOverride(row as never, capped);
    expect(row.context_window).toBe(300_000);
  });
});
