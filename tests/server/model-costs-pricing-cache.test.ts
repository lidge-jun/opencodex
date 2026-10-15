import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { getFilteredUsageAggregate, getUsageAggregate, resetUsageAggregateCacheForTests } from "../../src/server/management/usage-aggregate-cache";
import { getUsageSummaryCacheEntry, resetUsageSummaryCacheForTests } from "../../src/server/management/usage-summary-cache";
import type { OcxConfig, PromptLengthPricing } from "../../src/types";
import { estimateRequestCost } from "../../src/usage/cost";
import { resetUsageReadCacheForTests, type PersistedUsageEntry } from "../../src/usage/log";
import { refreshUserCostOverlays, resetPreservedDiskOnlyProvidersForTests } from "../../src/usage/user-cost-overlays";
import { stopUserCostOverlayReconciler } from "../../src/usage/user-cost-overlay-reconciler";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { managementFetch } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MODEL = "gpt-6-astra";
const BASE = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 };
const ABOVE = { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 1.5 };
const INPUT = { provider: "openai", model: MODEL, usageStatus: "reported" as const,
  usage: { inputTokens: 280_000, outputTokens: 1_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 10_000 } };
let home: string;
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-pricing-cache-"));
  process.env.OPENCODEX_HOME = home;
  isolatedCodexHome = installIsolatedCodexHome("ocx-pricing-cache-codex-");
  resetUsageReadCacheForTests();
  resetUsageSummaryCacheForTests();
  resetUsageAggregateCacheForTests();
  resetPreservedDiskOnlyProvidersForTests();
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "openai", providers: {
    openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
  } } satisfies OcxConfig);
});

