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
    expect(make("max")?.points.at(-1)).toBe(2);
    expect(make("average")?.points.at(-1)).toBe(1.5);
  });
});
