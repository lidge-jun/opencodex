import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES,
  configureAppOwnedMemoryBudget,
  enforceAppOwnedMemoryBudget,
  registerRetainedStore,
  resetAppOwnedMemoryForTests,
} from "../src/lib/app-owned-memory";
import { APP_OWNED_RETAINED_STORE_REGISTRATIONS } from "../src/lib/app-owned-memory-stores";
import {
  getFilteredUsageAggregate,
  getUsageAggregate,
  resetUsageAggregateCacheForTests,
  usageAggregateRetainedStats,
  type UsageAggregateResult,
} from "../src/server/management/usage-aggregate-cache";
import type { OcxConfig } from "../src/types/config";
import { resetUsageReadCacheForTests, type PersistedUsageEntry } from "../src/usage/log";
import * as usageLedgerScannerModule from "../src/usage/ledger-scanner";
import { refreshUserCostOverlays } from "../src/usage/user-cost-overlays";

const NOW = Date.parse("2026-09-01T10:00:00.000Z");

let testDir = "";
let previousHome: string | undefined;

function entry(requestId: string): PersistedUsageEntry {
  return {
    requestId,
    timestamp: NOW - 1_000,
    provider: "openai",
    model: "gpt-5.5",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage: { inputTokens: 1, outputTokens: 1 },
    totalTokens: 2,
  };
}

function line(requestId: string): string {
  return `${JSON.stringify(entry(requestId))}\n`;
}

function requests(result: UsageAggregateResult): number {
  return result.accumulator.summarize("all", NOW).summary.requests;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-aggregate-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageAggregateCacheForTests();
  resetUsageReadCacheForTests();
  resetAppOwnedMemoryForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
});

