import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSideChatCacheMetrics, type SideChatCacheMetrics } from "../../src/usage/side-chat-cache";
import { appendUsageEntry, readRecentUsageEntries, type PersistedUsageEntry } from "../../src/usage/log";
import { addFinalRequestLog, beginRequestAttempt, recordAdapterReasoning, recordAdapterSideChatCache, type RequestLogContext } from "../../src/server/request-log";
import { summarizeSideChatCache } from "../../scripts/side-chat-cache-report";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const metrics: SideChatCacheMetrics = { reason: "inherited-exact-prefix", phase: "unbound-side", snapshotOutcome: "stored",
  prepareMs: 2, completionMs: 0.1, inputItems: 4, matchedItems: 2, parentCandidates: 1, retainedSnapshots: 2,
  retainedBindings: 1, estimatedRetainedBytes: 1000, expiredEntries: 0, evictedEntries: 0, threadIdHash: "a".repeat(32) };
const row: PersistedUsageEntry = { requestId: "fixture", timestamp: 1, provider: "openai", model: "gpt-5.6-luna", status: 200,
  durationMs: 10, usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 80 }, sideChatCache: metrics };

test("side cache metadata is allowlisted and malformed diagnostics cannot affect requests", () => {
  expect(normalizeSideChatCacheMetrics({ ...metrics, prompt: "private", account: "private" })).toEqual(metrics);
  for (const patch of [{ prepareMs: NaN }, { matchedItems: -1 }, { reason: "private" }, { phase: "private" }, { threadIdHash: "private" }, { completionMs: Infinity }]) {
    expect(normalizeSideChatCacheMetrics({ ...metrics, ...patch })).toBeUndefined();
  }
  expect(normalizeSideChatCacheMetrics({ get reason() { throw new Error("private"); } })).toBeUndefined();
});

test("completed side cache diagnostics replace preparation and survive the usage ledger", () => {
  const home = mkdtempSync(join(tmpdir(), "side-cache-metrics-"));
  const oldHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const ctx = { activeAttempt: {} } as RequestLogContext;
    const request = { url: "http://localhost", method: "POST" as const, headers: {}, body: "{}", sideChatCache: { ...metrics, snapshotOutcome: "not-observed" as const } as SideChatCacheMetrics };
    recordAdapterReasoning(ctx, request);
    expect(ctx.activeAttempt?.sideChatCache?.snapshotOutcome).toBe("not-observed");
    request.sideChatCache = metrics;
    recordAdapterSideChatCache(ctx, request);
    expect(ctx.sideChatCache).toEqual(metrics);
    expect(ctx.activeAttempt?.sideChatCache).toEqual(metrics);
    appendUsageEntry({ ...row, sideChatCache: { ...metrics, secret: "private-sentinel" } as SideChatCacheMetrics });
    expect(readRecentUsageEntries(10, home)[0].sideChatCache).toEqual(metrics);
    expect(readFileSync(join(home, "usage.jsonl"), "utf8")).not.toContain("private-sentinel");
    recordAdapterReasoning(ctx, { ...request, sideChatCache: undefined });
    expect(ctx.sideChatCache).toBeUndefined();
    expect(ctx.activeAttempt?.sideChatCache).toBeUndefined();
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
    removeTreeWithRetry(home);
  }
});

test("reports per-attempt side outcomes separately from cache reads and absent evidence", () => {
  const attempt = { ...row, ordinal: 1, adapter: "openai-responses", sendCount: 1, recoveryKinds: [] };
  const summary = summarizeSideChatCache([{ ...row, attempts: [attempt] }, { ...row, usageStatus: "estimated" },
    { ...row, usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 0 } },
    { ...row, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } },
    { ...row, usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 80 } }]);
  expect(summary.samples).toBe(5);
  expect(summary.cache).toEqual({ hit: 1, miss: 1, unknown: 1, invalid: 1, noInput: 1, inputTokens: 200, cachedInputTokens: 80, cachedInputRatio: 0.4 });
  expect(summary.byPhase["unbound-side"]).toEqual({ samples: 5, hits: 1, misses: 1, unknown: 3 });
  expect(summarizeSideChatCache([]).timingsMs.prepareMs.p99).toBeNull();
});


test("adopted combo request uses its shared active attempt's completed diagnostics", () => {
  const attempt = beginRequestAttempt(1, "openai", "gpt-5.6-luna", "openai-responses");
  const child: RequestLogContext = { provider: "openai", model: "gpt-5.6-luna", activeAttempt: attempt, attempts: [attempt] };
  const request = { url: "http://localhost", method: "POST" as const, headers: {}, body: "{}", sideChatCache: { ...metrics, snapshotOutcome: "not-observed" as const } as SideChatCacheMetrics };
  recordAdapterReasoning(child, request);
  const adopted: RequestLogContext = { ...child, comboId: "fixture" };
  request.sideChatCache = metrics;
  recordAdapterSideChatCache(child, request);
  let final: import("../../src/server/request-log").RequestLogEntry | undefined;
  addFinalRequestLog("fixture", Date.now(), adopted, 200, undefined, entry => { final = entry; });
  expect(final?.sideChatCache).toEqual(metrics);
  expect(final?.attempts?.[0].sideChatCache).toEqual(metrics);
  recordAdapterReasoning(child, { ...request, sideChatCache: undefined });
  addFinalRequestLog("fixture", Date.now(), adopted, 200, undefined, entry => { final = entry; });
  expect(final?.sideChatCache).toBeUndefined();
});

test("retention selection uses observation time instead of request start order", () => {
  const earlyRequest = { ...row, timestamp: 100, sideChatCache: { ...metrics, observedAt: 400, estimatedRetainedBytes: 2000 } };
  const laterRequest = { ...row, timestamp: 200, sideChatCache: { ...metrics, observedAt: 300, estimatedRetainedBytes: 1000 } };
  expect(summarizeSideChatCache([earlyRequest, laterRequest]).latestRetention).toMatchObject({ observedAt: 400, requestTimestamp: 100, estimatedRetainedBytes: 2000 });
  expect(summarizeSideChatCache([laterRequest, earlyRequest]).latestRetention?.estimatedRetainedBytes).toBe(2000);
  expect(summarizeSideChatCache([row]).latestRetention).toBeNull();
});
