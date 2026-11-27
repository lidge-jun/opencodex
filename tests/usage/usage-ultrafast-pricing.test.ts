import { describe, expect, test } from "bun:test";
import { costResult, requestLogDto } from "../../src/server/management/shared";
import type { RequestLogEntry } from "../../src/server/request-log";
import type { AttemptTierOutcome } from "../../src/types";
import { estimateAttemptCost, estimateComboCost, estimateRequestCost, serviceTierContext } from "../../src/usage/cost";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { computeEntryCost } from "../../src/usage/summary";

// Synthetic: 100k input of which 90k cached, 100 output. GPT-6.2 Sol Standard prices it at $0.0300.
const usage = { inputTokens: 100_000, outputTokens: 100, cacheReadInputTokens: 90_000 };
const NOV_2026 = Date.UTC(2026, 10, 27, 12);
// Ultrafast for GPT-6.2 moves from 3x to 6x at 2027-03-01 00:00 Pacific (PST, UTC-8).
const STEP = Date.UTC(2027, 2, 1, 8);

/** The native Codex record from the report: the tier went out on the wire, the echo is not authoritative. */
const transmitted: AttemptTierOutcome = {
  wireKind: "service-tier",
  wireValue: "ultrafast",
  fastOutcome: "downgraded",
  fastDowngradeReason: "wire-unavailable",
  confirmation: "downgraded",
  responseServiceTier: "default",
  responseTierAuthoritative: false,
};

function attempt(tierOutcome: AttemptTierOutcome | undefined, extra: Record<string, unknown> = {}) {
  return { ordinal: 1, provider: "openai", model: "gpt-6.2-sol", usageStatus: "reported" as const, usage, ...(tierOutcome ? { tierOutcome } : {}), ...extra };
}

function attemptTotal(tierOutcome: AttemptTierOutcome | undefined, pricedAt = NOV_2026, provider = "openai", model = "gpt-6.2-sol") {
  return estimateAttemptCost(attempt(tierOutcome, { provider, model }), undefined, { pricedAt });
}

