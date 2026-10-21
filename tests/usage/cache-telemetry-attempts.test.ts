import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxUsage, OcxProviderConfig } from "../../src/types";
import { addFinalRequestLog, aggregateAttemptUsage, applyResponseLogMetadata, beginRequestAttempt,
  clearRequestLogsForTests, finishRequestAttempt, noteAttemptSend, noteProviderAttemptSend, recordKeyAttemptUsage, type RequestLogContext } from "../../src/server/request-log";
import { cacheDiagnosticPath } from "../../src/usage/cache-diagnostic";
import { cacheProvenance, rawCacheTelemetry, withAdapterCacheTelemetry } from "../../src/usage/cache-telemetry";
import { readUsageEntries, type PersistedUsageEntry } from "../../src/usage/log";
import { cacheTokensFromUsage, createUsageSummaryAccumulator, summarizeUsage } from "../../src/usage/summary";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousHome: string | undefined;
let previousDebug: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDebug = process.env.OPENCODEX_CACHE_DEBUG;
  home = mkdtempSync(join(tmpdir(), "cache-attempts-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_CACHE_DEBUG = "1";
  clearRequestLogsForTests();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDebug === undefined) delete process.env.OPENCODEX_CACHE_DEBUG;
  else process.env.OPENCODEX_CACHE_DEBUG = previousDebug;
  clearRequestLogsForTests();
  removeTreeWithRetry(home);
});
const measured = (): OcxUsage => ({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 40,
  cacheTelemetry: rawCacheTelemetry({ input_tokens_details: { cached_tokens: 40 } }) });
function attempt(ordinal: number, sends: number, usage?: OcxUsage) {
  const value = beginRequestAttempt(ordinal, "test", "test", "openai-responses");
  for (let i = 0; i < sends; i++) noteAttemptSend(value, undefined);
  if (usage) finishRequestAttempt(value, 200, 1, usage);
  return value;
}
function entry(id: string, usage: OcxUsage): PersistedUsageEntry {
  return { requestId: id, timestamp: Date.now(), provider: "test", model: "test", status: 200,
    durationMs: 1, usageStatus: "reported", usage, cacheProvenance: cacheProvenance(usage) };
}
function rawDiagnostic() {
  return JSON.parse(readFileSync(cacheDiagnosticPath(), "utf8").trim().split("\n").at(-1)!).cache.rawUpstream;
}

describe("attempt cache completeness", () => {
  test("a zero-send candidate does not turn an observed send into unknown", () => {
    const result = aggregateAttemptUsage([attempt(1, 1, measured()), attempt(2, 0)]);
    expect(result.status).toBe("reported");
    expect(result.usage?.cacheTelemetry).toMatchObject({ source: "aggregate", complete: true, read: 40 });
    expect(cacheProvenance(result.usage)).toBe("observed");
  });
  test("a sent but unreported attempt remains unknown", () => {
    const result = aggregateAttemptUsage([attempt(1, 1, measured()), attempt(2, 1)]);
    expect(result.status).toBe("unreported");
    expect(result.usage?.cacheTelemetry).toMatchObject({ complete: false, read: 40 });
    expect(cacheProvenance(result.usage)).toBe("unknown");
  });
  test("legacy positive counters cannot erase a sent missing-usage attempt", () => {
    const legacy = { inputTokens: 100, outputTokens: 5, cachedInputTokens: 40 };
    const result = aggregateAttemptUsage([attempt(1, 1, legacy), attempt(2, 1)]);
    expect(result.usage?.cacheTelemetry).toMatchObject({ source: "aggregate", complete: false, read: 40 });
    expect(cacheProvenance(result.usage)).toBe("unknown");
    expect(cacheProvenance(aggregateAttemptUsage([attempt(1, 1, legacy), attempt(2, 0)]).usage)).toBe("observed");
  });
  test("a locally answered candidate contributes no missing upstream usage", () => {
    const local = attempt(2, 1); local.locallyAnswered = true;
    expect(cacheProvenance(aggregateAttemptUsage([attempt(1, 1, measured()), local]).usage)).toBe("observed");
  });
  test("an explicit usage record is counted even when send instrumentation is absent", () => {
    const result = aggregateAttemptUsage([attempt(1, 1, measured()), attempt(2, 0, { inputTokens: 20, outputTokens: 1 })]);
    expect(result.usage?.inputTokens).toBe(120);
    expect(cacheProvenance(result.usage)).toBe("unknown");
  });
});

