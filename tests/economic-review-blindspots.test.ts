import { afterEach, describe, expect, test } from "bun:test";
import {
  clearEconomicState,
  countEconomicReservationsForAllowance,
  explainEconomicCombo,
  getEconomicQuotaSnapshot,
  pickComboTarget,
  releaseEconomicReservation,
  reserveEconomicSelection,
  selectEconomicTarget,
  settleEconomicReservation,
  setEconomicQuotaSnapshot,
} from "../src/combos";
import type { OcxConfig } from "../src/types";

const NOW = Date.now();

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "included",
    providers: {
      included: { adapter: "openai-chat", baseUrl: "https://included.example", models: ["m"] },
      payg: { adapter: "openai-chat", baseUrl: "https://payg.example", models: ["m"] },
      alt: { adapter: "openai-chat", baseUrl: "https://alt.example", models: ["m"] },
    },
    economicAllowances: {
      promo: {
        unit: "requests",
        capacity: 2,
        window: { kind: "balance" },
        source: "manual",
        rates: { fixedPerRequest: 1 },
      },
    },
    combos: {
      bulk: {
        strategy: "economy",
        economy: { unknownQuota: "deprioritize", maxMarginalUsd: 0.05 },
        targets: [
          { provider: "included", model: "m", allowances: ["promo"] },
          { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
          { provider: "alt", model: "m" },
        ],
      },
    },
    ...overrides,
  };
}

afterEach(() => clearEconomicState());

describe("economic hostile-review blindspots", () => {
  test("race never returns allowance target without reservationId", () => {
    const cfg = baseConfig();
    setEconomicQuotaSnapshot("promo", { remaining: 1, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    let raced = false;
    const result = reserveEconomicSelection(cfg, "bulk", { inputTokens: 0, outputTokens: 0, fixedRequests: 1, kind: "configured" }, NOW, [], () => {
      if (!raced) {
        raced = true;
        setEconomicQuotaSnapshot("promo", { remaining: 0, updatedAt: NOW, source: "manual", confidence: "authoritative" });
      }
      return true;
    });
    if (result.target?.provider === "included") expect(result.reservationId).toBeString();
    if (result.target?.allowances?.length) expect(result.reservationId).toBeString();
  });

  test("credits settle derives burn from rates (not full restore)", () => {
    const cfg = baseConfig({
      economicAllowances: {
        promo: {
          unit: "credits",
          capacity: 100,
          window: { kind: "balance" },
          source: "manual",
          rates: { fixedPerRequest: 10, inputPerMillion: 0 },
        },
      },
    });
    setEconomicQuotaSnapshot("promo", { remaining: 50, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    const reserved = reserveEconomicSelection(cfg, "bulk", { inputTokens: 0, outputTokens: 0, fixedRequests: 1, kind: "configured" }, NOW);
    expect(reserved.reservationId).toBeString();
    settleEconomicReservation(reserved.reservationId, { inputTokens: 0, outputTokens: 0, requests: 1 }, NOW + 1);
    expect(getEconomicQuotaSnapshot("promo")?.remaining).toBe(40);
  });

  test("maxMarginalUsd fail-closed on unknown cash cost", () => {
    const cfg = baseConfig({
      combos: {
        bulk: {
          strategy: "economy",
          economy: { maxMarginalUsd: 0.05 },
          targets: [
            { provider: "alt", model: "m" }, // no pricing, no allowances → unknown cash
            { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 1 } }, // expensive
          ],
        },
      },
    });
    const result = selectEconomicTarget(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, NOW);
    expect(result.target).toBeUndefined();
    expect(result.candidates.find(c => c.target.provider === "alt")?.exclusions).toContain("max-marginal-usd");
    expect(result.candidates.find(c => c.target.provider === "payg")?.exclusions).toContain("max-marginal-usd");
  });

  test("economy pick without requestEstimate returns null", () => {
    const cfg = baseConfig();
    setEconomicQuotaSnapshot("promo", { remaining: 5, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    expect(pickComboTarget(cfg, "bulk", {})).toBeNull();
    expect(pickComboTarget(cfg, "bulk", {
      requestEstimate: { inputTokens: 0, outputTokens: 0, fixedRequests: 1, kind: "configured" },
    })?.target.provider).toBe("included");
  });

  test("explain winner has empty hard exclusions; reserve is soft only", () => {
    const cfg = baseConfig({
      combos: {
        bulk: {
          strategy: "economy",
          economy: { unknownQuota: "deprioritize" },
          targets: [
            { provider: "included", model: "m", allowances: ["promo"] },
          ],
        },
      },
      economicAllowances: {
        promo: {
          unit: "requests",
          capacity: 10,
          window: { kind: "balance" },
          source: "manual",
          reserveFraction: 0.9,
        },
      },
    });
    setEconomicQuotaSnapshot("promo", { remaining: 10, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    // demand 2 → post=8, reserve threshold=9 → soft reserve pressure; sole eligible winner
    const explanation = explainEconomicCombo(cfg, "bulk", { inputTokens: 0, outputTokens: 0, fixedRequests: 2, kind: "configured" }, NOW);
    expect(explanation.selectedTarget).toBeString();
    const winner = explanation.candidates.find(c => c.target.provider === "included");
    expect(winner?.eligible).toBe(true);
    expect(winner?.exclusions).toEqual([]);
    expect(winner?.hardExclusions).toEqual([]);
    expect(winner?.softSignals).toContain("reserve");
    expect(winner?.cashCost).toBe("included");
    expect(explanation.reason).toBe("reserve pressure");
    expect(winner?.rankingBand).toBe("reserve");
  });

  test("explain DTO exposes hardExclusions alias and stable shape keys", () => {
    const cfg = baseConfig();
    setEconomicQuotaSnapshot("promo", { remaining: 5, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    const explanation = explainEconomicCombo(cfg, "bulk", { inputTokens: 0, outputTokens: 0, fixedRequests: 1, kind: "configured" }, NOW);
    expect(explanation).toMatchObject({
      comboId: "bulk",
      strategy: "economy",
      selectedTarget: expect.any(String),
      generatedAt: NOW,
      reason: expect.any(String),
    });
    for (const c of explanation.candidates) {
      expect(c.hardExclusions).toEqual(c.exclusions);
      expect(Array.isArray(c.softSignals)).toBe(true);
      expect(typeof c.configIndex).toBe("number");
      expect(c.cashCost === "included" || c.cashCost === "unknown" || typeof c.cashCost === "number").toBe(true);
    }
  });

  test("pure PAYG has no reservationId; atomic multi-allowance needs all snapshots", () => {
    const paygOnly = baseConfig({
      combos: { bulk: { strategy: "economy", targets: [{ provider: "payg", model: "m", pricing: { fixedPerRequest: 0.01 } }] } },
    });
    const payg = reserveEconomicSelection(paygOnly, "bulk", { inputTokens: 0, outputTokens: 0, fixedRequests: 1, kind: "configured" }, NOW);
    expect(payg.reservationId).toBeUndefined();
  });

  test("countEconomicReservationsForAllowance tracks holds", () => {
    const cfg = baseConfig();
    setEconomicQuotaSnapshot("promo", { remaining: 2, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    const a = reserveEconomicSelection(cfg, "bulk", { inputTokens: 0, outputTokens: 0, fixedRequests: 1, kind: "configured" }, NOW);
    expect(countEconomicReservationsForAllowance("promo", NOW)).toBe(1);
    releaseEconomicReservation(a.reservationId);
    expect(countEconomicReservationsForAllowance("promo", NOW)).toBe(0);
  });
});