afterEach(() => {
  stopUserCostOverlayReconciler();
  resetUsageReadCacheForTests();
  resetUsageSummaryCacheForTests();
  resetUsageAggregateCacheForTests();
  resetPreservedDiskOnlyProvidersForTests();
  refreshUserCostOverlays({ providers: {} } as OcxConfig);
  isolatedCodexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

test("policy-only API writes refresh warm estimate, summary and aggregate caches; reset restores catalog", async () => {
  const now = Date.now();
  const entry: PersistedUsageEntry = { requestId: "fixed-pricing-cache-row", timestamp: now - 1000,
    ...INPUT, status: 200, durationMs: 10, totalTokens: 281_000 };
  const ledgerPath = join(home, "usage.jsonl");
  const ledger = `${JSON.stringify(entry)}\n`;
  writeFileSync(ledgerPath, ledger);
  const server = startServer(0);
  try {
    const summaryUrl = new URL("/api/usage?range=all", server.url);
    const priceUrl = new URL("/api/providers/openai/model-costs", server.url);
    const summarize = async () => {
      const response = await managementFetch(summaryUrl);
      expect(response.status).toBe(200);
      return response.json();
    };
    const writePolicy = async (policy: PromptLengthPricing | null) => {
      const cost = policy === null ? null : { ...BASE, promptLengthPricing: policy };
      const response = await managementFetch(priceUrl, { method: "PUT",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelId: MODEL, cost }) });
      expect(response.status).toBe(200);
      expect((await response.json()).cost).toEqual(policy?.mode === "automatic" ? BASE : cost);
    };

    // Defaults use the real memo path: no injected overlay arrays or mocked cache reads.
    const catalog = estimateRequestCost(INPUT)!;
    expect(catalog.cost.total).toBeCloseTo(5.365, 12);
    expect(catalog.price?.source).not.toBe("user");
    expect(catalog.contextTier).toBe("long");
    expect(estimateRequestCost(INPUT)?.price).toBe(catalog.price);
    expect((await summarize()).summary.estimatedCostUsd).toBeCloseTo(catalog.cost.total, 12);

    const custom = (thresholdTokens: number, comparison: "gt" | "gte", rates = ABOVE): PromptLengthPricing =>
      ({ mode: "custom", thresholdTokens, comparison, rates });
    await writePolicy(custom(300_000, "gt"));

    // Each step changes just one policy dimension; every base rate stays fixed.
    const stages: Array<{ policy: PromptLengthPricing | null; total: number }> = [
      { policy: custom(279_999, "gt"), total: 0.777 },
      { policy: custom(280_000, "gt"), total: 0.259 },
      { policy: custom(280_000, "gte"), total: 0.777 },
      { policy: custom(280_000, "gte", { ...ABOVE, input: 4 }), total: 1.027 },
      { policy: custom(280_000, "gte", { ...ABOVE, input: 4, output: 8 }), total: 1.029 },
      { policy: custom(280_000, "gte", { ...ABOVE, input: 4, output: 8, cacheRead: 0.4 }), total: 1.031 },
      { policy: custom(280_000, "gte", { input: 4, output: 8, cacheRead: 0.4, cacheWrite: 2 }), total: 1.036 },
      { policy: { mode: "flat" }, total: 0.259 },
      { policy: { mode: "automatic" }, total: 0.517 },
      { policy: null, total: catalog.cost.total },
    ];
    let previousTotal = 0.259;
    for (const { policy, total } of stages) {
      const estimateBefore = estimateRequestCost(INPUT)!;
      expect(estimateBefore.cost.total).toBeCloseTo(previousTotal, 12);
      expect(estimateRequestCost(INPUT)?.price).toBe(estimateBefore.price);
      const before = await summarize();
      const summaryCache = getUsageSummaryCacheEntry("all:all")!;
      expect(before.summary.estimatedCostUsd).toBeCloseTo(previousTotal, 12);
      expect((await summarize()).summary).toEqual(before.summary);
      expect(getUsageSummaryCacheEntry("all:all")).toBe(summaryCache);
      const aggregate = await getUsageAggregate({ now });
      expect(aggregate.update).toBe("unchanged");
      expect((await getUsageAggregate({ now })).accumulator).toBe(aggregate.accumulator);
      const filtered = await getFilteredUsageAggregate({ provider: INPUT.provider });
      expect((await getFilteredUsageAggregate({ provider: INPUT.provider })).update).toBe("unchanged");
      expect(filtered.accumulator.summarize("all", now).summary.estimatedCostUsd).toBeCloseTo(previousTotal, 12);

      await writePolicy(policy);

      const estimateAfter = estimateRequestCost(INPUT)!;
      expect(estimateAfter.price).not.toBe(estimateBefore.price);
      expect(estimateAfter.cost.total).toBeCloseTo(total, 12);
      const changed = await summarize();
      expect(changed.summary.requests).toBe(1);
      expect(changed.summary.estimatedCostUsd).toBeCloseTo(total, 12);
      expect(changed.models[0].estimatedCostUsd).toBeCloseTo(total, 12);
      expect(getUsageSummaryCacheEntry("all:all")).not.toBe(summaryCache);
      const refreshedAggregate = await getUsageAggregate({ now });
      expect(refreshedAggregate.accumulator).not.toBe(aggregate.accumulator);
      expect(refreshedAggregate.accumulator.summarize("all", now).summary.estimatedCostUsd).toBeCloseTo(total, 12);
      const refreshedFiltered = await getFilteredUsageAggregate({ provider: INPUT.provider });
      expect(refreshedFiltered.update).toBe("rebuild");
      expect(refreshedFiltered.accumulator).not.toBe(filtered.accumulator);
      expect(refreshedFiltered.accumulator.summarize("all", now).summary.estimatedCostUsd).toBeCloseTo(total, 12);
      expect(readFileSync(ledgerPath, "utf8")).toBe(ledger);
      previousTotal = total;
    }
    const reset = estimateRequestCost(INPUT)!;
    expect(reset.price?.source).toBe(catalog.price?.source);
    expect(reset.price?.cost4).toEqual(catalog.price?.cost4);
    expect(reset.cost).toEqual(catalog.cost);
    expect(reset.contextTier).toBe("long");
    expect((await (await managementFetch(priceUrl)).json()).modelCosts).toEqual({});
  } finally { await server.stop(true); }
}, 15_000);
