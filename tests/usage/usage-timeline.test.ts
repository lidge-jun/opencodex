import { describe, expect, test } from "bun:test";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { createTimelineAccumulator, parseTimelineQuery } from "../../src/usage/timeline";

const now = 1_700_000_000_000;
function entry(overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return {
    requestId: "request",
    timestamp: now - 30 * 60_000,
    provider: "openai",
    model: "gpt-5",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    ...overrides,
  };
}
function attempt(totalTokens: number, ordinal: number): NonNullable<PersistedUsageEntry["attempts"]>[number] {
  return {
    ordinal,
    provider: "openai",
    model: "gpt-5",
    adapter: "test",
    status: 200,
    durationMs: 1,
    sendCount: 1,
    recoveryKinds: [],
    usageStatus: "reported",
    totalTokens,
  };
}

describe("usage timeline", () => {
  test("nested native model ids remain selectable", () => {
    const model = "github-models/openai/gpt-4.1";
    const query = parseTimelineQuery(new URLSearchParams({ models: model }), now);
    expect(query).toMatchObject({ models: [model] });
    if ("error" in query) throw new Error(query.error);
    const acc = createTimelineAccumulator(query);
    acc.add(entry({ provider: "github-models", model: "openai/gpt-4.1", totalTokens: 7 }));
    expect(acc.finish().series[0]?.total).toBe(7);
  });

  test("the final bucket includes current partial usage and excludes the old shifted edge", () => {
    const clock = Date.UTC(2030, 0, 1, 12, 13);
    const query = parseTimelineQuery(new URLSearchParams("hours=6&bucketMinutes=15"), clock);
    if ("error" in query) throw new Error(query.error);
    const acc = createTimelineAccumulator(query);
    acc.add(entry({ timestamp: clock - 60_000, totalTokens: 7 }));
    acc.add(entry({ timestamp: Date.UTC(2030, 0, 1, 6, 14), totalTokens: 99 }));
    const result = acc.finish();
    expect(result.end).toBe(Date.UTC(2030, 0, 1, 12, 15) / 1000);
    expect(result.buckets).toBe(24);
    expect(result.series[0]?.points.at(-1)).toBe(7);
    expect(result.series[0]?.total).toBe(7);
  });

  test("hidden traffic is excluded before available models and other-series folding", () => {
    const query = parseTimelineQuery(new URLSearchParams("hiddenProvider=hidden&hiddenProvider=hidden"), now);
    if ("error" in query) throw new Error(query.error);
    const acc = createTimelineAccumulator(query);
    for (let index = 0; index < 25; index += 1) acc.add(entry({ provider: "visible", model: `m${index}`, totalTokens: 10 }));
    acc.add(entry({ provider: "hidden", model: "tail", totalTokens: 1 }));
    const result = acc.finish();
    expect(result.availableModels).toHaveLength(25);
    expect(result.appliedFilters).toEqual({ models: null, hiddenProviders: ["hidden"] });
    expect(result.availableModels.some(id => id.startsWith("hidden/"))).toBe(false);
    expect(result.series).toHaveLength(24);
    expect(result.series.at(-1)?.id).toBe("other");
    expect(result.series.reduce((total, row) => total + row.total, 0)).toBe(250);
    const invalid = new URLSearchParams();
    for (let index = 0; index < 101; index += 1) invalid.append("hiddenProvider", `p${index}`);
    expect(parseTimelineQuery(invalid, now)).toEqual({ error: expect.any(String) });
    expect(parseTimelineQuery(new URLSearchParams("hiddenProvider=two+words"), now)).toEqual({ error: expect.any(String) });
  });

  test("parses defaults and rejects invalid values", () => {
    expect(parseTimelineQuery(new URLSearchParams(), now)).toMatchObject({
      hours: 24, bucketMinutes: 60, metric: "total", aggregation: "sum", grouping: "model", models: null,
    });
    expect(parseTimelineQuery(new URLSearchParams("hours=7"), now)).toEqual({ error: expect.any(String) });
    expect(parseTimelineQuery(new URLSearchParams("bucketMinutes=0"), now)).toEqual({ error: expect.any(String) });
    expect(parseTimelineQuery(new URLSearchParams("metric=nope"), now)).toEqual({ error: expect.any(String) });
    expect(parseTimelineQuery(new URLSearchParams("models=openai%2Fgpt-5%2Cbad"), now)).toEqual({ error: expect.any(String) });
  });

  test("buckets timestamps and attributes attempts without parent double counting", () => {
    const query = parseTimelineQuery(new URLSearchParams("hours=6&bucketMinutes=60"), now);
    if ("error" in query) throw new Error(query.error);
    const acc = createTimelineAccumulator(query);
    acc.add(entry({
      requestId: "retry",
      totalTokens: 999,
      attempts: [
        attempt(10, 0),
        attempt(20, 1),
      ],
    }));
    const result = acc.finish();
    expect(result.series[0]?.total).toBe(30);
    expect(result.buckets).toBe(6);
  });

  test("supports request average and max", () => {
    const make = (aggregation: "sum" | "average" | "max") => {
      const query = parseTimelineQuery(new URLSearchParams(`hours=6&aggregation=${aggregation}`), now);
      if ("error" in query) throw new Error(query.error);
      const acc = createTimelineAccumulator(query);
      acc.add(entry({ requestId: "a", totalTokens: 10 }));
      acc.add(entry({ requestId: "b", totalTokens: 30 }));
      return acc.finish().series[0]?.total;
    };
    expect(make("sum")).toBe(40);
    expect(make("average")).toBe(20);
    expect(make("max")).toBe(30);
  });

  test("filters plotted models but keeps available models and supports accounts", () => {
    const query = parseTimelineQuery(new URLSearchParams("models=openai%2Fone&grouping=modelAccount"), now);
    if ("error" in query) throw new Error(query.error);
    const acc = createTimelineAccumulator(query);
    acc.add(entry({ model: "one", accountLogLabel: "main", totalTokens: 4 }));
    acc.add(entry({ model: "two", totalTokens: 8 }));
    const result = acc.finish();
    expect(result.availableModels).toEqual(["openai/one", "openai/two"]);
    expect(result.series[0]?.id).toBe("openai/one · main");
  });

  // INV-COMPANION-01
  test("pool accounts of one model draw one series and still split under account grouping", () => {
    const pooled = (provider: string, totalTokens: number, extra: Partial<PersistedUsageEntry> = {}) =>
      entry({ requestId: provider, provider, model: "gpt-6-astra", totalTokens, ...extra });
    const run = (params: string) => {
      const query = parseTimelineQuery(new URLSearchParams(params), now);
      if ("error" in query) throw new Error(query.error);
      const acc = createTimelineAccumulator(query);
      acc.add(pooled("openai-p6bc633", 10));
      acc.add(pooled("openai-pe2d42f", 20));
      acc.add(pooled("openai", 5));
      acc.add(pooled("openai-main", 3));
      acc.add(pooled("chatgpt", 2, { accountLogLabel: "pc272f0" }));
      acc.add(entry({ requestId: "claude-a", provider: "anthropic-p111111", model: "claude-opus-5", totalTokens: 7 }));
      acc.add(entry({ requestId: "claude-b", provider: "anthropic-p222222", model: "claude-opus-5", totalTokens: 6 }));
      acc.add(entry({ provider: "xai", model: "grok-4.7", totalTokens: 1 }));
      return acc.finish();
    };

    const merged = run("hours=6");
    expect(merged.availableModels).toEqual(["anthropic/claude-opus-5", "openai/gpt-6-astra", "xai/grok-4.7"]);
    expect(merged.series.map(row => [row.id, row.provider, row.total])).toEqual([
      ["openai/gpt-6-astra", "openai", 40],
      ["anthropic/claude-opus-5", "anthropic", 13],
      ["xai/grok-4.7", "xai", 1],
    ]);

    // A selection saved while the chart still listed accounts selects the merged row, whole.
    const legacy = run("hours=6&models=openai-p6bc633%2Fgpt-6-astra");
    expect(legacy.appliedFilters.models).toEqual(["openai-p6bc633/gpt-6-astra"]);
    expect(legacy.series.map(row => [row.id, row.total])).toEqual([["openai/gpt-6-astra", 40]]);

    expect(run("hours=6&hiddenProvider=openai").series.map(row => row.id)).toEqual(["anthropic/claude-opus-5", "xai/grok-4.7"]);
    expect(run("hours=6&hiddenProvider=openai-p6bc633").series[0]?.total).toBe(30);

    const accounts = run("hours=6&grouping=modelAccount");
    expect(accounts.series.map(row => [row.id, row.accountLogLabel, row.total])).toEqual([
      ["openai/gpt-6-astra · pe2d42f", "pe2d42f", 20],
      ["openai/gpt-6-astra · p6bc633", "p6bc633", 10],
      ["anthropic/claude-opus-5 · p111111", "p111111", 7],
      ["anthropic/claude-opus-5 · p222222", "p222222", 6],
      ["openai/gpt-6-astra · unknown", "unknown", 5],
      ["openai/gpt-6-astra · main", "main", 3],
      ["openai/gpt-6-astra · pc272f0", "pc272f0", 2],
      ["xai/grok-4.7 · unknown", "unknown", 1],
    ]);
  });

  test("counts missing measurements and folds excess series", () => {
    const query = parseTimelineQuery(new URLSearchParams("hours=6&metric=input"), now);
    if ("error" in query) throw new Error(query.error);
    const acc = createTimelineAccumulator(query);
    acc.add(entry({ usage: undefined, totalTokens: 1 }));
    for (let index = 0; index < 25; index += 1) {
      acc.add(entry({ model: `model-${index}`, usage: { inputTokens: index } }));
    }
    const result = acc.finish();
    expect(result.missingMeasurements).toBe(1);
    expect(result.series).toHaveLength(24);
    expect(result.series.at(-1)?.id).toBe("other");
  });

  test("folds other rows with request-level max and average", () => {
    const make = (aggregation: "average" | "max") => {
      const query = parseTimelineQuery(new URLSearchParams(`hours=6&aggregation=${aggregation}`), now);
      if ("error" in query) throw new Error(query.error);
      const acc = createTimelineAccumulator(query);
      for (let index = 0; index < 25; index += 1) {
        acc.add(entry({
          requestId: `request-${index}`,
          model: `model-${index}`,
          totalTokens: index < 23 ? 100 + index : index - 22,
        }));
      }
      return acc.finish().series.at(-1);
    };
    expect(make("max")?.total).toBe(2);
    expect(make("average")?.total).toBe(1.5);
  });
});
