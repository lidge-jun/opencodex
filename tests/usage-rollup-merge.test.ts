import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { clearApiKeyUsageCacheForTests, readApiKeyUsageRollup, rollupApiKeyUsage } from "../src/server/management/api-key-usage";
import { resetUsageSummaryCacheForTests } from "../src/server/management/usage-summary-cache";
import { readUsageSnapshotForManagement, resetUsageReadCacheForTests, usageLogPath, usageReadCacheStatsForTests, type PersistedUsageEntry } from "../src/usage/log";
import {
  foldUsagePrefix,
  readRollupSnapshot,
  resetRollupForTests,
  type RollupDayRow,
  type RollupModelRow,
  type RollupProviderRow,
  type RollupSurfaceKey,
} from "../src/usage/rollup";
import { localDateKey, summarizeUsage, type RollupContribution, type UsageSummary } from "../src/usage/summary";
import type { OcxConfig } from "../src/types";
import { generateRandomizedUsageRollupFixture } from "./helpers/usage-rollup-fixtures";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { managementFetch } from "./helpers/management-auth";

const DAY_MS = 86_400_000;
const FIXED_NOW = Date.UTC(2026, 7, 4, 12);

let testDir = "";
let previousHome: string | undefined;
let previousTimezone: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let clock: ReturnType<typeof spyOn>;

interface UsageRouteBody {
  summary: { requests: number };
  historyTruncated: boolean;
  truncatedPrefixBytes: number;
}

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
    },
    ...overrides,
  } as OcxConfig;
}

function entry(overrides: Partial<PersistedUsageEntry> & { requestId: string; timestamp: number }): PersistedUsageEntry {
  return {
    provider: "openai", model: "gpt-5.5", status: 200, durationMs: 1,
    usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 2 }, totalTokens: 12,
    ...overrides,
  };
}

function rawLine(value: PersistedUsageEntry): string {
  return `${JSON.stringify(value)}\n`;
}

function writeRaw(entries: PersistedUsageEntry[]): void {
  writeFileSync(usageLogPath(), entries.map(rawLine).join(""), { mode: 0o600 });
}

function dayRow(date: string, surface: RollupSurfaceKey, requests = 1, tokens = 10): RollupDayRow {
  return {
    kind: "day", seg: 0, attemptId: "test", date, surface,
    statusCounts: { reported: requests, unreported: 0, unsupported: 0, estimated: 0 },
    attemptCount: requests,
    tokens: {
      inputTokens: tokens - 2 * requests, outputTokens: 2 * requests,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
      totalTokens: tokens,
    },
    estimatedCostUsd: tokens / 1_000_000,
    pricedRequests: requests, unpricedRequests: 0, unmeteredRequests: 0,
  };
}

function modelRow(date: string, surface: RollupSurfaceKey, provider = "openai", model = "gpt-5.5", requests = 1, tokens = 10): RollupModelRow {
  return {
    kind: "model", seg: 0, attemptId: "test", date, surface, provider, model,
    requests, attemptCount: requests,
    foldedStatusCounts: { reported: requests, unreported: 0, unsupported: 0, estimated: 0 },
    tokens: { inputTokens: tokens - 2 * requests, outputTokens: 2 * requests, totalTokens: tokens },
    estimatedCostUsd: tokens / 1_000_000,
  };
}

function providerRow(date: string, surface: RollupSurfaceKey, provider = "openai", requests = 1, tokens = 10): RollupProviderRow {
  return {
    kind: "provider", seg: 0, attemptId: "test", date, surface, provider,
    requests, attemptCount: requests,
    foldedStatusCounts: { reported: requests, unreported: 0, unsupported: 0, estimated: 0 },
    totalTokens: tokens, estimatedCostUsd: tokens / 1_000_000,
  };
}

function contribution(
  days: RollupDayRow[],
  models: RollupModelRow[],
  providers: RollupProviderRow[],
  oldestTimestampMs: number | null,
): RollupContribution {
  return { days, models, providers, oldestTimestampMs };
}

function canonicalSummary(summary: UsageSummary): unknown {
  const canonicalModels = summary.models.map(row => ({ ...row, estimatedCostUsd: row.estimatedCostUsd ?? 0 }))
    .sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  const canonicalProviders = summary.providers.map(row => ({ ...row, estimatedCostUsd: row.estimatedCostUsd ?? 0 }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
  const days = summary.days.map(day => ({
    ...day,
    models: [...day.models].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)),
  }));
  return { summary: summary.summary, days, models: canonicalModels, providers: canonicalProviders };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousTimezone = process.env.TZ;
  isolatedCodexHome = installIsolatedCodexHome("ocx-rollup-merge-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-rollup-merge-"));
  process.env.OPENCODEX_HOME = testDir;
  clock = spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  resetRollupForTests();
  resetUsageReadCacheForTests();
  resetUsageSummaryCacheForTests();
  clearApiKeyUsageCacheForTests();
  saveConfig(baseConfig());
});

