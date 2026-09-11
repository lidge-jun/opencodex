import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAstraEffortCacheMetrics } from "../../src/usage/astra-effort-cache";
import { appendUsageEntry, readRecentUsageEntries, type PersistedUsageEntry } from "../../src/usage/log";
import { recordAdapterReasoning, type RequestLogContext } from "../../src/server/request-log";
import { summarizeAstraEffortCache } from "../../scripts/astra-effort-cache-report";

const metrics = { status: "updated", stateOutcome: "committed", durationMs: 3, setupMs: 1, transactionMs: 1, historyMs: 0.5, closeMs: 0.1, inputItems: 3, updateCount: 1 } as const;
const row: PersistedUsageEntry = { requestId: "fixture", timestamp: 1, provider: "openai", model: "gpt-6-astra", status: 200, durationMs: 10, usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 80 }, astraEffortCache: metrics };

describe("Astra effort cache measurements", () => {
  test("allowlists metadata and rejects malformed values without leaking strings", () => {
    expect(normalizeAstraEffortCacheMetrics({ ...metrics, body: "private", account: "private" })).toEqual(metrics);
    for (const change of [{ durationMs: NaN }, { closeMs: -1 }, { inputItems: 1.2 }, { status: "private" }, { stateOutcome: "private" }]) {
      expect(normalizeAstraEffortCacheMetrics({ ...metrics, ...change })).toBeUndefined();
    }
    expect(normalizeAstraEffortCacheMetrics({ get status() { throw new Error("private"); } })).toBeUndefined();
  });
  test("persists bounded metadata through the existing usage ledger", () => {
    const home = mkdtempSync(join(tmpdir(), "astra-usage-"));
    const oldHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      appendUsageEntry({ ...row, astraEffortCache: { ...metrics, privateField: "private-sentinel" } as typeof metrics });
      expect(readRecentUsageEntries(10, home)[0].astraEffortCache).toEqual(metrics);
      expect(readFileSync(join(home, "usage.jsonl"), "utf8")).not.toContain("private-sentinel");
    } finally {
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("records metrics without reasoning metadata and clears them on another adapter build", () => {
    const ctx = { activeAttempt: {} } as RequestLogContext;
    recordAdapterReasoning(ctx, { url: "http://localhost", method: "POST", headers: {}, body: "{}", astraEffortCache: metrics });
    expect(ctx.astraEffortCache).toEqual(metrics);
    expect(ctx.activeAttempt?.astraEffortCache).toEqual(metrics);
    recordAdapterReasoning(ctx, { url: "http://localhost", method: "POST", headers: {}, body: "{}" });
    expect(ctx.astraEffortCache).toBeUndefined();
    expect(ctx.activeAttempt?.astraEffortCache).toBeUndefined();
  });
  test("counts attempts once and separates measured cache usage from unknown or invalid usage", () => {
    const attempt = { ...row, ordinal: 1, adapter: "openai-responses", sendCount: 1, recoveryKinds: [] };
    const report = summarizeAstraEffortCache([
      { ...row, attempts: [attempt] },
      { ...row, usageStatus: "estimated" }, { ...row, usage: { inputTokens: 100, outputTokens: 1 } },
      { ...row, usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 0 } },
      { ...row, usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 80 } },
      { ...row, astraEffortCache: undefined },
    ]);
    expect(report.samples).toBe(5);
    expect(report.cache).toEqual({ hit: 1, miss: 1, unknown: 2, invalid: 1, inputTokens: 200, cachedInputTokens: 80, cachedInputRatio: 0.4 });
    expect(summarizeAstraEffortCache([]).timingsMs.durationMs.p99).toBeNull();
  });
});