afterEach(() => {
  resetUsageAggregateCacheForTests();
  resetUsageReadCacheForTests();
  resetAppOwnedMemoryForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("retained usage aggregate cache", () => {
  test("settled filtered callers reuse a bounded retained aggregate", async () => {
    writeFileSync(join(testDir, "usage.jsonl"), `${line("one")}${line("two")}`);
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    let scans = 0;
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        scans += 1;
        return originalScan(options);
      });
    try {
      const [first, concurrent] = await Promise.all([
        getFilteredUsageAggregate({ provider: " OpenAI " }),
        getFilteredUsageAggregate({ provider: "openai" }),
      ]);
      const retained = await getFilteredUsageAggregate({ provider: "OPENAI" });
      const different = await getFilteredUsageAggregate({ provider: "anthropic" });

      expect(scans).toBe(2);
      expect(requests(first)).toBe(2);
      expect(first.accumulator).toBe(concurrent.accumulator);
      expect(retained.update).toBe("unchanged");
      expect(retained.accumulator).toBe(first.accumulator);
      expect(requests(different)).toBe(0);
      expect(usageAggregateRetainedStats().count).toBe(2);
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("filtered retention invalidates when pricing inputs change", async () => {
    writeFileSync(join(testDir, "usage.jsonl"), line("one"));
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    let scans = 0;
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        scans += 1;
        return originalScan(options);
      });
    try {
      const first = await getFilteredUsageAggregate({ provider: "openai" });
      refreshUserCostOverlays({
        providers: {
          openai: {
            modelCosts: {
              "gpt-5.5": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
            },
          },
        },
      } as unknown as OcxConfig);
      const refreshed = await getFilteredUsageAggregate({ provider: "openai" });

      expect(scans).toBe(2);
      expect(refreshed.update).toBe("rebuild");
      expect(refreshed.accumulator).not.toBe(first.accumulator);
      expect(usageAggregateRetainedStats().count).toBe(1);
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("filtered retention incrementally folds an ordinary append", async () => {
    writeFileSync(join(testDir, "usage.jsonl"), line("one"));
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    const scanStarts: number[] = [];
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        scanStarts.push(options.startAtBytes ?? 0);
        return originalScan(options);
      });
    try {
      const first = await getFilteredUsageAggregate({ provider: "openai" });
      appendFileSync(join(testDir, "usage.jsonl"), line("two"));
      const appended = await getFilteredUsageAggregate({ provider: "openai" });

      expect(requests(first)).toBe(1);
      expect(appended.update).toBe("append");
      expect(requests(appended)).toBe(2);
      expect(scanStarts).toHaveLength(2);
      expect(scanStarts[0]).toBe(0);
      expect(scanStarts[1]).toBeGreaterThan(0);
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("a missing ledger is retained as an unchanged empty aggregate", async () => {
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    let scans = 0;
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        scans += 1;
        return originalScan(options);
      });
    try {
      const first = await getUsageAggregate({ now: NOW });
      const second = await getUsageAggregate({ now: NOW });
      expect(scans).toBe(1);
      expect(requests(first)).toBe(0);
      expect(second.update).toBe("unchanged");
      expect(second.accumulator).toBe(first.accumulator);
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("concurrent cold callers share one full base scan", async () => {
    writeFileSync(join(testDir, "usage.jsonl"), `${line("one")}${line("two")}`);
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    const scanStarts: number[] = [];
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        scanStarts.push(options.startAtBytes ?? 0);
        return originalScan(options);
      });
    try {
      const [first, second] = await Promise.all([
        getUsageAggregate({ now: NOW }),
        getUsageAggregate({ now: NOW }),
      ]);
      expect(scanStarts).toEqual([0]);
      expect(requests(first)).toBe(2);
      expect(requests(second)).toBe(2);
      expect(first.accumulator).toBe(second.accumulator);
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("a shrink discards the checkpoint and performs a full rebuild", async () => {
    writeFileSync(join(testDir, "usage.jsonl"), `${line("one")}${line("two")}${line("three")}`);
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    const scanStarts: number[] = [];
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        scanStarts.push(options.startAtBytes ?? 0);
        return originalScan(options);
      });
    try {
      const rebuilt = await getUsageAggregate({ now: NOW });
      expect(requests(rebuilt)).toBe(3);

      appendFileSync(join(testDir, "usage.jsonl"), line("four"));
      const appended = await getUsageAggregate({ now: NOW });
      expect(appended.update).toBe("append");
      expect(requests(appended)).toBe(4);

      writeFileSync(join(testDir, "usage.jsonl"), line("new"));
      const afterShrink = await getUsageAggregate({ now: NOW });
      expect(afterShrink.update).toBe("rebuild");
      expect(requests(afterShrink)).toBe(1);
      expect(scanStarts).toHaveLength(3);
      expect(scanStarts[0]).toBe(0);
      expect(scanStarts[1]).toBeGreaterThan(0);
      expect(scanStarts[2]).toBe(0);
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("app-owned eviction makes the next caller perform a full rebuild", async () => {
    writeFileSync(join(testDir, "usage.jsonl"), line("one"));
    const usageStore = APP_OWNED_RETAINED_STORE_REGISTRATIONS
      .find(registration => registration.id === "usage_snapshot");
    if (!usageStore) throw new Error("usage_snapshot retained-store registration is missing");
    registerRetainedStore(usageStore);

    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    const scanStarts: number[] = [];
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        scanStarts.push(options.startAtBytes ?? 0);
        return originalScan(options);
      });
    try {
      await getUsageAggregate({ now: NOW });
      expect(usageAggregateRetainedStats().count).toBe(1);

      configureAppOwnedMemoryBudget(0);
      enforceAppOwnedMemoryBudget();
      expect(usageAggregateRetainedStats().count).toBe(0);

      configureAppOwnedMemoryBudget(DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES);
      const rebuilt = await getUsageAggregate({ now: NOW });
      expect(rebuilt.update).toBe("rebuild");
      expect(requests(rebuilt)).toBe(1);
      expect(scanStarts).toEqual([0, 0]);
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("an oversized append result never publishes its partially-fed candidate", async () => {
    writeFileSync(join(testDir, "usage.jsonl"), line("one"));
    const originalScan = usageLedgerScannerModule.scanUsageLedgerCooperatively;
    let forceOversizedAppend = false;
    const scanStarts: number[] = [];
    const scanSpy = spyOn(usageLedgerScannerModule, "scanUsageLedgerCooperatively")
      .mockImplementation(async options => {
        const start = options.startAtBytes ?? 0;
        scanStarts.push(start);
        const result = await originalScan(options);
        return forceOversizedAppend && start > 0
          ? { ...result, oversizedRows: result.oversizedRows + 1 }
          : result;
      });
    try {
      const original = await getUsageAggregate({ now: NOW });
      expect(requests(original)).toBe(1);

      appendFileSync(join(testDir, "usage.jsonl"), line("two"));
      forceOversizedAppend = true;
      await expect(getUsageAggregate({ now: NOW })).rejects.toThrow("oversized row");
      expect(requests(original)).toBe(1);
      expect(usageAggregateRetainedStats().count).toBe(0);

      forceOversizedAppend = false;
      const rebuilt = await getUsageAggregate({ now: NOW });
      expect(rebuilt.update).toBe("rebuild");
      expect(requests(rebuilt)).toBe(2);
      expect(scanStarts).toHaveLength(3);
      expect(scanStarts[0]).toBe(0);
      expect(scanStarts[1]).toBeGreaterThan(0);
      expect(scanStarts[2]).toBe(0);
    } finally {
      scanSpy.mockRestore();
    }
  });
});