afterEach(() => {
  clock.mockRestore();
  resetRollupForTests();
  resetUsageReadCacheForTests();
  resetUsageSummaryCacheForTests();
  clearApiKeyUsageCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimezone;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("usage rollup reader merge", () => {
  test("1. randomized in-domain fold plus tail equals the full raw summary for all", async () => {
    const fixture = generateRandomizedUsageRollupFixture(0x020, FIXED_NOW, 120);
    const generated = fixture.entries.filter(row => row.requestId !== fixture.duplicateRequestId);
    const entries = generated.map((row, index) => {
      const ageDays = index < 80 ? 10 + (index * 17) % 31 : (index * 5) % 9;
      const timeOfDay = (index * 37_001) % DAY_MS;
      return { ...row, timestamp: FIXED_NOW - ageDays * DAY_MS - timeOfDay };
    });
    writeRaw(entries);
    await foldUsagePrefix();
    const folded = readRollupSnapshot();
    expect(folded).not.toBeNull();
    expect(folded!.cutlineOffset).toBeGreaterThan(0);
    expect(folded!.cutlineOffset).toBeLessThan(readFileSync(usageLogPath()).byteLength);
    const tail = await readUsageSnapshotForManagement(Number.MAX_SAFE_INTEGER, folded!.cutlineOffset);
    expect(tail.truncatedPrefixBytes).toBe(0);

    const merged = summarizeUsage(tail.entries, "all", FIXED_NOW, "all", {
      days: folded!.days,
      models: folded!.models,
      providers: folded!.providers,
      oldestTimestampMs: folded!.oldestTimestampMs,
    });
    const full = summarizeUsage(entries, "all", FIXED_NOW);
    const mergedCanonical = canonicalSummary(merged) as { summary: UsageSummary["summary"] };
    const fullCanonical = canonicalSummary(full) as { summary: UsageSummary["summary"] };
    expect(mergedCanonical.summary.estimatedCostUsd).toBeCloseTo(fullCanonical.summary.estimatedCostUsd, 9);
    const mergedWithoutCost = structuredClone(mergedCanonical);
    const fullWithoutCost = structuredClone(fullCanonical);
    mergedWithoutCost.summary.estimatedCostUsd = 0;
    fullWithoutCost.summary.estimatedCostUsd = 0;
    for (const row of (mergedWithoutCost as { models: Array<{ estimatedCostUsd: number }> }).models) row.estimatedCostUsd = 0;
    for (const row of (fullWithoutCost as { models: Array<{ estimatedCostUsd: number }> }).models) row.estimatedCostUsd = 0;
    for (const row of (mergedWithoutCost as { providers: Array<{ estimatedCostUsd: number }> }).providers) row.estimatedCostUsd = 0;
    for (const row of (fullWithoutCost as { providers: Array<{ estimatedCostUsd: number }> }).providers) row.estimatedCostUsd = 0;
    expect(mergedWithoutCost).toEqual(fullWithoutCost);
    for (const row of merged.models) {
      const expected = full.models.find(candidate => candidate.provider === row.provider && candidate.model === row.model);
      expect(row.estimatedCostUsd ?? 0).toBeCloseTo(expected?.estimatedCostUsd ?? 0, 9);
    }
    for (const row of merged.providers) {
      const expected = full.providers.find(candidate => candidate.provider === row.provider);
      expect(row.estimatedCostUsd ?? 0).toBeCloseTo(expected?.estimatedCostUsd ?? 0, 9);
    }
  });

  test("2. rollup and tail rows on the same boundary date merge additively", () => {
    const date = localDateKey(FIXED_NOW - 10 * DAY_MS);
    const tail = entry({
      requestId: "tail-boundary", timestamp: new Date(`${date}T18:00:00`).getTime(),
      usage: { inputTokens: 3, outputTokens: 2 }, totalTokens: 5,
    });
    const merged = summarizeUsage([tail], "all", FIXED_NOW, "all", contribution(
      [dayRow(date, "codex", 1, 10)],
      [modelRow(date, "codex", "openai", "gpt-5.5", 1, 10)],
      [providerRow(date, "codex", "openai", 1, 10)],
      FIXED_NOW - 10 * DAY_MS,
    ));
    expect(merged.summary).toMatchObject({ requests: 2, attemptCount: 2, totalTokens: 15 });
    expect(merged.days.find(row => row.date === date)).toMatchObject({ requests: 2, totalTokens: 15 });
    expect(merged.days.find(row => row.date === date)?.models).toEqual([
      expect.objectContaining({ provider: "openai", model: "gpt-5.5", requests: 2, attemptCount: 2, totalTokens: 15 }),
    ]);
    expect(merged.models).toEqual([expect.objectContaining({ requests: 2, attemptCount: 2, totalTokens: 15 })]);
    expect(merged.providers).toEqual([expect.objectContaining({ requests: 2, attemptCount: 2, totalTokens: 15 })]);
  });

  test("3. surface predicates keep codex disjoint and combine claude with claude-desktop", () => {
    const date = localDateKey(FIXED_NOW - 12 * DAY_MS);
    const surfaces: RollupSurfaceKey[] = ["codex", "claude", "claude-desktop", "grok"];
    const rolled = contribution(
      surfaces.map(surface => dayRow(date, surface)),
      surfaces.map(surface => modelRow(date, surface, surface === "codex" ? "openai" : surface, `${surface}-model`)),
      surfaces.map(surface => providerRow(date, surface, surface === "codex" ? "openai" : surface)),
      FIXED_NOW - 12 * DAY_MS,
    );
    const claude = summarizeUsage([], "all", FIXED_NOW, "claude", rolled);
    expect(claude.summary.requests).toBe(2);
    expect(claude.models.map(row => row.model).sort()).toEqual(["claude-desktop-model", "claude-model"]);
    const codex = summarizeUsage([], "all", FIXED_NOW, "codex", rolled);
    expect(codex.summary.requests).toBe(1);
    expect(codex.models.map(row => row.model)).toEqual(["codex-model"]);
    const grok = summarizeUsage([], "all", FIXED_NOW, "grok", rolled);
    expect(grok.summary.requests).toBe(1);
    expect(grok.providers.map(row => row.provider)).toEqual(["grok"]);
  });

  test("4. seven-day summaries stay tail-only while thirty-day summaries include whole overlapping days", () => {
    process.env.TZ = "America/New_York";
    const localNow = new Date(2026, 7, 4, 12).getTime();
    clock.mockReturnValue(localNow);
    const since30 = localNow - 30 * DAY_MS;
    const boundaryDate = localDateKey(since30);
    const insideDate = localDateKey(localNow - 10 * DAY_MS);
    const outsideDate = localDateKey(localNow - 31 * DAY_MS);
    const rows = [dayRow(boundaryDate, "codex"), dayRow(insideDate, "codex"), dayRow(outsideDate, "codex")];
    const models = [modelRow(boundaryDate, "codex"), modelRow(insideDate, "codex"), modelRow(outsideDate, "codex")];
    const providers = [providerRow(boundaryDate, "codex"), providerRow(insideDate, "codex"), providerRow(outsideDate, "codex")];
    const recent = entry({ requestId: "recent", timestamp: localNow - DAY_MS });
    const outOfOrderTail = [recent, entry({ requestId: "tail-older", timestamp: localNow - 6 * DAY_MS })];
    const rolled = contribution(rows, models, providers, localNow - 31 * DAY_MS);

    const seven = summarizeUsage(outOfOrderTail, "7d", localNow, "all", rolled);
    expect(seven.summary.requests).toBe(2);
    expect(seven.days.some(day => day.date === insideDate && day.requests > 0)).toBe(false);
    const thirty = summarizeUsage(outOfOrderTail, "30d", localNow, "all", rolled);
    expect(thirty.summary.requests).toBe(4);
    expect(thirty.days.find(day => day.date === boundaryDate)?.requests).toBe(1);
    expect(thirty.days.find(day => day.date === insideDate)?.requests).toBe(1);
    expect(thirty.days.some(day => day.date === outsideDate && day.requests > 0)).toBe(false);
  });

  test("5. route cache invalidates on cutline advance and flag-off keeps the legacy truncated path", async () => {
    saveConfig(baseConfig({ managementUsageMaxReadBytes: 300, usageRollupEnabled: true }));
    const firstOld = entry({ requestId: "old-1", timestamp: FIXED_NOW - 13 * DAY_MS });
    writeRaw([firstOld]);
    await foldUsagePrefix();
    appendFileSync(usageLogPath(), rawLine(entry({ requestId: "old-2", timestamp: FIXED_NOW - 12 * DAY_MS })));
    const server = startServer(0);
    try {
      const beforeFold = await managementFetch(new URL("/api/usage?range=all", server.url)).then(response => response.json()) as UsageRouteBody;
      expect(beforeFold.summary.requests).toBe(2);
      const readsBefore = usageReadCacheStatsForTests().fullReads;
      const metaPath = join(getConfigDir(), "usage-rollup-meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      writeFileSync(metaPath, `${JSON.stringify({ ...meta, lastFoldAttemptAt: 0 })}\n`);
      await foldUsagePrefix();
      const afterFold = await managementFetch(new URL("/api/usage?range=all", server.url)).then(response => response.json()) as UsageRouteBody;
      expect(afterFold.summary.requests).toBe(2);
      expect(afterFold.historyTruncated).toBe(false);
      expect(afterFold.truncatedPrefixBytes).toBe(0);
      expect(usageReadCacheStatsForTests().fullReads).toBe(readsBefore + 1);
      expect(readFileSync(usageLogPath()).byteLength).toBeGreaterThan(300);
    } finally {
      await server.stop(true);
    }

    resetUsageSummaryCacheForTests();
    resetUsageReadCacheForTests();
    const primaryDir = testDir;
    const legacyDir = mkdtempSync(join(tmpdir(), "ocx-rollup-legacy-"));
    process.env.OPENCODEX_HOME = legacyDir;
    saveConfig(baseConfig({ managementUsageMaxReadBytes: 300, usageRollupEnabled: false }));
    writeRaw([firstOld, entry({ requestId: "old-2", timestamp: FIXED_NOW - 12 * DAY_MS })]);
    const legacyServer = startServer(0);
    try {
      const legacy = await managementFetch(new URL("/api/usage?range=all", legacyServer.url)).then(response => response.json()) as UsageRouteBody;
      expect(legacy.historyTruncated).toBe(true);
      expect(legacy.truncatedPrefixBytes).toBeGreaterThan(0);
    } finally {
      await legacyServer.stop(true);
      process.env.OPENCODEX_HOME = primaryDir;
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  test("6. API-key totals and attribution merge across the fold boundary while requests7d stays tail-exact", async () => {
    const entries = [
      entry({ requestId: "key-old", timestamp: FIXED_NOW - 15 * DAY_MS, admissionKind: "configured", apiKeyId: "key-a" }),
      entry({ requestId: "key-recent", timestamp: FIXED_NOW - 2 * DAY_MS, admissionKind: "configured", apiKeyId: "key-a" }),
      entry({ requestId: "loopback", timestamp: FIXED_NOW - DAY_MS, admissionKind: "loopback", apiKeyId: undefined }),
    ];
    writeRaw(entries);
    await foldUsagePrefix();
    const folded = readRollupSnapshot()!;
    expect(folded.cutlineOffset).toBeGreaterThan(0);
    const merged = await readApiKeyUsageRollup(["key-a"], 64 * 1024 * 1024);
    const reference = rollupApiKeyUsage(entries, ["key-a"], FIXED_NOW);
    expect(merged.rollup.get("key-a")).toEqual(reference.rollup.get("key-a"));
    expect(merged.attributionSince).toBe(reference.attributionSince);
    expect(merged.historyTruncated).toBeUndefined();
    expect(merged.rollup.get("key-a")).toMatchObject({ totalRequests: 2, requests7d: 1 });
  });

  test("7. disabling the rollup makes API-key summaries fall back to the raw tail only", async () => {
    const entries = [
      entry({ requestId: "old-folded", timestamp: FIXED_NOW - 15 * DAY_MS, admissionKind: "configured", apiKeyId: "key-a" }),
      entry({ requestId: "recent-raw", timestamp: FIXED_NOW - 2 * DAY_MS, admissionKind: "configured", apiKeyId: "key-a" }),
    ];
    writeRaw(entries);
    await foldUsagePrefix();
    const cutline = readRollupSnapshot()!.cutlineOffset;
    expect(cutline).toBeGreaterThan(0);

    clearApiKeyUsageCacheForTests();
    const withRollup = await readApiKeyUsageRollup(["key-a"], 64 * 1024 * 1024, true);
    expect(withRollup.rollup.get("key-a")).toMatchObject({ totalRequests: 2 });

    clearApiKeyUsageCacheForTests();
    // Constrain the raw read so the folded prefix cannot be re-read from raw:
    // with the rollup DISABLED the sidecar must contribute nothing, so only the
    // raw entry that fits in the read window is counted.
    const tailBytes = statSync(usageLogPath()).size - cutline;
    const withoutRollup = await readApiKeyUsageRollup(["key-a"], tailBytes, false);
    expect(withoutRollup.rollup.get("key-a")).toMatchObject({ totalRequests: 1 });
    expect(withoutRollup.historyTruncated).toBe(true);
  });
});
