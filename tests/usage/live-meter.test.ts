import { describe, expect, test } from "bun:test";
import { liveMeterFromEntry, selectLiveMeterEntries } from "../../src/usage/live-meter";
import type { RequestLogEntry } from "../../src/server/request-log";

const row = (o: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  requestId: "r", timestamp: 1, model: "fixture", provider: "p", status: 200, durationMs: 10000,
  genStartMs: 2000, lastOutputMs: 8000, firstOutputMs: 7000, usageStatus: "reported",
  usage: { inputTokens: 1000, outputTokens: 600, reasoningOutputTokens: 200 }, ...o,
} as RequestLogEntry);

describe("live meter speed", () => {
  test("output tokens over the generation window, reasoning counted once", () => {
    const m = liveMeterFromEntry(row(), null);
    expect(m.speed).toEqual({ value: 100, reason: null });
    expect(m.generationMs).toBe(6000);
    expect(m.outputTokens).toBe(600);
  });
  test("queue time, wall clock and first visible text do not enter the denominator", () => {
    const a = liveMeterFromEntry(row(), null).speed.value;
    expect(liveMeterFromEntry(row({ timestamp: 3_600_000, durationMs: 90000, firstOutputMs: 7900 }), null).speed.value).toBe(a);
    expect(liveMeterFromEntry(row({ genStartMs: 62000, lastOutputMs: 68000, durationMs: 100000 }), null).speed.value).toBe(a);
  });
  test("missing window never falls back to duration or first output", () => {
    for (const d of [{ genStartMs: undefined }, { lastOutputMs: undefined }, { genStartMs: NaN }]) {
      expect(liveMeterFromEntry(row(d), null).speed).toEqual({ value: null, reason: "generation_timing_missing" });
    }
  });
  test("tiny or invalid windows are not printed as a rate", () => {
    expect(liveMeterFromEntry(row({ genStartMs: 7950 }), null).speed.reason).toBe("generation_window_too_short");
    expect(liveMeterFromEntry(row({ genStartMs: 9000 }), null).speed.reason).toBe("invalid_generation_window");
    expect(liveMeterFromEntry(row({ genStartMs: -1 }), null).speed.reason).toBe("generation_timing_missing");
    expect(liveMeterFromEntry(row({ lastOutputMs: 10050 }), null).speed.reason).toBe("invalid_generation_window");
  });
  test("failed, truncated, cancelled and estimated requests stay unavailable with their reason", () => {
    const cases: Array<[Partial<RequestLogEntry>, string]> = [
      [{ status: 502 }, "request_failed"], [{ terminalStatus: "incomplete" }, "request_incomplete"],
      [{ terminalStatus: "failed" }, "request_incomplete"], [{ closeReason: "client_cancel" }, "request_aborted"],
      [{ status: 499 }, "request_aborted"], [{ closeReason: "body_stall" }, "request_incomplete"],
      [{ closeReason: "body_overflow" }, "request_incomplete"], [{ usageStatus: "estimated" }, "tokens_estimated"],
      [{ usage: { inputTokens: 1, outputTokens: 5, estimated: true } }, "tokens_estimated"],
      [{ usage: undefined }, "usage_missing"], [{ usageStatus: "unsupported" }, "usage_missing"],
      [{ usage: { inputTokens: 1, outputTokens: 0 } }, "output_missing"],
    ];
    for (const [delta, reason] of cases) {
      const m = liveMeterFromEntry(row(delta), null);
      expect(m.speed.value).toBeNull();
      expect(m.speed.reason).toBe(reason as never);
    }
  });
  test("a retried row reports no speed: its window spans the gap between attempts", () => {
    const attempt = { ordinal: 1, provider: "p", model: "fixture", adapter: "a", status: 200, durationMs: 1, sendCount: 1, recoveryKinds: [], usageStatus: "reported" };
    expect(liveMeterFromEntry(row({ attempts: [attempt, { ...attempt, ordinal: 2 }] } as Partial<RequestLogEntry>), null).speed)
      .toEqual({ value: null, reason: "multiple_attempts" });
    expect(liveMeterFromEntry(row({ attempts: [attempt] } as Partial<RequestLogEntry>), null).speed).toEqual({ value: 100, reason: null });
  });
});

