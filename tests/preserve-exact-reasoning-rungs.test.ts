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
});
