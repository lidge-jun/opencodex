import { afterEach, describe, expect, test } from "bun:test";
import { estimateAttemptCost, estimateComboCost, estimateRequestCost, serviceTierContext } from "../../src/usage/cost";
import { MAX_CREDIT_PRICE_USD, MAX_PROVIDER_CREDITS, sumCreditReadings } from "../../src/usage/credit-billing";
import { mergeUsage as mergeEmptyUsage } from "../../src/server/responses/empty-completion-guard";
import { mergeUsage as mergeTerminalUsage } from "../../src/server/responses/terminal-guard";

test("combined credit evidence retains invalid readings through later additions", () => {
  expect(sumCreditReadings([undefined, undefined])).toBeUndefined();
  expect(sumCreditReadings([0, 2])).toBe(2);
  expect(sumCreditReadings([-1, 10])).toBe(-1);
  expect(sumCreditReadings([10, -1])).toBe(-1);
  expect(sumCreditReadings([Number.NaN, 10])).toBe(-1);
  for (const merge of [mergeEmptyUsage, mergeTerminalUsage]) {
    const partial = { inputTokens: 1, outputTokens: 1, providerCredits: -1 };
    const complete = { inputTokens: 1, outputTokens: 1, providerCredits: 10 };
    expect(merge(partial, complete)?.providerCredits).toBe(-1);
    expect(merge(complete, partial)?.providerCredits).toBe(-1);
  }
});
import { activeCreditPrices, refreshUserCostOverlays, userCostOverlayVersion } from "../../src/usage/user-cost-overlays";
import { sanitizeCreditPriceForLoad } from "../../src/config/load-degrade";
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

  test("a row with an explicit zero credit reading costs nothing when a price is set", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const refused = { inputTokens: 130_000, outputTokens: 0, providerCredits: 0, estimated: true };
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

  test("an account-suffixed Kiro row uses the provider's credit price", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const estimate = estimateRequestCost({ provider: "kiro-p9d8524", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" });

    expect(estimate?.cost.total).toBeCloseTo(1.95 * 0.04, 9);
  });

  test("a configured provider whose name extends another keeps its own price", () => {
    refreshUserCostOverlays({
      port: 0,
      providers: {
        kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", creditPriceUsd: 0.04 },
        "kiro-team": { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth" },
      },
    } as unknown as OcxConfig);
    const estimate = estimateRequestCost({ provider: "kiro-team", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" });

    expect(estimate?.cost.total).not.toBeCloseTo(1.95 * 0.04, 9);
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

describe("providers.<name>.creditPriceUsd at load time", () => {
  test("an invalid hand-edited price is dropped with a warning and the provider is kept", () => {
    for (const bad of ["0.02", -0.01, Number.NaN]) {
      const parsed = { providers: { kiro: { adapter: "kiro", creditPriceUsd: bad }, other: { adapter: "openai-chat", creditPriceUsd: 0.02 } } };
      const warnings: string[] = [];
      sanitizeCreditPriceForLoad(parsed, message => warnings.push(message));

      expect(parsed.providers.kiro).toEqual({ adapter: "kiro" });
      expect(parsed.providers.other.creditPriceUsd).toBe(0.02);
      expect(warnings).toEqual(['⚠️  config.json providers."kiro".creditPriceUsd is invalid — ignoring the credit price']);
    }
  });
});

describe("credit billing provenance", () => {
  test("a credit-priced row reports credits and price instead of a token split", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const estimate = estimateRequestCost({ provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" });

    expect(estimate?.billing).toEqual({ source: "provider-credits", providerCredits: 1.95, creditPriceUsd: 0.04 });
    // The token buckets are not an allocation of what was billed; nothing may read them as one.
    expect(estimate?.cost.total).toBeCloseTo(1.95 * 0.04, 9);
  });

  test("a token-priced row carries no credit billing marker", () => {
    refreshUserCostOverlays(kiroConfig());
    const estimate = estimateRequestCost({ provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" });

    expect(estimate?.billing).toBeUndefined();
  });

  test("an explicit zero credit reading is a zero credit charge, not a token estimate", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const refused = { inputTokens: 130_000, outputTokens: 0, providerCredits: 0, estimated: true };
    const estimate = estimateRequestCost({ provider: "kiro", model: "claude-opus-5.5", usage: refused, usageStatus: "estimated" });

    expect(estimate?.cost.total).toBe(0);
    expect(estimate?.billing).toEqual({ source: "provider-credits", providerCredits: 0, creditPriceUsd: 0.04 });
  });

  test("a combo of credit attempts sums credits and keeps one shared price", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const combo = estimateComboCost([
      { ordinal: 1, provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" },
      { ordinal: 2, provider: "kiro", model: "claude-opus-5.5", usage: { ...longTurn, providerCredits: 0.5 }, usageStatus: "estimated" },
    ]);

    expect(combo?.billing).toEqual({ source: "provider-credits", providerCredits: 2.45, creditPriceUsd: 0.04 });
    expect(combo?.cost.total).toBeCloseTo(2.45 * 0.04, 9);
  });

  test("a mixed combo refuses to claim either split", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const combo = estimateComboCost([
      { ordinal: 1, provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" },
      { ordinal: 2, provider: "anthropic", model: "claude-opus-5-5", usage: { inputTokens: 1_000, outputTokens: 100 }, usageStatus: "reported" },
    ]);

    expect(combo?.billing).toEqual({ source: "mixed" });
    // The total is still the sum of what each attempt cost; only the split is unknown.
    const tokenAttempt = estimateAttemptCost({ ordinal: 2, provider: "anthropic", model: "claude-opus-5-5", usage: { inputTokens: 1_000, outputTokens: 100 }, usageStatus: "reported" });
    expect(combo?.cost.total).toBeCloseTo(1.95 * 0.04 + tokenAttempt!.cost.total, 9);
    expect(combo?.attempts?.[0]?.billing).toEqual({ source: "provider-credits", providerCredits: 1.95, creditPriceUsd: 0.04 });
    expect(combo?.attempts?.[1]?.billing).toBeUndefined();
  });

  test("a combo mixing a credit attempt with a token-priced attempt says mixed", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const combo = estimateComboCost([
      { ordinal: 1, provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" },
      { ordinal: 2, provider: "kiro", model: "claude-opus-5.5", usage: { inputTokens: 1_000, outputTokens: 100 }, usageStatus: "estimated" },
    ]);

    expect(combo?.billing).toEqual({ source: "mixed" });
  });

  test("a combo whose credit attempts use different prices says mixed, not one summed credit count", () => {
    refreshUserCostOverlays({
      port: 0,
      providers: {
        kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", creditPriceUsd: 0.04 },
        "kiro-alt": { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", creditPriceUsd: 0.02 },
      },
    } as unknown as OcxConfig);
    const combo = estimateComboCost([
      { ordinal: 1, provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" },
      { ordinal: 2, provider: "kiro-alt", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" },
    ]);

    // 2.45 credits would be a plausible-looking number that matches neither price, so the parent
    // must claim no split at all. Each attempt still states the charge it actually incurred.
    expect(combo?.billing).toEqual({ source: "mixed" });
    expect(combo?.cost.total).toBeCloseTo(1.95 * 0.04 + 1.95 * 0.02, 9);
    expect(combo?.attempts?.map(attempt => attempt.billing)).toEqual([
      { source: "provider-credits", providerCredits: 1.95, creditPriceUsd: 0.04 },
      { source: "provider-credits", providerCredits: 1.95, creditPriceUsd: 0.02 },
    ]);
  });

  test("a combo of credit attempts at one price still reports the summed credit count", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const combo = estimateComboCost([
      { ordinal: 1, provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" },
      { ordinal: 2, provider: "kiro", model: "claude-opus-5.5", usage: { ...longTurn, providerCredits: 0.05 }, usageStatus: "estimated" },
    ]);

    expect(combo?.billing).toEqual({ source: "provider-credits", providerCredits: 2, creditPriceUsd: 0.04 });
  });

  test("a credit product that cannot be represented fails closed instead of returning Infinity", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const oversized = { inputTokens: 1_000, outputTokens: 10, providerCredits: Number.MAX_VALUE, estimated: true };
    const estimate = estimateRequestCost({ provider: "kiro", model: "claude-opus-5.5", usage: oversized, usageStatus: "estimated" });

    expect(estimate).toBeNull();
  });

  test("an unrepresentable price fails closed even when the credits are ordinary", () => {
    const estimate = estimateRequestCost(
      { provider: "kiro", model: "claude-opus-5.5", usage: longTurn, usageStatus: "estimated" },
      undefined,
      undefined,
      new Map([["kiro", Number.MAX_VALUE]]),
    );

    expect(estimate).toBeNull();
  });

  test("the documented bounds stay far below the product that would overflow", () => {
    expect(MAX_CREDIT_PRICE_USD * MAX_PROVIDER_CREDITS).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  test("a token-priced row with a corrupt token count fails closed instead of returning Infinity", () => {
    // No credit price on this provider, so the token estimate is the only path. The rate bound
    // alone cannot save it: 1e308 tokens x any positive rate overflows.
    const estimate = estimateRequestCost({
      provider: "anthropic", model: "claude-opus-5-5", usage: { inputTokens: 1e308, outputTokens: 1e308 }, usageStatus: "reported",
    });
    expect(estimate).toBeNull();
  });

  test("a credit count above the bound fails closed even when the price is ordinary", () => {
    refreshUserCostOverlays(kiroConfig(0.04));
    const estimate = estimateRequestCost({
      provider: "kiro", model: "claude-opus-5.5",
      usage: { inputTokens: 1_000, outputTokens: 10, providerCredits: MAX_PROVIDER_CREDITS + 1, estimated: true },
      usageStatus: "estimated",
    });
    expect(estimate).toBeNull();
  });

  test("a credit-priced row still bills credits when its token count is too large to price", () => {
    // The credit charge is `credits x price`; it never reads the token buckets. An absurd token
    // count must not discard a number that does not depend on it — that would report the row as
    // unpriced because of a field the configured price does not use.
    refreshUserCostOverlays(kiroConfig(0.04));
    const estimate = estimateRequestCost({
      provider: "kiro", model: "claude-opus-5.5",
      usage: { inputTokens: 1e308, outputTokens: 10, providerCredits: 2, estimated: true },
      usageStatus: "estimated",
    });

    expect(estimate?.billing).toEqual({ source: "provider-credits", providerCredits: 2, creditPriceUsd: 0.04 });
    expect(estimate?.cost.total).toBeCloseTo(0.08, 9);
  });

  test("a credit-priced row with no credit reading keeps its token estimate", () => {
    // A credit-billed row whose token counters are fine must keep its token estimate when Kiro
    // reported no credits at all; only a reading that IS present and invalid fails closed.
    refreshUserCostOverlays(kiroConfig(0.04));
    const estimate = estimateRequestCost({
      provider: "kiro", model: "claude-opus-5.5",
      usage: { inputTokens: 1_000, outputTokens: 10 }, usageStatus: "estimated",
    });
    expect(estimate?.billing).toBeUndefined();
    expect(estimate?.cost.total).toBeGreaterThan(0);
  });
});

describe("credit price bounds", () => {
  const withPrice = (creditPriceUsd: unknown) => ({
    port: 0,
    defaultProvider: "kiro",
    providers: { kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", creditPriceUsd } },
  });

  test("a price at the bound is accepted and one above it is rejected", async () => {
    const { configSchema } = await import("../../src/config/schema/config-schema");
    expect(configSchema.safeParse(withPrice(MAX_CREDIT_PRICE_USD)).success).toBe(true);
    const over = configSchema.safeParse(withPrice(MAX_CREDIT_PRICE_USD * 2));
    expect(over.success).toBe(false);
    expect(over.error?.issues.some(issue => issue.path.join(".") === "providers.kiro.creditPriceUsd")).toBe(true);
  });

  test("an over-bound hand edit is dropped with the existing warning", () => {
    const parsed = { providers: { kiro: { adapter: "kiro", creditPriceUsd: MAX_CREDIT_PRICE_USD * 2 } } };
    const warnings: string[] = [];
    sanitizeCreditPriceForLoad(parsed, message => warnings.push(message));

    expect(parsed.providers.kiro).toEqual({ adapter: "kiro" });
    expect(warnings).toHaveLength(1);
  });
});

/**
 * A credit charge is `providerCredits x creditPriceUsd`. The token rates were resolved on the way
 * in — they have to be, because a provider with no credit reading falls back to them — but they did
 * not produce the amount. A `priorityLowerBound` claims the displayed number is a floor under an
 * unavailable Priority price, and a credit charge is not that: it is exact for the configured
 * price. The marker must therefore never reach a credit-billed estimate, or the Logs page prints
 * `>=` over a number that has no missing rate behind it.
 */
describe("credit billing does not inherit token-rate lower bounds", () => {
  // grok-4.7 prices over 200k input at the published long-context band, and a confirmed Priority
  // tier at that length is the case that sets `priorityLowerBound` on the token path.
  const grokConfig = (creditPriceUsd?: number): OcxConfig => ({
    port: 0,
    providers: {
      xai: { adapter: "openai", baseUrl: "https://api.x.ai", authMode: "apiKey", ...(creditPriceUsd === undefined ? {} : { creditPriceUsd }) },
    },
  } as unknown as OcxConfig);
  const tierOutcome = {
    canonical: "priority",
    wireKind: "service-tier",
    wireValue: "priority",
    fastOutcome: "applied",
    confirmation: "confirmed",
    responseServiceTier: "priority",
  } as const;
  const longPriority = { inputTokens: 300_000, outputTokens: 1_000, providerCredits: 2, estimated: true };
  const longToken = { inputTokens: 300_000, outputTokens: 1_000 };

  afterEach(() => refreshUserCostOverlays(grokConfig()));

  test("a token-priced Priority row keeps its documented lower bound", () => {
    refreshUserCostOverlays(grokConfig());
    const estimate = estimateRequestCost({
      provider: "xai", model: "grok-4.7", usage: longToken, usageStatus: "reported",
      // The row-shaped context `costResult` builds; the raw outcome alone does not carry the
      // resolved tier the long-context rule reads.
      serviceTier: serviceTierContext({ tierOutcome }),
    });

    expect(estimate?.billing).toBeUndefined();
    expect(estimate?.priorityLowerBound).toBe(true);
  });

  test("the same row billed from credits claims no lower bound", () => {
    refreshUserCostOverlays(grokConfig(0.04));
    const estimate = estimateRequestCost({
      provider: "xai", model: "grok-4.7", usage: longPriority, usageStatus: "estimated",
      serviceTier: serviceTierContext({ tierOutcome }),
    });

    expect(estimate?.billing).toEqual({ source: "provider-credits", providerCredits: 2, creditPriceUsd: 0.04 });
    expect(estimate?.cost.total).toBeCloseTo(0.08, 9);
    expect(estimate?.priorityLowerBound).toBeUndefined();
  });

  test("a credit attempt claims no lower bound either", () => {
    refreshUserCostOverlays(grokConfig(0.04));
    const estimate = estimateAttemptCost({
      ordinal: 1, provider: "xai", model: "grok-4.7", usage: longPriority, usageStatus: "estimated",
      tierOutcome,
    });

    expect(estimate?.billing).toEqual({ source: "provider-credits", providerCredits: 2, creditPriceUsd: 0.04 });
    expect(estimate?.priorityLowerBound).toBeUndefined();
  });

  test("a combo of credit attempts never aggregates into a lower bound", () => {
    refreshUserCostOverlays(grokConfig(0.04));
    const combo = estimateComboCost([
      { ordinal: 1, provider: "xai", model: "grok-4.7", usage: longPriority, usageStatus: "estimated", tierOutcome },
      { ordinal: 2, provider: "xai", model: "grok-4.7", usage: { ...longPriority, providerCredits: 1 }, usageStatus: "estimated", tierOutcome },
    ]);

    expect(combo?.billing).toEqual({ source: "provider-credits", providerCredits: 3, creditPriceUsd: 0.04 });
    expect(combo?.priorityLowerBound).toBeUndefined();
  });

  test("a mixed combo stays a floor when its token leg is one", () => {
    refreshUserCostOverlays(grokConfig(0.04));
    const combo = estimateComboCost([
      { ordinal: 1, provider: "xai", model: "grok-4.7", usage: longPriority, usageStatus: "estimated", tierOutcome },
      { ordinal: 2, provider: "xai", model: "grok-4.7", usage: longToken, usageStatus: "reported", tierOutcome },
    ]);

    expect(combo?.billing).toEqual({ source: "mixed" });
    // The credit leg is exact, but the sum also contains a token charge that is a floor under a
    // rate the proxy could not resolve. `credit x price + >=token` is still `>=` the true total,
    // and the pre-#8452 rule (every leg) hid that behind the exact leg.
    expect(combo?.attempts?.[1]?.priorityLowerBound).toBe(true);
    expect(combo?.priorityLowerBound).toBe(true);
  });

  test("an exact token leg does not borrow the credit leg's irrelevant token rate", () => {
    refreshUserCostOverlays(grokConfig(0.04));
    // Both rows resolve a Priority long-context token rate, but only the second one was priced
    // from tokens. The credit leg's rate never produced its amount, so it cannot qualify the
    // mixed total: with an exact token leg every component is exact.
    const combo = estimateComboCost([
      { ordinal: 1, provider: "xai", model: "grok-4.7", usage: longPriority, usageStatus: "estimated", tierOutcome },
      { ordinal: 2, provider: "xai", model: "grok-4.7", usage: longToken, usageStatus: "reported" },
    ]);

    expect(combo?.billing).toEqual({ source: "mixed" });
    expect(combo?.attempts?.[0]?.priorityLowerBound).toBeUndefined();
    expect(combo?.attempts?.[1]?.priorityLowerBound).toBeUndefined();
    expect(combo?.priorityLowerBound).toBeUndefined();
  });
});