describe("Ultrafast pricing", () => {
  test("a transmitted Ultrafast tier without an authoritative echo prices at the dated Ultrafast rate, as an estimate", () => {
    expect(attemptTotal(undefined)?.cost.total).toBeCloseTo(0.03, 10);
    const est = attemptTotal(transmitted)!;
    expect(est.cost.total).toBeCloseTo(0.09, 10);
    expect(est.estimated).toBe(true);
    expect(est.serviceTierPricing).toEqual({ tier: "ultrafast", multiplier: 3, basis: "transmitted" });
  });

  test("GPT-6.2 moves from 3x to 6x at the published Pacific-time boundary; GPT-6.1 Sol and GPT-6 Astra stay 6x", () => {
    expect(attemptTotal(transmitted, STEP - 1)?.cost.total).toBeCloseTo(0.09, 10);
    expect(attemptTotal(transmitted, STEP)?.cost.total).toBeCloseTo(0.18, 10);
    expect(attemptTotal(transmitted, NOV_2026, "openai", "gpt-6.1-sol")?.cost.total).toBeCloseTo(0.18, 10);
    // GPT-6 Astra Standard is 10 / 50 / 1.00: 10k fresh, 90k cached and 100 output make $0.195; Ultrafast is 6x.
    expect(attemptTotal(transmitted, NOV_2026, "openai", "gpt-6-astra")?.cost.total).toBeCloseTo(1.17, 10);
  });

  test("an authoritative Standard echo, an explicit refusal or a requested-only tier keeps the Standard price", () => {
    const authoritativeStandard: AttemptTierOutcome = { ...transmitted, responseTierAuthoritative: true };
    const refused: AttemptTierOutcome = { ...transmitted, fastDowngradeReason: "response-declined" };
    const requestedOnly: AttemptTierOutcome = { ...transmitted, wireValue: null };
    for (const outcome of [authoritativeStandard, refused, requestedOnly]) {
      const est = attemptTotal(outcome)!;
      expect(est.cost.total).toBeCloseTo(0.03, 10);
      expect(est.serviceTierPricing).toBeUndefined();
    }
    // A legacy row that only says the caller asked for Ultrafast proves nothing about the wire.
    const legacy = estimateRequestCost({ provider: "openai", model: "gpt-6.2-sol", usage, usageStatus: "reported", serviceTier: { requestedServiceTier: "ultrafast", pricedAt: NOV_2026 } });
    expect(legacy?.cost.total).toBeCloseTo(0.03, 10);
  });

  test("an authoritative Ultrafast echo is confirmed, not estimated", () => {
    const confirmed: AttemptTierOutcome = { ...transmitted, fastOutcome: "unknown", confirmation: "unknown", responseServiceTier: "ultrafast", responseTierAuthoritative: true };
    delete confirmed.fastDowngradeReason;
    const est = attemptTotal(confirmed, NOV_2026, "openai-apikey")!;
    expect(est.cost.total).toBeCloseTo(0.09, 10);
    expect(est.estimated).toBe(false);
    expect(est.serviceTierPricing).toEqual({ tier: "ultrafast", multiplier: 3, basis: "confirmed" });
  });

  test("a mixed route prices each attempt with its own tier evidence", () => {
    const combo = estimateComboCost([
      attempt(transmitted),
      { ...attempt(undefined), ordinal: 2 },
    ], undefined, { pricedAt: NOV_2026 })!;
    expect(combo.attempts!.map(est => Number(est.cost.total.toFixed(6)))).toEqual([0.09, 0.03]);
    expect(combo.cost.total).toBeCloseTo(0.12, 10);
    expect(combo.estimated).toBe(true);
  });

  test("Logs and usage totals price a logged row from its own timestamp", () => {
    const entry = {
      timestamp: NOV_2026, provider: "openai", model: "gpt-6.2-sol", usageStatus: "reported", usage,
      durationMs: 1000, status: 200, tierOutcome: transmitted, requestedServiceTier: "ultrafast",
    } as unknown as PersistedUsageEntry;
    expect(serviceTierContext(entry).pricedAt).toBe(NOV_2026);
    const logs = costResult(entry);
    expect(logs.kind).toBe("value");
    if (logs.kind !== "value") return;
    expect(logs.estimate.cost.total).toBeCloseTo(0.09, 10);
    expect(logs.estimateReasons).toContain("service_tier_transmitted");
    expect(computeEntryCost(entry).costTotal).toBeCloseTo(0.09, 10);
    const later = { ...entry, timestamp: STEP } as PersistedUsageEntry;
    expect(computeEntryCost(later).costTotal).toBeCloseTo(0.18, 10);
  });
  test("an attempt without its own tier record never inherits another attempt's Ultrafast evidence", () => {
    const combo = estimateComboCost([
      attempt(transmitted),
      { ...attempt(undefined), ordinal: 2 },
    ], undefined, { tierOutcome: transmitted, pricedAt: NOV_2026 })!;
    expect(combo.attempts!.map(est => Number(est.cost.total.toFixed(6)))).toEqual([0.09, 0.03]);
    expect(combo.attempts![1]!.serviceTierPricing).toBeUndefined();
  });

  test("expanded Logs attempts price at the row's own date", () => {
    const after = STEP + 24 * 60 * 60 * 1000;
    const entry = {
      requestId: "r", timestamp: after, provider: "openai", model: "gpt-6.2-sol", usageStatus: "reported", usage, durationMs: 1000, status: 200,
      tierOutcome: transmitted,
      attempts: [{ ordinal: 1, provider: "openai", model: "gpt-6.2-sol", usageStatus: "reported", usage, durationMs: 1000, status: 200,
        sendCount: 1, recoveryKinds: [], tierOutcome: transmitted }],
    } as unknown as RequestLogEntry;
    const dto = requestLogDto(entry) as { displayMetrics: { cost: { estimate: { cost: { total: number } } } }; attempts: Array<{ displayMetrics: { cost: { estimate: { cost: { total: number } } } } }> };
    expect(dto.displayMetrics.cost.estimate.cost.total).toBeCloseTo(0.18, 10);
    expect(dto.attempts[0]!.displayMetrics.cost.estimate.cost.total).toBeCloseTo(0.18, 10);
  });
});
