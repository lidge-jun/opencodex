import { describe, expect, test } from "bun:test";
import { buildSmartRoutingCombo } from "../src/combos";
import type { CatalogModel } from "../src/codex/catalog";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: "https://example.com", apiKey: "x", ...overrides };
}

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "anthropic",
    providers: {
      anthropic: provider(),
      google: provider(),
      xai: provider(),
      local: provider({ authMode: "local" }),
      unknown: provider({ freeTier: true }),
      disabled: provider({ disabled: true }),
    },
    disabledModels: ["xai/grok-4.5"],
  };
}

const models: CatalogModel[] = [
  { provider: "anthropic", id: "claude-fable-5", contextWindow: 1_000_000 },
  { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 1_000_000 },
  { provider: "google", id: "gemini-3.6-flash", contextWindow: 1_000_000 },
  { provider: "google", id: "gemini-3.5-flash-lite", contextWindow: 1_000_000 },
  { provider: "xai", id: "grok-4.5", contextWindow: 500_000 },
  { provider: "local", id: "claude-sonnet-5", contextWindow: 1_000_000 },
  { provider: "unknown", id: "future-reasoner", reasoningEfforts: ["high"], contextWindow: 256_000 },
  { provider: "disabled", id: "deepseek-v4-pro", contextWindow: 1_000_000 },
  { provider: "combo", id: "existing" },
  { provider: "missing", id: "not-installed" },
];

describe("smart routing", () => {
  test("uses benchmark-informed capability, provider cost, and conservative unknown handling", () => {
    const intelligence = buildSmartRoutingCombo("intelligence", models, config());
    const balance = buildSmartRoutingCombo("balance", models, config());
    const cost = buildSmartRoutingCombo("cost", models, config());

    expect(intelligence!.targets.find(target => target.provider === "anthropic")?.model).toBe("claude-fable-5");
    expect(intelligence!.targets).toContainEqual(expect.objectContaining({ provider: "local", model: "claude-sonnet-5" }));
    expect(balance!.targets.find(target => target.provider === "google")?.model).toBe("gemini-3.6-flash");
    expect(cost!.targets[0]).toMatchObject({ provider: "local", model: "claude-sonnet-5", weight: 10 });
    expect(cost!.targets.some(target => target.provider === "unknown")).toBe(false);
    expect(cost!.targets.some(target => target.provider === "xai")).toBe(false);
    expect(new Set(intelligence!.targets.map(target => target.provider)).size).toBe(intelligence!.targets.length);
    expect(intelligence!.targets.every(target => Number.isInteger(target.weight) && target.weight! > 0)).toBe(true);
  });

  test("does not treat a remote free-tier flag as zero-cost pricing", () => {
    const onlyUnknown: CatalogModel[] = [
      { provider: "unknown", id: "claude-sonnet-5", contextWindow: 1_000_000 },
    ];
    expect(buildSmartRoutingCombo("cost", onlyUnknown, config())).toBeNull();
    expect(buildSmartRoutingCombo("intelligence", onlyUnknown, config())).not.toBeNull();
  });
});
