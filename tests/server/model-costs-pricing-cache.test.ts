import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { startServer } from "../../src/server";
import { getFilteredUsageAggregate, getUsageAggregate, resetUsageAggregateCacheForTests } from "../../src/server/management/usage-aggregate-cache";
import { getUsageSummaryCacheEntry, resetUsageSummaryCacheForTests } from "../../src/server/management/usage-summary-cache";
import type { OcxConfig, PromptLengthPricing } from "../../src/types";
import { estimateRequestCost } from "../../src/usage/cost";
import { currentUsageLogRevision, resetUsageReadCacheForTests, type PersistedUsageEntry, type UsageLogRevision } from "../../src/usage/log";
import { refreshUserCostOverlays, resetPreservedDiskOnlyProvidersForTests, userCostOverlayVersion } from "../../src/usage/user-cost-overlays";
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
    // On Windows startServer's loadConfig starts an unawaited directory ACL harden whose
    // inherited-ACE rewrite moves usage.jsonl's ChangeTime; the aggregate cache then rightly
    // rebuilds. Settle it before asserting warm-cache reuse.
    await flushConfigDirHardeningAndReaps(home);
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
    // Every input the warm aggregate compares, so a Windows-only "rebuild" names what moved. The
    // comparison base is what the previous stage's refresh recorded, so that is reported too.
    const aggregateInputs = () => ({ revision: currentUsageLogRevision(), overlayVersion: userCostOverlayVersion(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const recorded = (result: { revision: unknown; overlayVersion: number; timeZone: string }) =>
      ({ revision: result.revision, overlayVersion: result.overlayVersion, timeZone: result.timeZone });
    const ledgerCtime = () => currentUsageLogRevision()?.ctimeMs ?? null;
    const withoutCtime = (revision: UsageLogRevision | null) => {
      if (!revision) return revision;
      const { ctimeMs: _ctimeMs, ...rest } = revision;
      return rest;
    };
    let prevBase: unknown = null;
    for (const [stage, { policy, total }] of stages.entries()) {
      const inputsAtStageStart = aggregateInputs();
      const estimateBefore = estimateRequestCost(INPUT)!;
      expect(estimateBefore.cost.total).toBeCloseTo(previousTotal, 12);
      expect(estimateRequestCost(INPUT)?.price).toBe(estimateBefore.price);
      const before = await summarize();
      const summaryCache = getUsageSummaryCacheEntry("all:all")!;
      expect(before.summary.estimatedCostUsd).toBeCloseTo(previousTotal, 12);
      expect((await summarize()).summary).toEqual(before.summary);
      expect(getUsageSummaryCacheEntry("all:all")).toBe(summaryCache);
      const inputsBefore = aggregateInputs();
      const aggregate = await getUsageAggregate({ now });
      expect(aggregate.update, JSON.stringify({ stage, prevBase, stageStart: inputsAtStageStart, beforeRead: inputsBefore,
        afterRead: aggregateInputs(), rebuiltTo: recorded(aggregate) })).toBe("unchanged");
      expect((await getUsageAggregate({ now })).accumulator).toBe(aggregate.accumulator);
      const filtered = await getFilteredUsageAggregate({ provider: INPUT.provider });
      const filteredAgain = await getFilteredUsageAggregate({ provider: INPUT.provider });
      expect(filteredAgain.update, JSON.stringify({ stage, filteredBase: recorded(filtered), now: aggregateInputs(),
        rebuiltTo: recorded(filteredAgain) })).toBe("unchanged");
      expect(filtered.accumulator.summarize("all", now).summary.estimatedCostUsd).toBeCloseTo(previousTotal, 12);

      await writePolicy(policy);
      const ctimeAfterWrite = ledgerCtime();

      const estimateAfter = estimateRequestCost(INPUT)!;
      expect(estimateAfter.price).not.toBe(estimateBefore.price);
      expect(estimateAfter.cost.total).toBeCloseTo(total, 12);
      const changed = await summarize();
      expect(changed.summary.requests).toBe(1);
      expect(changed.summary.estimatedCostUsd).toBeCloseTo(total, 12);
      expect(changed.models[0].estimatedCostUsd).toBeCloseTo(total, 12);
      expect(getUsageSummaryCacheEntry("all:all")).not.toBe(summaryCache);
      const ctimeAfterSummary = ledgerCtime();
      const refreshedAggregate = await getUsageAggregate({ now });
      expect(refreshedAggregate.accumulator).not.toBe(aggregate.accumulator);
      expect(refreshedAggregate.accumulator.summarize("all", now).summary.estimatedCostUsd).toBeCloseTo(total, 12);
      const refreshedFiltered = await getFilteredUsageAggregate({ provider: INPUT.provider });
      expect(refreshedFiltered.update, JSON.stringify({ stage, filteredBase: recorded(filtered), now: aggregateInputs() }))
        .toBe("rebuild");
      expect(refreshedFiltered.accumulator).not.toBe(filtered.accumulator);
      expect(refreshedFiltered.accumulator.summarize("all", now).summary.estimatedCostUsd).toBeCloseTo(total, 12);
      const ctimeAfterFiltered = ledgerCtime();
      expect(readFileSync(ledgerPath, "utf8")).toBe(ledger);
      // The next stage's warm read is compared with the base read here, after all of this
      // stage's work. On Windows something in the stage tail moved usage.jsonl's ChangeTime
      // alone (batch 42694893702, stage 2), after refreshedAggregate had recorded its revision;
      // a directory ACL operation is the suspected mover, but no Windows trace has named it.
      // The revision key counts ChangeTime on purpose, so that read rebuilds. Only that move is
      // tolerated, only on Windows, and the ChangeTime after each step is logged to name it.
      const settled = await getUsageAggregate({ now });
      if (settled.update !== "unchanged") {
        const moved = JSON.stringify({ stage, update: settled.update, from: recorded(refreshedAggregate),
          to: recorded(settled), ctime: { afterWrite: ctimeAfterWrite, afterSummary: ctimeAfterSummary,
            refreshed: refreshedAggregate.revision?.ctimeMs ?? null, afterFiltered: ctimeAfterFiltered } });
        expect(process.platform, moved).toBe("win32");
        expect(settled.update, moved).toBe("rebuild");
        expect(settled.revision && refreshedAggregate.revision, moved).toBeTruthy();
        expect(settled.revision?.ctimeMs, moved).not.toBe(refreshedAggregate.revision?.ctimeMs);
        expect(withoutCtime(settled.revision), moved).toEqual(withoutCtime(refreshedAggregate.revision));
        expect(settled.overlayVersion, moved).toBe(refreshedAggregate.overlayVersion);
        expect(settled.timeZone, moved).toBe(refreshedAggregate.timeZone);
        console.warn(`[model-costs-pricing-cache] usage.jsonl ChangeTime moved within a stage: ${moved}`);
      }
      expect(settled.accumulator.summarize("all", now).summary.estimatedCostUsd).toBeCloseTo(total, 12);
      prevBase = recorded(settled);
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
