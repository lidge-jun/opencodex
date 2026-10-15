import { describe, expect, test } from "bun:test";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../../src/codex/catalog/account-models";
import { nativeContextLimits, type NativeContextLimitsInput } from "../../src/codex/catalog/metadata";
import { applyNativeOpenAiContextOverride, ensureStrictCatalogFields, type RawEntry } from "../../src/codex/catalog/parsing";

function nativeRow(slug = "gpt-6-astra"): RawEntry {
  return { slug, context_window: 272_000, max_context_window: 872_000 };
}

describe("#7075 native advertised maximum is independent of the default window", () => {
  test.each([
    ["gpt-6-astra", 272_000, 872_000],
    ["gpt-6-sol", 272_000, 872_000],
    ["gpt-6-luna", 272_000, 872_000],
    ["gpt-6.1-sol", 500_000, 872_000],
    ["gpt-5.6-sol", 272_000, 922_000],
    ["gpt-5.6-terra", 272_000, 922_000],
    ["gpt-5.6-luna", 272_000, 922_000],
  ])("%s retains its maximum without changing default compaction", (slug, window, maximum) => {
    const row = nativeRow(slug);
    applyNativeOpenAiContextOverride(row, nativeContextLimits({}));
    expect(row).toMatchObject({
      context_window: window,
      max_context_window: maximum,
      auto_compact_token_limit: Math.floor(window * 0.9),
    });
    applyNativeOpenAiContextOverride(row, nativeContextLimits({}));
    expect(row.max_context_window).toBe(maximum);
  });

  test.each([
    [undefined, 272_000, 872_000],
    [{}, 272_000, 872_000],
    [{ cap: 0 }, 272_000, 872_000],
    [{ cap: NaN, providerWindow: -1 }, 272_000, 872_000],
    [{ cap: 1.5, modelWindows: { "gpt-6-astra": Infinity } }, 272_000, 872_000],
    [{ modelAutoCompactTokenLimits: { "gpt-6-astra": 100_000 } }, 272_000, 872_000],
    [200_000, 200_000, 200_000],
    [{ cap: 272_000 }, 272_000, 272_000],
    [{ cap: 500_000 }, 500_000, 500_000],
    [{ cap: 2_000_000 }, 872_000, 872_000],
    [{ providerWindow: 300_000 }, 300_000, 300_000],
    [{ modelWindows: { "gpt-6-astra": 272_000 } }, 272_000, 272_000],
    [{ providerWindow: 300_000, modelWindows: { "gpt-6-astra": 500_000 } }, 500_000, 500_000],
    [{ cap: 350_000, modelWindows: { "gpt-6-astra": 500_000 } }, 350_000, 350_000],
  ] satisfies [NativeContextLimitsInput, number, number][])("limits %j preserve cap precedence", (limits, window, maximum) => {
    const row = nativeRow();
    applyNativeOpenAiContextOverride(row, limits);
    expect(row.context_window).toBe(window);
    expect(row.max_context_window).toBe(maximum);
    expect(row.auto_compact_token_limit).toBe(
      typeof limits === "object" && limits?.modelAutoCompactTokenLimits ? 100_000 : Math.floor(window * 0.9),
    );
  });

  test("a per-model window leaves siblings at their defaults under a provider fallback", () => {
    const limits = nativeContextLimits({ providers: { openai: {
      contextWindow: 300_000,
      modelContextWindows: { "gpt-6.1-sol": 500_000 },
    } } });
    const sol = nativeRow("gpt-6.1-sol");
    const astra = nativeRow();
    applyNativeOpenAiContextOverride(sol, limits);
    applyNativeOpenAiContextOverride(astra, limits);
    expect(sol).toMatchObject({ context_window: 500_000, max_context_window: 500_000 });
    expect(astra).toMatchObject({ context_window: 300_000, max_context_window: 300_000 });
  });

  test("a sibling's per-model setting and a retained soft budget do not cap the maximum", () => {
    const row = { ...nativeRow(), auto_compact_token_limit: 100_000 };
    applyNativeOpenAiContextOverride(row, { modelWindows: { "gpt-6-sol": 300_000 } });
    expect(row).toMatchObject({
      context_window: 272_000, max_context_window: 872_000, auto_compact_token_limit: 100_000,
    });
  });

  test("account-qualified native rows use the same maximum and exact model limits", () => {
    const row = { ...nativeRow("work/gpt-6-astra"), opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND };
    applyNativeOpenAiContextOverride(row);
    expect(row.max_context_window).toBe(872_000);
    applyNativeOpenAiContextOverride(row, { modelWindows: { "gpt-6-astra": 300_000 } });
    expect(row).toMatchObject({ context_window: 300_000, max_context_window: 300_000 });
  });

  test("preserved native rows without static metadata only narrow for configured limits", () => {
    const row = nativeRow("future-native-model");
    applyNativeOpenAiContextOverride(row);
    expect(row).toMatchObject({ context_window: 272_000, max_context_window: 872_000 });
    applyNativeOpenAiContextOverride(row, { cap: 300_000 });
    expect(row).toMatchObject({ context_window: 272_000, max_context_window: 300_000 });
  });

  test.each([
    [CODEX_ACCOUNT_BOUND_CATALOG_KIND, "work/gpt-6-astra", false, 872_000],
    [undefined, "work/gpt-6-astra", false, 272_000],
    [CODEX_ACCOUNT_BOUND_CATALOG_KIND, "work/nested/gpt-6-astra", false, 272_000],
    [CODEX_ACCOUNT_BOUND_CATALOG_KIND, "work/gpt-6-astra", true, 272_000],
  ])("strict normalization preserves only trusted native selector maxima (%s, %s, routed=%s)", (kind, slug, isRouted, maximum) => {
    const row = { ...nativeRow(slug), opencodex_catalog_kind: kind };
    ensureStrictCatalogFields(row, { isRouted });
    expect(row).toMatchObject({ context_window: 272_000, max_context_window: maximum });
  });

  test("configured values above a short model's capacity never raise its maximum", () => {
    const row = nativeRow("gpt-5.5");
    applyNativeOpenAiContextOverride(row, { providerWindow: 500_000 });
    expect(row).toMatchObject({ context_window: 272_000, max_context_window: 272_000 });
  });
});
