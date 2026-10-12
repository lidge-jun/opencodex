import { expect, test } from "bun:test";
import { baseProviderLabel, canonicalUsageProviderLabel, poolAccountProviderLabel } from "../../src/providers/label";
import { summarizeUsage, projectUsageSummary } from "../../src/usage/summary";
import { createTimelineAccumulator, parseTimelineQuery } from "../../src/usage/timeline";
import { resolveMatchedPrice } from "../../src/usage/cost";
import { EXPECTED_PRICE_OVERLAYS, type ExpectedPriceOverlay } from "../../src/usage/expected-prices";
import type { PersistedUsageEntry } from "../../src/usage/log";
const now = 1_700_000_000_000;
const model = "claude-opus-5";
const rows: PersistedUsageEntry[] = ["anthropic", "anthropic2"].map((provider, index) => ({ requestId: provider, timestamp: now - 60_000, provider: provider + "-p123abc", model, status: 200, durationMs: 10, usageStatus: "reported", usage: { inputTokens: 10 * (index + 1), outputTokens: 2 }, totalTokens: 12 + 10 * index }));
test("equal account suffixes preserve provider attribution and filters", () => {
  expect(baseProviderLabel("anthropic2-p123abc")).toBe("anthropic2");
  expect(canonicalUsageProviderLabel("anthropic2")).toBe("anthropic2");
  expect(poolAccountProviderLabel("anthropic2-p123abc", "anthropic")).toBeUndefined();
  const summary = summarizeUsage(rows, "all", now);
  expect(summary.providers.map(row => row.provider).sort()).toEqual(["anthropic", "anthropic2"]);
  expect(summary.models.map(row => row.provider).sort()).toEqual(["anthropic", "anthropic2"]);
  const b = projectUsageSummary(summary, { provider: "anthropic2" }, rows);
  expect(b.summary.requests).toBe(1);
  expect(b.models.map(row => row.provider)).toEqual(["anthropic2"]);
});
test("timeline model and account groups keep B separate and hide only selected pool", () => {
  for (const grouping of ["model", "modelAccount"]) {
    const query = parseTimelineQuery(new URLSearchParams({ grouping }), now);
    if ("error" in query) throw new Error(query.error);
    const acc = createTimelineAccumulator(query); rows.forEach(row => acc.add(row));
    const result = acc.finish();
    expect(result.series.map(row => row.provider).sort()).toEqual(["anthropic", "anthropic2"]);
    expect(new Set(result.series.map(row => row.id)).size).toBe(2);
  }
  const query = parseTimelineQuery(new URLSearchParams({ hiddenProvider: "anthropic" }), now);
  if ("error" in query) throw new Error(query.error);
  const acc = createTimelineAccumulator(query); rows.forEach(row => acc.add(row));
  expect(acc.finish().series.map(row => row.provider)).toEqual(["anthropic2"]);
});
test("bundled family prices share rates while user overrides stay per instance", () => {
  const a = resolveMatchedPrice("anthropic", model, EXPECTED_PRICE_OVERLAYS, []);
  const b = resolveMatchedPrice("anthropic2", model, EXPECTED_PRICE_OVERLAYS, []);
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  expect(b!.provider).toBe("anthropic2"); expect(b!.cost4).toEqual(a!.cost4);
  const overlay = (provider: string, rate: number): ExpectedPriceOverlay => ({ provider, modelId: model, cost4: { input: rate, output: rate, cacheRead: rate, cacheWrite: rate }, source: "fixture", verifiedAt: "2026-10-08", status: "verified" });
  const user = [overlay("anthropic", 77), overlay("anthropic2", 0)];
  expect(resolveMatchedPrice("anthropic", model, EXPECTED_PRICE_OVERLAYS, user)!.cost4.input).toBe(77);
  expect(resolveMatchedPrice("anthropic2", model, EXPECTED_PRICE_OVERLAYS, user)!.cost4.input).toBe(0);
  const onlyA = resolveMatchedPrice("anthropic2", model, EXPECTED_PRICE_OVERLAYS, [user[0]!]);
  expect(onlyA!.source).not.toBe("user"); expect(onlyA!.cost4).toEqual(b!.cost4);
});
