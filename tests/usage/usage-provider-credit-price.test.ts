import { afterEach, describe, expect, test } from "bun:test";
import { estimateAttemptCost, estimateRequestCost } from "../../src/usage/cost";
import { activeCreditPrices, refreshUserCostOverlays, userCostOverlayVersion } from "../../src/usage/user-cost-overlays";
import type { OcxConfig } from "../../src/types";

// Kiro bills credits and caches repeated context on its side, but reports no cache tokens. Pricing
// its estimated input at list price overstates long conversations; credits x a configured price
// follows what was billed.
const kiroConfig = (creditPriceUsd?: number): OcxConfig => ({
  port: 0,
  providers: {
    kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", ...(creditPriceUsd === undefined ? {} : { creditPriceUsd }) },
  },
} as unknown as OcxConfig);

const longTurn = { inputTokens: 600_000, outputTokens: 400, providerCredits: 1.95, estimated: true } as const;

afterEach(() => refreshUserCostOverlays(kiroConfig()));

describe("provider credit price", () => {
  test("without a credit price, a Kiro row keeps the token estimate", () => {
    refreshUserCostOverlays(kiroConfig());
    const estimate = estimateRequestCost({ provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" });

    expect(estimate?.cost.total).toBeCloseTo(600_000 * 4 / 1e6 + 400 * 20 / 1e6, 6);
  });

  test("with a credit price, a Kiro row is credits x price", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const estimate = estimateRequestCost({ provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" });

    expect(estimate?.cost.total).toBeCloseTo(1.95 * 0.04, 9);
    expect(estimate?.tokens.input).toBe(600_000);
  });

  test("a combo attempt follows the same rule", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const estimate = estimateAttemptCost({ ordinal: 1, provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" });

    expect(estimate?.cost.total).toBeCloseTo(1.95 * 0.04, 9);
  });

  test("a row with output but no credits keeps the token estimate even when a price is set", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const { providerCredits: _unused, ...noCredits } = longTurn;
    const estimate = estimateRequestCost({ provider: "kiro", model: "claude-opus-5.5", usage: noCredits, usageStatus: "estimated" });

    expect(estimate?.cost.total).toBeCloseTo(600_000 * 4 / 1e6 + 400 * 20 / 1e6, 6);
  });

  test("a refused or cancelled row (no credits, no output) costs nothing when a price is set", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const refused = { inputTokens: 130_000, outputTokens: 0, estimated: true };
    const estimate = estimateRequestCost({ provider: "kiro", model: "claude-opus-5.5", usage: refused, usageStatus: "estimated" });

    expect(estimate?.cost.total).toBe(0);
  });

  test("without a price, a refused row keeps the token estimate", () => {
    refreshUserCostOverlays(kiroConfig());
    const refused = { inputTokens: 130_000, outputTokens: 0, estimated: true };
    const estimate = estimateRequestCost({ provider: "kiro", model: "claude-opus-5.5", usage: refused, usageStatus: "estimated" });

    expect(estimate?.cost.total).toBeCloseTo(130_000 * 4 / 1e6, 6);
  });

  test("another provider is not affected by Kiro's credit price", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const estimate = estimateRequestCost({ provider: "anthropic", model: "claude-opus-5-5", usage: { ...longTurn }, usageStatus: "reported" });

    expect(estimate?.cost.total).toBeGreaterThan(1);
  });

  test("changing the credit price bumps the overlay version so cached summaries refresh", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const before = userCostOverlayVersion();
    refreshUserCostOverlays(kiroConfig(0.02));

    expect(userCostOverlayVersion()).toBeGreaterThan(before);
    expect(activeCreditPrices().get("kiro")).toBe(0.02);
  });
});

describe("providers.<name>.creditPriceUsd config", () => {
  const withPrice = (creditPriceUsd: unknown) => ({
    port: 0,
    defaultProvider: "kiro",
    providers: { kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", creditPriceUsd } },
  });

  test("a non-negative number is accepted", async () => {
    const { configSchema } = await import("../../src/config/schema/config-schema");
    expect(configSchema.safeParse(withPrice(0.04)).success).toBe(true);
    expect(configSchema.safeParse(withPrice(0)).success).toBe(true);
  });

  test("a negative, non-finite or non-numeric value is rejected on its path", async () => {
    const { configSchema } = await import("../../src/config/schema/config-schema");
    for (const bad of [-0.01, Number.POSITIVE_INFINITY, "0.04"]) {
      const result = configSchema.safeParse(withPrice(bad));
      expect(result.success).toBe(false);
      expect(result.error?.issues.some(issue => issue.path.join(".") === "providers.kiro.creditPriceUsd")).toBe(true);
    }
  });
});
