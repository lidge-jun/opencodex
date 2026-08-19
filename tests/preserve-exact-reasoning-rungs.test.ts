import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints, buildCatalogEntries } from "../src/codex/catalog";
import type { OcxProviderConfig } from "../src/types";

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    apiKey: "sk-test",
    modelReasoningEfforts: { "qwen3.8-max": ["low", "medium", "xhigh"] },
    ...overrides,
  };
}

function advertisedLevels(entry: Record<string, unknown> | undefined): string[] {
  const rows = (entry?.supported_reasoning_levels ?? []) as { effort?: string }[];
  return rows.map(level => level.effort).filter((effort): effort is string => typeof effort === "string");
}

function hintedQwen(prov: OcxProviderConfig): Record<string, unknown> {
  const hinted = applyProviderConfigHints(
    "alibaba-token-plan-intl",
    prov,
    { id: "qwen3.8-max", provider: "alibaba-token-plan-intl" },
  );
  const entries = buildCatalogEntries(nativeTemplate(), [], [hinted]);
  return entries.find(e => e.slug === "alibaba-token-plan-intl/qwen3.8-max") ?? {};
}

describe("#1870 preserveExactReasoningRungs", () => {
  test("provider-wide flag suppresses synthetic max/ultra rungs", () => {
    const entry = hintedQwen(provider({ preserveExactReasoningRungs: true }));
    expect(advertisedLevels(entry)).toEqual(["low", "medium", "xhigh"]);
  });

  test("per-model flag scopes suppression to the named model", () => {
    const entry = hintedQwen(provider({
      modelPreserveExactReasoningRungs: { "qwen3.8-max": true },
    }));
    expect(advertisedLevels(entry)).toEqual(["low", "medium", "xhigh"]);
  });

  test("synthetic max/ultra rungs remain advertised by default", () => {
    const entry = hintedQwen(provider());
    expect(advertisedLevels(entry)).toEqual(["low", "medium", "xhigh", "max", "ultra"]);
  });

  test("per-model false overrides a provider-wide true", () => {
    const entry = hintedQwen(provider({
      preserveExactReasoningRungs: true,
      modelPreserveExactReasoningRungs: { "qwen3.8-max": false },
    }));
    expect(advertisedLevels(entry)).toEqual(["low", "medium", "xhigh", "max", "ultra"]);
  });

  test("re-hinting a cached model clears a stale exact-rung flag", () => {
    const flagged = applyProviderConfigHints(
      "alibaba-token-plan-intl",
      provider({ preserveExactReasoningRungs: true }),
      { id: "qwen3.8-max", provider: "alibaba-token-plan-intl" },
    );
    expect(flagged.preserveExactReasoningRungs).toBe(true);

    // A cached model produced by an earlier hint pass still carries the flag;
    // re-hinting with a config that resolves to false must clear it.
    const cleared = applyProviderConfigHints(
      "alibaba-token-plan-intl",
      provider(),
      flagged,
    );
    expect(cleared.preserveExactReasoningRungs).toBeUndefined();
    const entries = buildCatalogEntries(nativeTemplate(), [], [cleared]);
    const entry = entries.find(e => e.slug === "alibaba-token-plan-intl/qwen3.8-max");
    expect(advertisedLevels(entry)).toEqual(["low", "medium", "xhigh", "max", "ultra"]);
  });

  test("empty or none reasoning ladders never grow synthetic rungs regardless of flag", () => {
    const entryEmpty = hintedQwen(provider({
      modelReasoningEfforts: { "qwen3.8-max": [] },
      preserveExactReasoningRungs: false,
    }));
    expect(advertisedLevels(entryEmpty)).toEqual([]);

    const entryNone = hintedQwen(provider({
      modelReasoningEfforts: { "qwen3.8-max": ["none"] },
      preserveExactReasoningRungs: false,
    }));
    expect(advertisedLevels(entryNone)).toEqual(["none"]);
  });

  test("exact-rung flag preserves custom default reasoning effort within the ladder", () => {
    const entry = hintedQwen(provider({
      preserveExactReasoningRungs: true,
      modelDefaultReasoningEfforts: { "qwen3.8-max": "xhigh" },
    }));
    expect(advertisedLevels(entry)).toEqual(["low", "medium", "xhigh"]);
    expect(entry.default_reasoning_level).toBe("xhigh");
  });
});