describe("live meter cache and context", () => {
  test("cache percent is cache-read over input, explicit zero stays a measurement", () => {
    const hit = liveMeterFromEntry(row({ usage: { inputTokens: 1000, outputTokens: 5, cacheReadInputTokens: 870 } }), null);
    expect(hit.cache).toEqual({ readTokens: 870, inputTokens: 1000, percent: 87, reason: null });
    expect(liveMeterFromEntry(row({ usage: { inputTokens: 1000, outputTokens: 5, cacheReadInputTokens: 0 } }), null).cache.percent).toBe(0);
    expect(liveMeterFromEntry(row({ usage: { inputTokens: 1000, outputTokens: 5, cachedInputTokens: 500 } }), null).cache.percent).toBe(50);
  });
  test("cache is null, never guessed, when unreported, estimated or synthesized", () => {
    expect(liveMeterFromEntry(row(), null).cache).toMatchObject({ percent: null, readTokens: null });
    expect(liveMeterFromEntry(row({ usageStatus: "estimated", usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 5 } }), null).cache)
      .toMatchObject({ percent: null, reason: "tokens_estimated" });
    expect(liveMeterFromEntry(row({ cacheProvenance: "synthesized", usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 5 } }), null).cache.percent).toBeNull();
  });
  test("unknown cache provenance is never a measured hit rate, zero counters included", () => {
    const m = liveMeterFromEntry(row({ cacheProvenance: "unknown", usage: { inputTokens: 1000, outputTokens: 5, cacheReadInputTokens: 0 } }), null);
    expect(m.cache).toEqual({ readTokens: 0, inputTokens: 1000, percent: null, reason: "cache_unobserved" });
    expect(liveMeterFromEntry(row({ cacheProvenance: "observed", usage: { inputTokens: 1000, outputTokens: 5, cacheReadInputTokens: 0 } }), null).cache.percent).toBe(0);
  });
  test("context used is input plus output, or the absolute context total when the provider gives one", () => {
    const m = liveMeterFromEntry(row({ usage: { inputTokens: 380_000, outputTokens: 900 } }), 1_000_000);
    expect(m.context).toEqual({ usedTokens: 380_900, limitTokens: 1_000_000, percent: 38.09, reason: null });
    const abs = liveMeterFromEntry(row({ usage: { inputTokens: 10, outputTokens: 5, contextTotalTokens: 200 } }), 1000);
    expect(abs.context.usedTokens).toBe(200);
  });
  test("an unknown or invalid limit leaves the percentage null but keeps the used count", () => {
    for (const limit of [null, 0, -5, NaN]) {
      const m = liveMeterFromEntry(row(), limit);
      expect(m.context).toMatchObject({ usedTokens: 1600, limitTokens: null, percent: null, reason: "limit_unknown" });
    }
  });
  test("estimated usage reports no context used", () => {
    expect(liveMeterFromEntry(row({ usageStatus: "estimated" }), 1000).context)
      .toMatchObject({ usedTokens: null, percent: null, reason: "tokens_estimated" });
  });
  test("the payload carries only numbers, model, provider and client", () => {
    const m = liveMeterFromEntry(row({ client: "codex_desktop", accountLogLabel: "main", conversationId: "a".repeat(32) }), 1000);
    expect(Object.keys(m).sort()).toEqual(["cache", "client", "context", "generationMs", "model", "outputTokens", "provider", "speed", "timestamp"]);
    expect(JSON.stringify(m)).not.toContain("main");
  });
});

describe("live meter selection", () => {
  test("newest overall and per family; auto-review rows never win", () => {
    const rows = [
      row({ requestId: "a", timestamp: 10, client: "codex_desktop" }),
      row({ requestId: "b", timestamp: 20, client: "claude_code" }),
      row({ requestId: "c", timestamp: 30, client: "codex_cli", model: "codex-auto-review" }),
      row({ requestId: "d", timestamp: 15, client: "codex_cli" }),
      row({ requestId: "e", timestamp: 40, client: "unknown" }),
    ];
    const sel = selectLiveMeterEntries(rows);
    expect(sel.overall?.requestId).toBe("e");
    expect(sel.byFamily.codex?.requestId).toBe("d");
    expect(sel.byFamily.claude?.requestId).toBe("b");
    expect(sel.byFamily.other).toBeUndefined();
  });
  test("a conversation matcher narrows the candidates", () => {
    const rows = [row({ requestId: "a", timestamp: 10, conversationId: "x" }), row({ requestId: "b", timestamp: 20, conversationId: "y" })];
    expect(selectLiveMeterEntries(rows, e => e.conversationId === "x").overall?.requestId).toBe("a");
    expect(selectLiveMeterEntries(rows, () => false).overall).toBeNull();
  });
});