describe("summary cache counters and matched rate samples", () => {
  test.each([[40, 10], [4, 10]])("canonical read %i is never reduced by write %i", (read, write) => {
    const usage = withAdapterCacheTelemetry({ inputTokens: 100, outputTokens: 1,
      cachedInputTokens: read, cacheCreationInputTokens: write })!;
    expect(cacheTokensFromUsage(usage)).toMatchObject({ read, creation: write });
    const summary = summarizeUsage([entry("canonical", usage)], "all", Date.now());
    expect(summary.models[0]?.cacheReadInputTokens).toBe(read);
    expect(summary.models[0]?.cacheHitRate).toBe(read / 100);
    // Unlabeled historic rows retain the old read+write fallback interpretation.
    expect(cacheTokensFromUsage({ inputTokens: 100, outputTokens: 1,
      cachedInputTokens: read, cacheCreationInputTokens: write }).read).toBe(Math.max(0, read - write));
  });
  test("a write-only measurement does not assert that read was zero", () => {
    const usage = withAdapterCacheTelemetry({ inputTokens: 100, outputTokens: 1, cacheCreationInputTokens: 10 })!;
    const summary = summarizeUsage([entry("writes-only", usage)], "all", Date.now());
    expect(summary.models[0]?.cacheCreationInputTokens).toBe(10);
    expect(summary.models[0]?.cacheObservedInputTokens).toBe(0);
    expect(summary.models[0]?.cacheHitRate).toBeNull();
  });
  test("partial aggregate reads remain visible but never inflate a complete sample's rate", () => {
    const partial: OcxUsage = { inputTokens: 200, outputTokens: 2, cachedInputTokens: 80,
      cacheTelemetry: { source: "aggregate", usagePresent: true, read: 80, complete: false, readComplete: false } };
    const summary = summarizeUsage([entry("complete", measured()), entry("partial", partial)], "all", Date.now());
    expect(summary.models[0]?.cacheReadInputTokens).toBe(120);
    expect(summary.models[0]?.cacheObservedInputTokens).toBe(100);
    expect(summary.models[0]?.cacheHitRate).toBe(0.4);
    expect(summary.providers[0]?.cacheHitRate).toBe(0.4);
    expect(summary.days.find(day => day.models.length)?.models[0]?.cacheHitRate).toBe(0.4);
  });
  test("mixed read-known and write-only rounds have no fully observed read denominator", () => {
    const usage: OcxUsage = { inputTokens: 200, outputTokens: 2, cachedInputTokens: 40, cacheCreationInputTokens: 10,
      cacheTelemetry: { source: "aggregate", usagePresent: true, read: 40, creation: 10,
        complete: true, readComplete: false, creationComplete: false } };
    const summary = summarizeUsage([entry("asymmetric", usage)], "all", Date.now());
    expect(summary.models[0]?.cacheObservedInputTokens).toBe(0);
    expect(summary.models[0]?.cacheHitRate).toBeNull();
  });
});

test("final spend settlement cannot borrow an earlier attempt's usage", () => {
  const first = attempt(1, 1, measured()); const last = attempt(2, 1);
  let settled: unknown = "not-called";
  const ctx: RequestLogContext = { provider: "test", model: "test", usage: first.usage,
    attempts: [first, last], activeAttempt: last, spendTracker: { settle(usage) { settled = usage; } } };
  addFinalRequestLog("stale-usage", Date.now(), ctx, 502);
  expect(settled).toBeUndefined();
  const row = readUsageEntries().at(-1)!;
  expect(row.usage?.inputTokens).toBe(100);
  expect(row.attempts?.[0].usage?.cachedInputTokens).toBe(40);
  expect(row.attempts?.[1].usage).toBeUndefined();
  expect(row.cacheProvenance).toBe("unknown");
  expect(rawDiagnostic()).toMatchObject({ observed: false, present: false });
});

