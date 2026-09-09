import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES,
  configureAppOwnedMemoryBudget,
  enforceAppOwnedMemoryBudget,
  registerRetainedStore,
  resetAppOwnedMemoryForTests,
} from "../../src/lib/app-owned-memory";
import { APP_OWNED_RETAINED_STORE_REGISTRATIONS } from "../../src/lib/app-owned-memory-stores";
import {
  getFilteredUsageAggregate,
  getUsageAggregate,
  resetUsageAggregateCacheForTests,
  usageAggregateRetainedStats,
  type UsageAggregateResult,
} from "../../src/server/management/usage-aggregate-cache";
import type { OcxConfig } from "../../src/types/config";
import { resetUsageReadCacheForTests, type PersistedUsageEntry } from "../../src/usage/log";
import * as usageLedgerScannerModule from "../../src/usage/ledger-scanner";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import { buildRouteDecisionTrace } from "../../src/routing/trace";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { buildResponseJSON } from "../../src/bridge";
import { formatUsageReport } from "../../src/cli/usage-report";
import { addFinalRequestLog, clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import type { AdapterEvent } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

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
  clearRequestLogsForTests();
  resetUsageAggregateCacheForTests();
  resetUsageReadCacheForTests();
  resetAppOwnedMemoryForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("retained usage aggregate cache", () => {
  test.each(["message_start", "message_delta"].flatMap(phase =>
    ["bad", [], null, false, 7, { output_tokens: "bad" }].map(usage => ({ phase, usage })),
  ))("malformed streamed usage at $phase stays unreported after a valid update: $usage", async ({ phase, usage }) => {
    const adapter = withTestTranslatorBudget(createAnthropicAdapter({
      adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "test-key",
    }));
    const frames = [
      { type: "message_start", message: { usage: phase === "message_start" ? usage : { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      ...(phase === "message_delta" ? [{ type: "message_delta", delta: {}, usage }] : []),
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(frames))) events.push(event);
    const logCtx: RequestLogContext = { provider: "anthropic", model: "claude-test" };
    const result = buildResponseJSON(events, "anthropic/claude-test", { onUsage: observed => { logCtx.usage = observed; } });
    expect(result.status).toBe("completed");
    expect(JSON.stringify(result.output)).toContain("ok");
    addFinalRequestLog("malformed-stream-usage", Date.now(), logCtx, 200, { closeReason: "non_stream" });
    const persisted = JSON.parse(readFileSync(join(testDir, "usage.jsonl"), "utf8").trim());
    expect(persisted.usageStatus).toBe("unreported");
    expect(persisted.usage).toBeUndefined();
    const report = (await getUsageAggregate()).accumulator.summarize("all", Date.now());
    expect(report.summary.requests).toBe(1);
    expect(report.summary.unmeteredRequests).toBe(1);
  });

  test("malformed Anthropic usage stays unmetered through the real ledger and human report", async () => {
    const adapter = withTestTranslatorBudget(createAnthropicAdapter({
      adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "test-key",
    }));
    const response = Response.json({
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: "\x1b[2J" },
    });
    const events = await adapter.parseResponse!(response) as AdapterEvent[];
    const logCtx: RequestLogContext = { provider: "anthropic", model: "claude-test" };
    buildResponseJSON(events, "anthropic/claude-test", { onUsage: usage => { logCtx.usage = usage; } });
    addFinalRequestLog("malformed-usage", Date.now(), logCtx, 200, { closeReason: "non_stream" });
    const persisted = JSON.parse(readFileSync(join(testDir, "usage.jsonl"), "utf8").trim());
    const report = (await getUsageAggregate()).accumulator.summarize("all", Date.now());
    expect(report.summary.requests).toBe(1);
    expect(formatUsageReport(report).every(line => !/[\x00-\x1f\x7f-\x9f]/.test(line))).toBe(true);
    expect(persisted.usageStatus).toBe("unreported");
    expect(persisted.usage).toBeUndefined();
    expect(report.summary.unmeteredRequests).toBe(1);
  });

  test("custom cache keys isolate both endpoints and never poison preset aggregates", async () => {
    const path = join(testDir, "usage.jsonl");
    const rows = [NOW - 2_000, NOW - 1_000, NOW].map((timestamp, index) => ({ ...entry(String(index)), timestamp }));
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const base = await getUsageAggregate();
    const firstWindow = { since: NOW - 2_000, until: NOW - 1_000 };
    const first = await getFilteredUsageAggregate({}, firstWindow);
    const same = await getFilteredUsageAggregate({}, { ...firstWindow });
    const differentStart = await getFilteredUsageAggregate({}, { since: NOW - 1_000, until: NOW - 1_000 });
    const differentEnd = await getFilteredUsageAggregate({}, { since: NOW - 2_000, until: NOW });
    expect(same.accumulator).toBe(first.accumulator);
    expect(same.update).toBe("unchanged");
    expect(requests(first)).toBe(2);
    expect(requests(differentStart)).toBe(1);
    expect(requests(differentEnd)).toBe(3);
    expect((await getUsageAggregate()).accumulator).toBe(base.accumulator);
    expect(requests(base)).toBe(3);
    expect(base.accumulator.summarize("all", NOW).customWindow).toBeUndefined();
    for (let index = 1; index <= 7; index++) {
      await getFilteredUsageAggregate({}, { since: NOW, until: NOW + index });
    }
    expect(usageAggregateRetainedStats().count).toBe(5); // base plus four filtered windows
  });

  test("custom incremental clones filter appended rows and rebuild with changed prices", async () => {
    const path = join(testDir, "usage.jsonl");
    const window = { since: NOW - 1_000, until: NOW };
    writeFileSync(path, line("one"));
    const original = await getFilteredUsageAggregate({}, window);
    appendFileSync(path, [
      { ...entry("inside"), timestamp: NOW },
      { ...entry("outside"), timestamp: NOW + 1 },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const appended = await getFilteredUsageAggregate({}, window);
    expect(appended.update).toBe("append");
    expect(requests(original)).toBe(1);
    expect(requests(appended)).toBe(2);
    expect(appended.accumulator.snapshotWindow.end).toBe(NOW + 1);
    refreshUserCostOverlays({ providers: { openai: { modelCosts: {
      "gpt-5.5": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    } } } } as unknown as OcxConfig);
    const rebuilt = await getFilteredUsageAggregate({}, window);
    expect(rebuilt.update).toBe("rebuild");
    expect(rebuilt.accumulator.summarize("today", NOW)).toMatchObject({
      customWindow: true, ...window, summary: { requests: 2 },
    });
    expect(rebuilt.accumulator.summarize("all", NOW).summary.estimatedCostUsd).toBeCloseTo(0.000006, 10);
  });

  test("append and rebuild preserve unresolved attribution and restricted pricing without ledger changes", async () => {
    const path = join(testDir, "usage.jsonl");
    writeFileSync(path, line("ordinary"));
    await getUsageAggregate();
    const model = "anthropic/claude-3-haiku-20240307";
    const fallback = { ...entry("fallback"), provider: "kimi", model,
      routeDecision: buildRouteDecisionTrace({ requestedModel: model, routeKind: "default-provider", selected: { provider: "kimi", model, reason: "default-provider" } }),
    };
    appendFileSync(path, `${JSON.stringify(fallback)}\n`);
    const before = readFileSync(path, "utf8");
    const appended = await getUsageAggregate();
    expect(appended.update).toBe("append");
    const summary = appended.accumulator.summarize("all", NOW);
    expect(summary.summary).toMatchObject({ requests: 2, totalTokens: 4 });
    expect(summary.models.find(row => row.provider === "kimi")).toMatchObject({ model, hasUnresolvedRequestedModel: true, unpricedRequests: 1 });
    expect(summary.models.find(row => row.provider === "kimi")?.estimatedCostUsd).toBeUndefined();
    const filtered = (await getFilteredUsageAggregate({ provider: "kimi" })).accumulator.summarize("all", NOW);
    expect(filtered.models[0]).toMatchObject({ hasUnresolvedRequestedModel: true, totalTokens: 2 });
    resetUsageAggregateCacheForTests();
    const rebuilt = (await getUsageAggregate()).accumulator.summarize("all", NOW);
    expect(rebuilt).toEqual(summary);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
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
