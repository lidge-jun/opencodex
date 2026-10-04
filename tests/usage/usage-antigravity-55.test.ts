import { describe, expect, test } from "bun:test";
import { canonicalAntigravityUsageModel } from "../../src/providers/antigravity-models";
import { estimateRequestCost, resolveMatchedPrice } from "../../src/usage/cost";
import { findExpectedPriceOverlay } from "../../src/usage/expected-prices";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { summarizeUsage } from "../../src/usage/summary";

const families = [
  { base: "claude-sonnet-5-5", cost4: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, total: 0.012 },
  { base: "claude-opus-5-5", cost4: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, total: 0.024 },
];
const now = Date.UTC(2026, 9, 3, 12);

function row(model: string, index: number, resolvedModel?: string): PersistedUsageEntry {
  return {
    requestId: `antigravity-fixture-${index}`, timestamp: now - index,
    provider: "google-antigravity", model, ...(resolvedModel ? { resolvedModel } : {}),
    status: 200, durationMs: 1, usageStatus: "reported",
    usage: { inputTokens: 1000, outputTokens: 100 }, totalTokens: 1100,
  };
}

describe("Antigravity Claude 5.5 usage", () => {
  for (const { base, cost4, total } of families) {
    test(`${base} has deterministic identity and derived reference prices without discovery`, () => {
      for (const id of [base, `${base}-low`, `${base}-medium`, `${base}-high`]) {
        expect(canonicalAntigravityUsageModel(id)).toBe(base);
        expect(findExpectedPriceOverlay("google-antigravity", id)).toMatchObject({
          provider: "google-antigravity", modelId: id, cost4, status: "verified-derived",
        });
        for (const provider of ["google-antigravity", "google-antigravity-pabcdef"]) {
          const price = resolveMatchedPrice(provider, id);
          expect(price).toMatchObject({ cost4, status: "verified-derived", source: "expected" });
          expect(price?.sourceRef).toContain("derived:");
          expect(price?.sourceRef).toContain("platform.claude.com/docs/en/about-claude/pricing");
          const estimate = estimateRequestCost({ provider, model: id, usageStatus: "reported", usage: { inputTokens: 1000, outputTokens: 100 } });
          expect(estimate?.estimated).toBe(true);
          expect(estimate?.cost.total).toBeCloseTo(total / 4, 10);
        }
      }
    });

    test(`${base} aggregates tiers and resolved IDs in model and day summaries`, () => {
      const entries = [row(`${base}-low`, 1), row(`${base}-medium`, 2), row(`${base}-high`, 3), row(base, 4, `${base}-high`)];
      const summary = summarizeUsage(entries, "all", now);
      expect(summary.models).toHaveLength(1);
      expect(summary.models[0]).toMatchObject({ provider: "google-antigravity", model: base, requests: 4, totalTokens: 4400 });
      expect(summary.models[0]?.resolvedModel).toBeUndefined();
      expect(summary.models[0]?.estimatedCostUsd).toBeCloseTo(total, 10);
      const days = summary.days.filter(day => day.requests > 0);
      expect(days).toHaveLength(1);
      expect(days[0]?.models).toHaveLength(1);
      expect(days[0]?.models[0]).toMatchObject({ model: base, requests: 4, totalTokens: 4400 });
      expect(days[0]?.models[0]?.estimatedCostUsd).toBeCloseTo(total, 10);
      expect(summary.summary.estimatedCostUsd).toBeCloseTo(total, 10);
    });
  }

  test("historical Claude and unknown suffixes retain their exact usage identities", () => {
    const ids = ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "claude-sonnet-6-0-high", "claude-sonnet-5-5-ultra"];
    for (const id of ids) expect(canonicalAntigravityUsageModel(id)).toBe(id);
    const summary = summarizeUsage(ids.map((id, i) => row(id, i + 1)), "all", now);
    expect(summary.models.map(model => model.model).sort()).toEqual([...ids].sort());
    expect(resolveMatchedPrice("google-antigravity", "claude-sonnet-4-6")?.cost4)
      .toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(resolveMatchedPrice("google-antigravity", "claude-opus-4-6-thinking")?.cost4)
      .toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });
});