test("observed terminal absence is different from no raw observation", () => {
  const ctx: RequestLogContext = { provider: "test", model: "test" };
  applyResponseLogMetadata(ctx, { type: "response.completed", response: {} }, "upstream");
  addFinalRequestLog("missing-usage", Date.now(), ctx, 200);
  expect(rawDiagnostic()).toEqual({ observed: true, usagePresent: false, present: false });
});

test("a final missing usage clears the earlier one-hour write detail too", () => {
  const ctx: RequestLogContext = { provider: "test", model: "test" };
  applyResponseLogMetadata(ctx, { usage: { input_tokens: 100, output_tokens: 1,
    input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10, cache_write_1h_tokens: 5 } } }, "upstream");
  applyResponseLogMetadata(ctx, { type: "response.completed", response: {} }, "upstream");
  addFinalRequestLog("missing-terminal", Date.now(), ctx, 200);
  expect(readUsageEntries().at(-1)?.usage?.cacheCreation1hInputTokens).toBeUndefined();
  expect(rawDiagnostic()).toEqual({ observed: true, usagePresent: false, present: false });
});

for (const rotate of [false, true]) for (const prefinish of [false, true]) test(`a failed physical resend never borrows raw cache evidence (rotation=${rotate}, prefinish=${prefinish})`, () => {
  const active = beginRequestAttempt(1, "test", "test", "openai-responses");
  let settled: unknown = "not-settled";
  const ctx: RequestLogContext = { provider: "test", model: "test", attempts: [active], activeAttempt: active,
    spendTracker: { settle(usage) { settled = usage; } } };
  const provider = (apiKey: string): OcxProviderConfig => ({ adapter: "openai-responses", authMode: "key",
    _apiKeyAttempt: { reference: apiKey }, baseUrl: "https://example.test/v1" });
  noteProviderAttemptSend(ctx, "test", provider("synthetic-a"), undefined);
  applyResponseLogMetadata(ctx, { usage: { input_tokens: 100, output_tokens: 5,
    input_tokens_details: { cached_tokens: 40 } } }, "upstream");
  const previousEvidence = active.usage?.cacheTelemetry;
  expect(previousEvidence?.source).toBe("upstream");
  noteProviderAttemptSend(ctx, "test", provider(rotate ? "synthetic-b" : "synthetic-a"), undefined, "key-429");
  expect(ctx.activeAttempt).toBe(active);
  expect(ctx.attempts).toHaveLength(rotate ? 2 : 1);
  if (prefinish) finishRequestAttempt(active, 502, 1);
  addFinalRequestLog(`failed-resend-${rotate}-${prefinish}`, Date.now(), ctx, 502);
  expect(rawDiagnostic()).toEqual({ observed: false, present: false });
  const row = readUsageEntries().at(-1)!;
  expect(row.usage?.cachedInputTokens).toBe(40);
  expect(row.cacheProvenance).toBe("unknown");
  expect(row.attempts?.at(-1)?.cacheProvenance).toBe("unknown");
  expect(settled).toBeUndefined();
});

test("fresh adapter raw evidence after a resend remains observable", () => {
  const active = attempt(1, 1, measured());
  const ctx: RequestLogContext = { provider: "test", model: "test", attempts: [active], activeAttempt: active };
  noteAttemptSend(active, undefined);
  active.usage = { ...measured(), cacheTelemetry: rawCacheTelemetry({ cache_read_input_tokens: 0 }) };
  ctx.usage = active.usage;
  addFinalRequestLog("fresh-adapter", Date.now(), ctx, 200);
  expect(rawDiagnostic()).toMatchObject({ observed: true, usagePresent: true, present: true, value: 0 });
});

