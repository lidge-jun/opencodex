import { afterEach, describe, expect, test } from "bun:test";
import { clearEconomicState, selectEconomicTarget } from "../src/combos/economy";
import type { OcxConfig } from "../src/types";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example", models: ["m"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example", models: ["m"] },
    },
    economicAllowances: {},
    combos: {
      bulk: {
        strategy: "economy",
        targets: [
          { provider: "a", model: "m" },
          { provider: "b", model: "m" },
        ],
      },
    },
  };
}

afterEach(() => clearEconomicState());

describe("economic candidate ordering stability", () => {
  test("equal unknown/non-finite marginal costs are ordered deterministically by configured order", () => {
    const cfg = config();
    // Both targets have no pricing and no allowances => marginalUsd null => both map to equal cost bucket.
    // Ordering must be deterministic and not depend on Infinity-Infinity => NaN.
    const estimate = { inputTokens: 1000, outputTokens: 1000, kind: "configured" as const };
    const first = selectEconomicTarget(cfg, "bulk", estimate, NOW);
    const second = selectEconomicTarget(cfg, "bulk", estimate, NOW);
    expect(first.targetIndex).toBe(0);
    expect(second.targetIndex).toBe(0);
    expect(first.candidates[0]!.target.provider).toBe("a");
    expect(first.candidates[1]!.target.provider).toBe("b");
    // Reverse configured order should flip winner
    const rev: OcxConfig = { ...cfg, combos: { bulk: { ...cfg.combos!.bulk, targets: [...cfg.combos!.bulk.targets].reverse() } } };
    const revResult = selectEconomicTarget(rev, "bulk", estimate, NOW);
    expect(revResult.target?.provider).toBe("b");
  });

  test("Infinity and NaN pricing values are treated as unknown and do not break ordering", () => {
    const cfg: OcxConfig = {
      ...config(),
      combos: {
        bulk: {
          strategy: "economy",
          targets: [
            { provider: "a", model: "m", pricing: { inputUsdPerMillion: Number.POSITIVE_INFINITY } },
            { provider: "b", model: "m", pricing: { inputUsdPerMillion: Number.NaN } },
          ],
        },
      },
    };
    const estimate = { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" as const };
    const result = selectEconomicTarget(cfg, "bulk", estimate, NOW);
    // Both costs are non-finite => should be treated equal and stable (first wins)
    expect(result.target?.provider).toBe("a");
    expect(result.candidates.every(c => c.marginalUsd === null || Number.isFinite(c.marginalUsd!))).toBe(true);
  });
});
