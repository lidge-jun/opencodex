import { afterEach, describe, expect, test } from "bun:test";
import {
  clearEconomicState,
  economicConsumption,
  explainEconomicCombo,
  estimateEconomicRequest,
  reserveEconomicSelection,
  releaseEconomicReservation,
  setEconomicQuotaSnapshot,
  selectEconomicTarget,
} from "../src/combos/economy";
import type { OcxConfig } from "../src/types";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "cheap",
    providers: {
      cheap: { adapter: "openai-chat", baseUrl: "https://cheap.example", models: ["m"] },
      payg: { adapter: "openai-chat", baseUrl: "https://payg.example", models: ["m"] },
    },
    economicAllowances: {
      expiring: {
        unit: "credits",
        capacity: 100,
        window: { kind: "expiresAt", expiresAt: NOW + 60 * 60_000 },
        rollover: false,
        source: "manual",
        rates: { inputPerMillion: 1, outputPerMillion: 1 },
      },
      monthly: {
        unit: "credits",
        capacity: 100,
        window: { kind: "balance" },
        rollover: false,
        source: "manual",
        rates: { inputPerMillion: 1, outputPerMillion: 1 },
      },
    },
    combos: {
      bulk: {
        strategy: "economy",
        targets: [
          { provider: "cheap", model: "m", allowances: ["expiring", "monthly"] },
          { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
        ],
        economy: { unknownQuota: "deprioritize", maxMarginalUsd: 10 },
      },
    },
    ...overrides,
  };
}

const request = estimateEconomicRequest({ input: "x".repeat(4000), max_output_tokens: 100 }, "m");

afterEach(() => clearEconomicState());

describe("economic combo policy", () => {
  test("validates and normalizes an economy combo", async () => {
    const { comboConfigIssues, normalizeComboConfig } = await import("../src/combos/types");
    const cfg = config();
    expect(comboConfigIssues("bulk", cfg.combos!.bulk, cfg.providers, { allowances: cfg.economicAllowances })).toEqual([]);
    expect(normalizeComboConfig(cfg.combos!.bulk).strategy).toBe("economy");
  });

  test("expiring included quota beats PAYG and explains the decision", () => {
    setEconomicQuotaSnapshot("expiring", { remaining: 80, updatedAt: NOW, expiresAt: NOW + 60 * 60_000, source: "manual", confidence: "authoritative" });
    setEconomicQuotaSnapshot("monthly", { remaining: 80, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    const result = selectEconomicTarget(config(), "bulk", request, NOW);
    expect(result.target?.provider).toBe("cheap");
    expect(result.reason).toContain("expiration");
    expect(explainEconomicCombo(config(), "bulk", request, NOW).selectedTarget).toBe("cheap/m");
  });

  test("enforces all allowance windows and falls back to PAYG", () => {
    setEconomicQuotaSnapshot("expiring", { remaining: 80, updatedAt: NOW, expiresAt: NOW + 60 * 60_000, source: "manual", confidence: "authoritative" });
    setEconomicQuotaSnapshot("monthly", { remaining: 0, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    const result = selectEconomicTarget(config(), "bulk", request, NOW);
    expect(result.target?.provider).toBe("payg");
    expect(result.candidates[0]?.exclusions).toContain("hard-headroom");
  });

  test("reservations prevent concurrent over-allocation and release safely", () => {
    const cfg = config({ combos: { bulk: { ...config().combos!.bulk, economy: { unknownQuota: "reject" } } } });
    setEconomicQuotaSnapshot("expiring", { remaining: 1, updatedAt: NOW, expiresAt: NOW + 60 * 60_000, source: "manual", confidence: "authoritative" });
    setEconomicQuotaSnapshot("monthly", { remaining: 1, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    const first = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, NOW);
    expect(first.target?.provider).toBe("cheap");
    const second = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, NOW);
    expect(second.target?.provider).toBe("payg");
    releaseEconomicReservation(first.reservationId);
    const third = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, NOW);
    expect(third.target?.provider).toBe("cheap");
  });

  test("does not produce non-finite estimates", () => {
    expect(economicConsumption({ unit: "usd", capacity: 1, window: { kind: "balance" }, rates: { inputPerMillion: NaN } }, { inputTokens: 1e20, outputTokens: 1e20, kind: "fallback" })).toBe(0);
  });
});