test("filtered legacy combo projection keeps missing evidence and historical read recovery", () => {
  const legacy: OcxUsage = { inputTokens: 100, outputTokens: 5, cachedInputTokens: 40, cacheCreationInputTokens: 10 };
  const row = entry("legacy-filter", legacy);
  row.attempts = [attempt(1, 1, legacy), attempt(2, 1)];
  const accumulator = createUsageSummaryAccumulator({ filter: { provider: "test" } });
  accumulator.add(row);
  const summary = accumulator.summarize("all", Date.now(), "all");
  expect(summary.summary.cacheReadInputTokens).toBe(30);
  expect(summary.summary.cacheUnknownRequests).toBe(1);
  expect(summary.summary.cacheObservedInputTokens ?? 0).toBe(0);
});

for (const reported of [[false, true], [true, false, true]]) test(`missing physical send stays unknown after recovery (${reported})`, () => {
  const active = beginRequestAttempt(1, "test", "test", "openai-responses");
  const ctx: RequestLogContext = { provider: "test", model: "test", attempts: [active], activeAttempt: active };
  const provider: OcxProviderConfig = { adapter: "openai-responses", authMode: "key",
    _apiKeyAttempt: { reference: "synthetic-a" }, baseUrl: "https://example.test/v1" };
  for (const observed of reported) {
    noteProviderAttemptSend(ctx, "test", provider, undefined);
    if (observed) applyResponseLogMetadata(ctx, { usage: { input_tokens: 100, output_tokens: 5,
      input_tokens_details: { cached_tokens: 40 } } }, "upstream");
  }
  addFinalRequestLog(`recovered-gap-${reported.length}`, Date.now(), ctx, 200);
  const row = readUsageEntries().at(-1)!;
  expect(row.usage?.cachedInputTokens).toBe(reported.filter(Boolean).length * 40);
  expect(row.cacheProvenance).toBe("unknown");
  expect(row.attempts?.[0].cacheProvenance).toBe("unknown");
  // The newest send did report a raw value, independent of incomplete chain evidence.
  expect(rawDiagnostic()).toMatchObject({ observed: true, present: true, value: 40 });
});

for (const prefinish of [false, true]) test(`fresh adapter raw facts survive an earlier missing send (prefinish=${prefinish})`, () => {
  const active = attempt(1, 1);
  const ctx: RequestLogContext = { provider: "test", model: "test", attempts: [active], activeAttempt: active };
  noteAttemptSend(active, undefined);
  active.usage = measured();
  ctx.usage = active.usage;
  if (prefinish) finishRequestAttempt(active, 200, 1);
  addFinalRequestLog(`adapter-gap-${prefinish}`, Date.now(), ctx, 200);
  expect(readUsageEntries().at(-1)?.cacheProvenance).toBe("unknown");
  expect(rawDiagnostic()).toMatchObject({ observed: true, usagePresent: true, present: true, value: 40 });
});

test("key adapter rounds preserve the last raw reading before summing evidence", () => {
  const active = beginRequestAttempt(1, "test", "test", "anthropic");
  const ctx: RequestLogContext = { provider: "test", model: "test", attempts: [active], activeAttempt: active };
  const provider: OcxProviderConfig = { adapter: "anthropic", authMode: "key",
    _apiKeyAttempt: { reference: "synthetic-a" }, baseUrl: "https://example.test/v1" };
  for (let round = 0; round < 2; round++) {
    noteProviderAttemptSend(ctx, "test", provider, undefined);
    recordKeyAttemptUsage(ctx, measured());
  }
  addFinalRequestLog("adapter-key-rounds", Date.now(), ctx, 200);
  expect(readUsageEntries().at(-1)?.usage?.cachedInputTokens).toBe(80);
  expect(readUsageEntries().at(-1)?.cacheProvenance).toBe("observed");
  expect(rawDiagnostic()).toMatchObject({ observed: true, present: true, value: 40 });
});
