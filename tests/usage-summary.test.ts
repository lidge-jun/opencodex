import { describe, expect, test } from "bun:test";
import {
  MAX_USAGE_MODEL_BREAKDOWN_ROWS,
  MAX_USAGE_DAY_BUCKETS,
  USAGE_RANGES,
  USAGE_SURFACES,
  createUsageSummaryAccumulator,
  parseRange,
  parseUsageSurface,
  rangeWindow,
  summarizeUsage,
} from "../src/usage/summary";
import type { PersistedUsageEntry } from "../src/usage/log";

const FIXED_NOW = Date.UTC(2026, 5, 28, 12, 0, 0);

function entry(overrides: Partial<PersistedUsageEntry> & { ts: number }): PersistedUsageEntry {
  const { ts, ...rest } = overrides;
  return {
    requestId: rest.requestId ?? `req-${ts}`,
    timestamp: ts,
    provider: rest.provider ?? "openai",
    model: rest.model ?? "gpt-5.5",
    status: rest.status ?? 200,
    durationMs: rest.durationMs ?? 10,
    usageStatus: rest.usageStatus ?? "unreported",
    ...(rest.surface === "claude" ? { surface: rest.surface } : {}),
    ...(rest.accountLogLabel !== undefined ? { accountLogLabel: rest.accountLogLabel } : {}),
    ...(rest.resolvedModel !== undefined ? { resolvedModel: rest.resolvedModel } : {}),
    ...(rest.usage ? { usage: rest.usage } : {}),
    ...(rest.totalTokens !== undefined ? { totalTokens: rest.totalTokens } : {}),
    ...(rest.attempts ? { attempts: rest.attempts } : {}),
    ...(rest.apiKeyId !== undefined ? { apiKeyId: rest.apiKeyId } : {}),
  };
}

describe("parseRange", () => {
  test("accepts 7d / 30d / all", () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("30d")).toBe("30d");
    expect(parseRange("all")).toBe("all");
  });

  test("defaults to 30d on null or unknown", () => {
    expect(parseRange(null)).toBe("30d");
    expect(parseRange(undefined)).toBe("30d");
    expect(parseRange("90d")).toBe("30d");
    expect(parseRange("")).toBe("30d");
  });
});

describe("today range (CLI cost query)", () => {
  test("accepts today and normalises the 1d alias to it", () => {
    expect(parseRange("today")).toBe("today");
    // `1d` deliberately collapses instead of becoming a second union member:
    // a second member would need its own cache slot and grid arm for no gain.
    expect(parseRange("1d")).toBe("today");
    expect(parseRange("2d")).toBe("30d");
  });

  test("today is bounded by local midnight, never the all-history fallthrough", () => {
    // rangeWindow has no exhaustive switch — its final return is the `all`
    // window. A today member that failed to reach its own branch would compile
    // clean and silently report all-time history, so assert since is bounded
    // rather than only asserting the day count.
    for (const at of [
      new Date(2026, 7, 22, 0, 0, 0).getTime(),
      new Date(2026, 7, 22, 12, 34, 56).getTime(),
      new Date(2026, 7, 22, 23, 59, 59).getTime(),
    ]) {
      const window = rangeWindow("today", at);
      expect(window.since).not.toBeNull();
      expect(window.days).toBe(1);
      expect(new Date(window.since!).getHours()).toBe(0);
      expect(new Date(window.since!).getDate()).toBe(new Date(at).getDate());
      expect(window.since).toBeLessThanOrEqual(at);
    }
  });

  test("today excludes yesterday's entries", () => {
    const midday = new Date(2026, 7, 22, 12, 0, 0).getTime();
    const yesterday = new Date(2026, 7, 21, 12, 0, 0).getTime();
    const entries = [
      entry({ ts: midday, requestId: "today-1", usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 2 } }),
      entry({ ts: yesterday, requestId: "yday-1", usageStatus: "reported", usage: { inputTokens: 99, outputTokens: 9 } }),
    ];
    const sum = summarizeUsage(entries, "today", midday);
    expect(sum.summary.requests).toBe(1);
    expect(sum.days).toHaveLength(1);
    expect(sum.days[0]!.requests).toBe(1);
  });
});

describe("day-level estimated cost", () => {
  const at = Date.UTC(2026, 5, 28, 10, 0, 0);

  test("a day row equals the sum of its model rows, and the window equals the totals", () => {
    const entries = [
      entry({ ts: at, requestId: "r1", provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 1_000, outputTokens: 100 } }),
      entry({ ts: at + 1, requestId: "r2", provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 2_000, outputTokens: 200 } }),
    ];
    const sum = summarizeUsage(entries, "30d", at);
    const day = sum.days.find(d => d.requests === 2);
    expect(day).toBeDefined();
    expect(day!.estimatedCostUsd).toBeGreaterThan(0);

    const modelSum = day!.models.reduce((acc, m) => acc + (m.estimatedCostUsd ?? 0), 0);
    expect(day!.estimatedCostUsd).toBeCloseTo(modelSum, 10);

    const windowSum = sum.days.reduce((acc, d) => acc + d.estimatedCostUsd, 0);
    expect(windowSum).toBeCloseTo(sum.summary.estimatedCostUsd, 10);
  });

  test("combo cost partitions across attempts instead of double-counting the parent", () => {
    const entries = [entry({
      ts: at,
      requestId: "combo-1",
      provider: "combo",
      model: "combo-model",
      usageStatus: "reported",
      attempts: [
        { provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 1_000, outputTokens: 100 } },
        { provider: "openai", model: "gpt-5.5-mini", usageStatus: "reported", usage: { inputTokens: 500, outputTokens: 50 } },
      ],
    } as Partial<PersistedUsageEntry> & { ts: number })];
    const sum = summarizeUsage(entries, "30d", at);
    const day = sum.days.find(d => d.requests === 1);
    expect(day).toBeDefined();
    const modelSum = day!.models.reduce((acc, m) => acc + (m.estimatedCostUsd ?? 0), 0);
    expect(day!.estimatedCostUsd).toBeCloseTo(modelSum, 10);
    expect(day!.estimatedCostUsd).toBeCloseTo(sum.summary.estimatedCostUsd, 10);
  });

  test("two attempts on the SAME model are counted once, not once per attempt", () => {
    // The day grid prices per ATTRIBUTION but looks the cost up in a map keyed by
    // provider/model. When a retry lands on the same model, that key appears twice in
    // the attribution list while the map already holds the SUM of both attempts — so a
    // naive lookup adds the pair's total once per attempt and doubles the day.
    // Every other combo test in this file uses two DIFFERENT models, which is exactly
    // why the bug survives them.
    const at = Date.UTC(2026, 0, 15, 12, 0, 0);
    const usage = { inputTokens: 1_000, outputTokens: 100 };
    const entries = [entry({
      ts: at,
      requestId: "retry-same-model",
      provider: "combo",
      model: "combo-model",
      usageStatus: "reported",
      attempts: [
        { provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage },
        { provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage },
      ],
    } as Partial<PersistedUsageEntry> & { ts: number })];
    const sum = summarizeUsage(entries, "30d", at);
    const day = sum.days.find(d => d.requests === 1);
    expect(day).toBeDefined();

    // The window total prices each attempt once; the day must agree with it.
    expect(day!.estimatedCostUsd).toBeCloseTo(sum.summary.estimatedCostUsd, 10);
    const modelSum = day!.models.reduce((acc, m) => acc + (m.estimatedCostUsd ?? 0), 0);
    expect(day!.estimatedCostUsd).toBeCloseTo(modelSum, 10);
  });

  test("the day overflow row sums the cost of the models it collapsed", () => {
    // Past MAX_USAGE_MODEL_BREAKDOWN_ROWS the tail collapses into one "other"
    // row. If that aggregation drops cost, every breakdown under the cap still
    // looks right — which is every test one would write by hand.
    const total = MAX_USAGE_MODEL_BREAKDOWN_ROWS + 20;
    // Rows sort by request count, so the priced model must land in the TAIL to
    // prove the aggregation sums cost rather than merely carrying the head.
    // One request each keeps the order stable and puts the priced row last.
    const entries = Array.from({ length: total }, (_, i) => entry({
      ts: at + i,
      requestId: `overflow-${i}`,
      provider: "openai",
      model: i === total - 1 ? "gpt-5.5" : `unpriced-variant-${String(i).padStart(4, "0")}`,
      usageStatus: "reported",
      usage: { inputTokens: 1_000, outputTokens: 100 },
    }));
    const sum = summarizeUsage(entries, "30d", at + total);
    const day = sum.days.find(d => d.requests === total);
    expect(day).toBeDefined();
    expect(day!.models).toHaveLength(MAX_USAGE_MODEL_BREAKDOWN_ROWS);

    const other = day!.models.find(m => m.model === "other");
    expect(other).toBeDefined();
    expect(other!.estimatedCostUsd).toBeGreaterThan(0);

    const modelSum = day!.models.reduce((acc, m) => acc + (m.estimatedCostUsd ?? 0), 0);
    expect(day!.estimatedCostUsd).toBeCloseTo(modelSum, 10);
  });

  test.each([
    [0, 0],
    [150, 1],
  ])("overflow rows preserve cache reads and clamp cache hit rate (%d reads)", (cacheRead, expected) => {
    const total = MAX_USAGE_MODEL_BREAKDOWN_ROWS + 1;
    const entries = Array.from({ length: total }, (_, i) => entry({
      ts: at + i,
      requestId: `overflow-cache-${i}`,
      provider: "openai",
      model: i === total - 1 ? "overflow-cache-tail" : `overflow-cache-${String(i).padStart(4, "0")}`,
      usageStatus: "reported",
      usage: i === total - 1
        ? { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: cacheRead }
        : { inputTokens: 1, outputTokens: 1 },
    }));

    const sum = summarizeUsage(entries, "30d", at + total);
    const day = sum.days.find(d => d.requests === total);
    const other = day?.models.find(model => model.model === "other");
    expect(other?.cacheReadInputTokens).toBe(cacheRead);
    expect(other?.cacheHitRate).toBe(expected);
    expect(other).not.toHaveProperty("cacheObserved");

    const modelOther = sum.models.find(model => model.model === "other");
    expect(modelOther?.cacheReadInputTokens).toBe(cacheRead);
    expect(modelOther?.cacheHitRate).toBe(expected);
    expect(modelOther).not.toHaveProperty("cacheObserved");

    const provider = sum.providers.find(row => row.provider === "openai");
    expect(provider?.cacheReadInputTokens).toBe(cacheRead);
    expect(provider?.cacheHitRate).toBeCloseTo(cacheRead / (total + 99));
    expect(provider).not.toHaveProperty("cacheObserved");
  });
});

import { projectUsageSummary } from "../src/usage/summary";

describe("canonical range and surface constants", () => {
  test("the exported members match what the parsers accept", () => {
    expect([...USAGE_RANGES]).toEqual(["today", "7d", "30d", "all"]);
    expect([...USAGE_SURFACES]).toEqual(["all", "codex", "claude", "grok"]);
    for (const range of USAGE_RANGES) expect(parseRange(range)).toBe(range);
    for (const surface of USAGE_SURFACES) expect(parseUsageSurface(surface)).toBe(surface);
  });
});

describe("projectUsageSummary", () => {
  const at = Date.UTC(2026, 5, 28, 10, 0, 0);
  const priced = { inputTokens: 1_000, outputTokens: 100 };

  test("finds a provider that exists only past the breakdown cap", () => {
    // Breakdown rows past MAX_USAGE_MODEL_BREAKDOWN_ROWS collapse into a
    // synthetic "other" row. A projection over rows could not see through it,
    // so a real provider reported matched:false with zero cost.
    const total = MAX_USAGE_MODEL_BREAKDOWN_ROWS + 10;
    const entries = Array.from({ length: total }, (_, i) => entry({
      ts: at + i,
      requestId: `row-${i}`,
      provider: i === total - 1 ? "rare-provider" : "openai",
      model: i === total - 1 ? "rare-model" : `m-${String(i).padStart(4, "0")}`,
      usageStatus: "reported",
      usage: priced,
    }));
    const summary = summarizeUsage(entries, "30d", at + total);
    expect(summary.models.some(row => row.model === "other")).toBe(true);
    expect(summary.models.some(row => row.provider === "rare-provider")).toBe(false);

    const projected = projectUsageSummary(summary, { provider: "rare-provider" }, entries);
    expect(projected.filter?.matched).toBe(true);
    expect(projected.summary.requests).toBe(1);
    expect(projected.models.map(row => row.model)).toEqual(["rare-model"]);
  });

  test("a model filter narrows the provider row to the retained model", () => {
    // A provider row is a whole-provider aggregate. Passing it through a model
    // filter left providers[] reporting the provider's OTHER models while
    // models[] and the totals excluded them — one response contradicting
    // itself.
    const entries = [
      entry({ ts: at, requestId: "a", provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: priced }),
      entry({ ts: at + 1, requestId: "b", provider: "openai", model: "gpt-5.4", usageStatus: "reported", usage: { inputTokens: 5_000, outputTokens: 500 } }),
    ];
    const projected = projectUsageSummary(summarizeUsage(entries, "30d", at + 2), { model: "gpt-5.5" }, entries);
    expect(projected.models.map(row => row.model)).toEqual(["gpt-5.5"]);
    for (const row of projected.providers) {
      expect(row.requests).toBe(projected.summary.requests);
      expect(row.totalTokens).toBe(projected.summary.totalTokens);
    }
  });

  test("recomputes parent usage when filtering a combo to one attempt", () => {
    const combo = entry({
      ts: at,
      requestId: "filtered-combo-parent-usage",
      provider: "combo",
      model: "combo/native",
      usageStatus: "reported",
      usage: { inputTokens: 150, outputTokens: 15 },
      totalTokens: 165,
      attempts: [
        {
          ordinal: 1,
          provider: "openai",
          model: "gpt-5.5",
          adapter: "openai-responses",
          status: 200,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
          totalTokens: 110,
        },
        {
          ordinal: 2,
          provider: "anthropic",
          model: "claude-sonnet-5",
          adapter: "anthropic",
          status: 200,
          durationMs: 20,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 50, outputTokens: 5 },
          totalTokens: 55,
        },
      ],
    });
    const projected = projectUsageSummary(
      summarizeUsage([combo], "30d", at + 1),
      { model: "gpt-5.5" },
      [combo],
    );
    expect(projected.summary.inputTokens).toBe(100);
    expect(projected.summary.outputTokens).toBe(10);
    expect(projected.summary.totalTokens).toBe(110);
    expect(projected.days.flatMap(day => day.models).find(model => model.model === "gpt-5.5")?.totalTokens).toBe(110);
    expect(projected.models.find(model => model.model === "gpt-5.5")?.totalTokens).toBe(110);
  });

  test("unmetered and unpriced requests survive the projection", () => {
    // Counted per request rather than inferred from a model row's single
    // optional cost, which could not represent a model holding both priced and
    // unpriced requests and always reported zero unmetered.
    const entries = [
      entry({ ts: at, requestId: "priced", provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: priced }),
      entry({ ts: at + 1, requestId: "unmetered", provider: "openai", model: "gpt-5.5", usageStatus: "unreported" }),
    ];
    const unfiltered = summarizeUsage(entries, "30d", at + 2);
    const projected = projectUsageSummary(unfiltered, { provider: "openai" }, entries);
    expect(projected.summary.unmeteredRequests).toBe(unfiltered.summary.unmeteredRequests);
    expect(projected.summary.unmeteredRequests).toBe(1);
    expect(projected.summary.pricedRequests).toBe(unfiltered.summary.pricedRequests);
  });

  test("an unfiltered call is returned untouched", () => {
    const entries = [entry({ ts: at, usageStatus: "reported", usage: priced })];
    const summary = summarizeUsage(entries, "30d", at + 1);
    expect(projectUsageSummary(summary, { provider: null, model: null }, entries)).toBe(summary);
  });

  test("a combo contributes only its matching attempts to filtered totals", () => {
    // Keeping the whole entry because one attempt matched dragged the other
    // attempt's tokens and cost into the filtered totals: filtering a combo to
    // its cheap model reported the expensive model's spend as well.
    const entries = [entry({
      ts: at,
      requestId: "combo-1",
      provider: "combo",
      model: "combo",
      usageStatus: "reported",
      attempts: [
        { provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: priced },
        { provider: "openai", model: "gpt-5.4", usageStatus: "reported", usage: { inputTokens: 90_000, outputTokens: 9_000 } },
      ],
    } as Partial<PersistedUsageEntry> & { ts: number })];

    const alone = summarizeUsage(
      [entry({ ts: at, requestId: "solo", provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: priced })],
      "30d", at + 1,
    );
    const unfiltered = summarizeUsage(entries, "30d", at + 1);
    const projected = projectUsageSummary(unfiltered, { model: "gpt-5.5" }, entries);

    expect(unfiltered.summary.estimatedCostUsd).toBeGreaterThan(alone.summary.estimatedCostUsd);
    expect(projected.summary.estimatedCostUsd).toBeCloseTo(alone.summary.estimatedCostUsd, 10);
    expect(projected.models.map(row => row.model)).toEqual(["gpt-5.5"]);
    // A combo entry reports no top-level usage of its own — the tokens live on
    // its attempts — so the day/summary token total stays 0 here and the
    // meaningful assertion is on the retained attempt's own row.
    const retained = projected.models[0]!;
    expect(retained.totalTokens).toBe(alone.models[0]!.totalTokens);
    expect(retained.estimatedCostUsd).toBeCloseTo(alone.summary.estimatedCostUsd, 10);
    expect(projected.filter?.comboOverlap).toBe(true);
  });

  test("matched reflects the requested window, not the whole log", () => {
    // filter.matched drives the CLI's "no usage recorded" message, so a match
    // outside the requested range must not claim there is something to show.
    const yesterday = new Date(2026, 7, 21, 12, 0, 0).getTime();
    const midday = new Date(2026, 7, 22, 12, 0, 0).getTime();
    const entries = [entry({ ts: yesterday, requestId: "old", provider: "rare-provider", model: "m", usageStatus: "reported", usage: priced })];

    const today = projectUsageSummary(summarizeUsage(entries, "today", midday), { provider: "rare-provider" }, entries);
    expect(today.summary.requests).toBe(0);
    expect(today.filter?.matched).toBe(false);

    const wider = projectUsageSummary(summarizeUsage(entries, "30d", midday), { provider: "rare-provider" }, entries);
    expect(wider.summary.requests).toBe(1);
    expect(wider.filter?.matched).toBe(true);
  });

  test("filters by exact api key id before provider and model attribution", () => {
    const entries = [
      entry({ ts: at, requestId: "key-a-openai", apiKeyId: "Key-A", provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: priced, accountLogLabel: "main" }),
      entry({ ts: at + 1, requestId: "key-a-anthropic", apiKeyId: "Key-A", provider: "anthropic", model: "claude-opus", usageStatus: "reported", usage: priced, accountLogLabel: "pabc123" }),
      entry({ ts: at + 2, requestId: "key-b", apiKeyId: "key-a", provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: priced, accountLogLabel: "pffffff" }),
      entry({ ts: at + 3, requestId: "legacy", provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: priced }),
    ];
    const summary = summarizeUsage(entries, "30d", at + 4);

    const byKey = projectUsageSummary(summary, { apiKeyId: " Key-A " }, entries);
    expect(byKey.filter).toMatchObject({ apiKeyId: "Key-A", provider: null, model: null, matched: true });
    expect(byKey.summary.requests).toBe(2);
    expect(byKey.models).toHaveLength(2);
    expect(byKey.providers).toHaveLength(2);
    expect(byKey.accounts.map(row => row.accountLogLabel).sort()).toEqual(["main", "pabc123"]);

    const combined = projectUsageSummary(summary, {
      apiKeyId: "Key-A",
      provider: "OPENAI",
      model: "GPT-5.5",
    }, entries);
    expect(combined.summary.requests).toBe(1);
    expect(combined.models).toHaveLength(1);
    expect(combined.accounts).toEqual([]);

    const wrongCase = projectUsageSummary(summary, { apiKeyId: "key-a" }, entries);
    expect(wrongCase.summary.requests).toBe(1);
    expect(wrongCase.filter?.apiKeyId).toBe("key-a");
  });

  test("an absent api key id excludes legacy and environment-token rows", () => {
    const entries = [entry({ ts: at, requestId: "legacy", usageStatus: "reported", usage: priced })];
    const projected = projectUsageSummary(
      summarizeUsage(entries, "30d", at + 1),
      { apiKeyId: "missing-key" },
      entries,
    );
    expect(projected.filter).toMatchObject({ apiKeyId: "missing-key", matched: false });
    expect(projected.summary.requests).toBe(0);
    expect(projected.models).toEqual([]);
    expect(projected.providers).toEqual([]);
    expect(projected.accounts).toEqual([]);
  });
});

describe("parseUsageSurface", () => {
  test("accepts all / codex / claude", () => {
    expect(parseUsageSurface("all")).toBe("all");
    expect(parseUsageSurface("codex")).toBe("codex");
    expect(parseUsageSurface("claude")).toBe("claude");
  });

  test("defaults to all on null or unknown", () => {
    expect(parseUsageSurface(null)).toBe("all");
    expect(parseUsageSurface(undefined)).toBe("all");
    expect(parseUsageSurface("openai")).toBe("all");
    expect(parseUsageSurface("")).toBe("all");
  });
});

describe("summarizeUsage", () => {
  test("aggregates estimated cost via model-level prices and counts unpriced rows", () => {
    const entries: PersistedUsageEntry[] = [
      // priced via openai bundle model-level price (5/30): cost = (100*5 + 10*30)/1e6 = 0.0008
      entry({
        ts: FIXED_NOW - 1000,
        provider: "openai",
        model: "gpt-5.5",
        usageStatus: "reported",
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
      // priced via anthropic exact bundle (fable-5: 10/50/1/12.5)
      entry({
        ts: FIXED_NOW - 2000,
        provider: "anthropic",
        model: "claude-fable-5",
        usageStatus: "reported",
        usage: { inputTokens: 200, outputTokens: 20 },
      }),
      // unpriced: no price anywhere
      entry({
        ts: FIXED_NOW - 3000,
        provider: "nope",
        model: "nope-model",
        usageStatus: "reported",
        usage: { inputTokens: 5, outputTokens: 1 },
      }),
    ];
    const all = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(all.summary.pricedRequests).toBe(2);
    expect(all.summary.unpricedRequests).toBe(1);
    const expected = (100 * 5 + 10 * 30) / 1e6 + (200 * 10 + 20 * 50) / 1e6;
    expect(all.summary.estimatedCostUsd).toBeCloseTo(expected, 9);
    // range filtering also applies to the cost sum
    const none = summarizeUsage(entries, "7d", FIXED_NOW + 8 * 86_400_000);
    expect(none.summary.estimatedCostUsd).toBe(0);
    expect(none.summary.pricedRequests).toBe(0);
  });

  test("filters totals, days, models, and providers by persisted request surface", () => {
    const entries: PersistedUsageEntry[] = [
      entry({
        ts: FIXED_NOW - 1000,
        provider: "openai",
        model: "gpt-5.5",
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 2 },
        totalTokens: 12,
      }),
      entry({
        ts: FIXED_NOW - 2000,
        provider: "anthropic",
        model: "claude-fable-5",
        surface: "claude",
        usageStatus: "reported",
        usage: { inputTokens: 20, outputTokens: 4 },
        totalTokens: 24,
      }),
    ];

    const all = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(all.surface).toBe("all");
    expect(all.summary).toMatchObject({ requests: 2, totalTokens: 36 });
    expect(all.days.reduce((requests, day) => requests + day.requests, 0)).toBe(2);
    expect(all.models.map(model => model.model).sort()).toEqual(["claude-fable-5", "gpt-5.5"]);
    expect(all.providers.map(provider => provider.provider).sort()).toEqual(["anthropic", "openai"]);

    const codex = summarizeUsage(entries, "30d", FIXED_NOW, "codex");
    expect(codex.surface).toBe("codex");
    expect(codex.summary).toMatchObject({ requests: 1, totalTokens: 12 });
    expect(codex.days.reduce((requests, day) => requests + day.requests, 0)).toBe(1);
    expect(codex.models).toEqual([expect.objectContaining({ provider: "openai", model: "gpt-5.5", requests: 1 })]);
    expect(codex.providers).toEqual([expect.objectContaining({ provider: "openai", requests: 1 })]);

    const claude = summarizeUsage(entries, "30d", FIXED_NOW, "claude");
    expect(claude.surface).toBe("claude");
    expect(claude.summary).toMatchObject({ requests: 1, totalTokens: 24 });
    expect(claude.days.reduce((requests, day) => requests + day.requests, 0)).toBe(1);
    expect(claude.models).toEqual([expect.objectContaining({ provider: "anthropic", model: "claude-fable-5", requests: 1 })]);
    expect(claude.providers).toEqual([expect.objectContaining({ provider: "anthropic", requests: 1 })]);
  });

  test("missing usage does not inflate token totals", () => {
    const entries: PersistedUsageEntry[] = [
      entry({ ts: FIXED_NOW - 1000, usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 5 }, totalTokens: 15 }),
      entry({ ts: FIXED_NOW - 2000, usageStatus: "unreported" }),
      entry({ ts: FIXED_NOW - 3000, usageStatus: "unsupported" }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(sum.summary.requests).toBe(3);
    expect(sum.summary.measuredRequests).toBe(1);
    expect(sum.summary.reportedRequests).toBe(1);
    expect(sum.summary.unreportedRequests).toBe(1);
    expect(sum.summary.unsupportedRequests).toBe(1);
    expect(sum.summary.totalTokens).toBe(15);
    expect(sum.summary.inputTokens).toBe(10);
    expect(sum.summary.outputTokens).toBe(5);
  });

  test("attributes Codex usage and API-equivalent cost by stable account log label", () => {
    const entries: PersistedUsageEntry[] = [
      entry({
        ts: FIXED_NOW - 1_000,
        requestId: "added-explicit",
        provider: "openai-pabc123",
        accountLogLabel: "pabc123",
        usageStatus: "reported",
        usage: { inputTokens: 100, outputTokens: 10 },
        totalTokens: 110,
      }),
      entry({
        ts: FIXED_NOW - 2_000,
        requestId: "added-legacy",
        provider: "openai-pabc123",
        usageStatus: "estimated",
        usage: { inputTokens: 40, outputTokens: 5, estimated: true },
        totalTokens: 45,
      }),
      entry({
        ts: FIXED_NOW - 3_000,
        requestId: "main-explicit",
        provider: "openai",
        accountLogLabel: "main",
        usageStatus: "reported",
        usage: { inputTokens: 20, outputTokens: 2 },
        totalTokens: 22,
      }),
      entry({
        ts: FIXED_NOW - 4_000,
        requestId: "main-legacy",
        provider: "openai-main",
        usageStatus: "reported",
        usage: { inputTokens: 30, outputTokens: 3 },
        totalTokens: 33,
      }),
      entry({
        ts: FIXED_NOW - 5_000,
        requestId: "legacy-bare",
        provider: "openai",
        usageStatus: "unreported",
      }),
      entry({
        ts: FIXED_NOW - 6_000,
        requestId: "custom-selector-explicit",
        provider: "openai-side",
        accountLogLabel: "pffffff",
        usageStatus: "reported",
        usage: { inputTokens: 500, outputTokens: 50 },
        totalTokens: 550,
      }),
    ];

    const sum = summarizeUsage(entries, "30d", FIXED_NOW, "codex");
    expect(sum.accounts.map(row => row.accountLogLabel).sort()).toEqual([
      "legacy-ambiguous",
      "main",
      "pabc123",
      "pffffff",
    ]);
    expect(sum.accounts.find(row => row.accountLogLabel === "pabc123")).toMatchObject({
      requests: 2,
      attemptCount: 2,
      measuredAttempts: 2,
      reportedAttempts: 1,
      estimatedAttempts: 1,
      totalTokens: 155,
      inputTokens: 140,
      outputTokens: 15,
      usageCoverageRatio: 1,
      priceCoverageRatio: 1,
    });
    expect(sum.accounts.find(row => row.accountLogLabel === "pabc123")?.estimatedCostUsd)
      .toBeCloseTo((140 * 5 + 15 * 30) / 1e6, 9);
    expect(sum.accounts.find(row => row.accountLogLabel === "main")).toMatchObject({
      requests: 2,
      totalTokens: 55,
      ambiguous: false,
    });
    expect(sum.accounts.find(row => row.accountLogLabel === "pffffff")).toMatchObject({
      requests: 1,
      totalTokens: 550,
      ambiguous: false,
    });
    expect(sum.accounts.find(row => row.accountLogLabel === "legacy-ambiguous")).toMatchObject({
      requests: 1,
      unmeteredAttempts: 1,
      totalTokens: 0,
      usageCoverageRatio: 0,
      ambiguous: true,
    });
  });

  test("attributes combo attempts to the account that physically served each attempt", () => {
    const combo = entry({
      ts: FIXED_NOW - 1_000,
      requestId: "combo-two-accounts",
      provider: "combo",
      model: "combo/native",
      usageStatus: "reported",
      usage: { inputTokens: 33, outputTokens: 3 },
      totalTokens: 36,
      attempts: [
        {
          ordinal: 1,
          provider: "openai-p111111",
          model: "gpt-5.5",
          adapter: "openai-responses",
          accountLogLabel: "p111111",
          status: 502,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 11, outputTokens: 1 },
          totalTokens: 12,
        },
        {
          ordinal: 2,
          provider: "openai-p222222",
          model: "gpt-5.5",
          adapter: "openai-responses",
          accountLogLabel: "p222222",
          status: 200,
          durationMs: 20,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 22, outputTokens: 2 },
          totalTokens: 24,
        },
      ],
    });

    const rows = summarizeUsage([combo], "30d", FIXED_NOW, "codex").accounts;
    expect(rows.find(row => row.accountLogLabel === "p111111")).toMatchObject({
      requests: 1,
      attemptCount: 1,
      totalTokens: 12,
    });
    expect(rows.find(row => row.accountLogLabel === "p222222")).toMatchObject({
      requests: 1,
      attemptCount: 1,
      totalTokens: 24,
    });
  });

  test("three OpenAI API Pro selections stay separate from their resolved base models", () => {
    const entries = ["sol", "terra", "luna"].map((family, index) => entry({
      ts: FIXED_NOW - index * 1000,
      provider: "openai-apikey",
      model: `gpt-5.6-${family}-pro`,
      resolvedModel: `gpt-5.6-${family}`,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    }));
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(sum.models.map(row => row.model).sort()).toEqual([
      "gpt-5.6-luna-pro", "gpt-5.6-sol-pro", "gpt-5.6-terra-pro",
    ]);
    expect(sum.models).toHaveLength(3);
  });

  test("estimated usage is counted separately while still contributing tokens", () => {
    const entries: PersistedUsageEntry[] = [
      entry({ ts: FIXED_NOW - 1000, provider: "kiro", usageStatus: "estimated", usage: { inputTokens: 9, outputTokens: 4, estimated: true }, totalTokens: 13 }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(sum.summary.requests).toBe(1);
    expect(sum.summary.measuredRequests).toBe(1);
    expect(sum.summary.reportedRequests).toBe(0);
    expect(sum.summary.estimatedRequests).toBe(1);
    expect(sum.summary.coverageRatio).toBe(1);
    expect(sum.summary.totalTokens).toBe(13);
    expect(sum.models[0]).toMatchObject({
      provider: "kiro",
      requests: 1,
      measuredRequests: 1,
      reportedRequests: 0,
      estimatedRequests: 1,
      totalTokens: 13,
    });
    expect(sum.providers[0]).toMatchObject({
      provider: "kiro",
      requests: 1,
      measuredRequests: 1,
      reportedRequests: 0,
      estimatedRequests: 1,
      totalTokens: 13,
    });
  });

  test("cached input tokens aggregate separately from total tokens", () => {
    const entries: PersistedUsageEntry[] = [
      entry({
        ts: FIXED_NOW - 1000,
        provider: "anthropic",
        usageStatus: "reported",
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
        totalTokens: 120,
      }),
      entry({
        ts: FIXED_NOW - 2000,
        provider: "kiro",
        usageStatus: "estimated",
        usage: { inputTokens: 30, outputTokens: 5, cachedInputTokens: 10, estimated: true },
        totalTokens: 35,
      }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);

    expect(sum.summary.cachedInputTokens).toBe(50);
    expect(sum.summary.inputTokens).toBe(130);
    expect(sum.summary.outputTokens).toBe(25);
    expect(sum.summary.totalTokens).toBe(155);
    expect(sum.summary.reportedRequests).toBe(1);
    expect(sum.summary.estimatedRequests).toBe(1);
  });

  test("Anthropic cache read and write tokens split without inflating display totals", () => {
    const entries: PersistedUsageEntry[] = [
      entry({
        ts: FIXED_NOW - 1000,
        provider: "anthropic",
        usageStatus: "reported",
        usage: {
          // canonical convention: inputTokens is inclusive of cache read + write
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 50,
          cacheReadInputTokens: 50,
          cacheCreationInputTokens: 20,
        },
        totalTokens: 120,
      }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);

    expect(sum.summary.cachedInputTokens).toBe(50);
    expect(sum.summary.cacheReadInputTokens).toBe(50);
    expect(sum.summary.cacheCreationInputTokens).toBe(20);
    expect(sum.summary.totalTokens).toBe(120);
    expect(sum.days.find(day => day.requests === 1)?.totalTokens).toBe(120);
    expect(sum.models[0].totalTokens).toBe(120);
    expect(sum.providers[0].totalTokens).toBe(120);
  });

  test("legacy combined cachedInputTokens rows recover reads by subtracting the write share", () => {
    // Pre-070 claude-route rows stored cachedInputTokens = read + write with only the
    // creation split present (devlog 070).
    const entries: PersistedUsageEntry[] = [
      entry({
        ts: FIXED_NOW - 1000,
        provider: "anthropic",
        usageStatus: "reported",
        usage: {
          inputTokens: 744002,
          outputTokens: 1875,
          totalTokens: 745877,
          cachedInputTokens: 743998,
          cacheCreationInputTokens: 743998,
        },
        totalTokens: 1489875,
      }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);

    expect(sum.summary.cacheReadInputTokens).toBe(0);
    expect(sum.summary.cacheCreationInputTokens).toBe(743998);
    // the inflated outer total is healed by the inner usage.totalTokens
    expect(sum.summary.totalTokens).toBe(745877);
  });

  test("Kiro estimated totals count as measured for coverage and model rows", () => {
    const entries: PersistedUsageEntry[] = [
      entry({
        ts: FIXED_NOW - 1000,
        provider: "kiro",
        model: "claude-opus-4.8",
        usageStatus: "estimated",
        usage: { inputTokens: 15_256, outputTokens: 1_018, estimated: true },
        totalTokens: 2_879_320_000,
      }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);

    expect(sum.summary).toMatchObject({
      requests: 1,
      measuredRequests: 1,
      reportedRequests: 0,
      estimatedRequests: 1,
      coverageRatio: 1,
      totalTokens: 2_879_320_000,
    });
    expect(sum.models[0]).toMatchObject({
      provider: "kiro",
      model: "claude-opus-4.8",
      requests: 1,
      measuredRequests: 1,
      reportedRequests: 0,
      estimatedRequests: 1,
      totalTokens: 2_879_320_000,
    });
  });

  test("days grid covers the full range with zero-fill", () => {
    const entries: PersistedUsageEntry[] = [
      entry({ ts: FIXED_NOW - 1000, usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2 }),
    ];
    const sum = summarizeUsage(entries, "7d", FIXED_NOW);
    expect(sum.days).toHaveLength(7);
    const nonZero = sum.days.filter(d => d.requests > 0);
    expect(nonZero).toHaveLength(1);
    expect(nonZero[0].totalTokens).toBe(2);
    expect(sum.days.every(d => typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date))).toBe(true);
  });

  test("range filter drops entries outside the window", () => {
    const entries: PersistedUsageEntry[] = [
      entry({ ts: FIXED_NOW - 1 * 86400000, usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2 }),
      entry({ ts: FIXED_NOW - 10 * 86400000, usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2 }),
    ];
    const week = summarizeUsage(entries, "7d", FIXED_NOW);
    expect(week.summary.requests).toBe(1);
    expect(week.summary.totalTokens).toBe(2);
    const month = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(month.summary.requests).toBe(2);
    expect(month.summary.totalTokens).toBe(4);
  });

  test("range filtering compares numeric day boundaries for years before 1000", () => {
    const ancient = Date.UTC(999, 0, 1, 12, 0, 0);
    const entries: PersistedUsageEntry[] = [
      entry({ ts: FIXED_NOW - 1, requestId: "current", usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2 }),
      entry({ ts: ancient, requestId: "ancient", usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 10 }, totalTokens: 20 }),
    ];

    const month = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(month.summary.requests).toBe(1);
    expect(month.summary.totalTokens).toBe(2);
    expect(month.models.every(model => model.totalTokens !== 20)).toBe(true);

    const all = summarizeUsage(entries, "all", FIXED_NOW);
    expect(all.summary.requests).toBe(2);
    expect(all.summary.totalTokens).toBe(22);
    expect(all.days).toHaveLength(MAX_USAGE_DAY_BUCKETS);
  });

  test("coverageRatio stays in [0,1] and handles empty input", () => {
    expect(summarizeUsage([], "30d", FIXED_NOW).summary.coverageRatio).toBe(0);
    const onlyMissing = summarizeUsage([entry({ ts: FIXED_NOW - 1, usageStatus: "unreported" })], "30d", FIXED_NOW);
    expect(onlyMissing.summary.coverageRatio).toBe(0);
    const half = summarizeUsage([
      entry({ ts: FIXED_NOW - 1, usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2 }),
      entry({ ts: FIXED_NOW - 2, usageStatus: "unreported" }),
    ], "30d", FIXED_NOW);
    expect(half.summary.coverageRatio).toBe(0.5);
  });

  test("models and providers are aggregated and share-sorted", () => {
    const entries: PersistedUsageEntry[] = [
      entry({ ts: FIXED_NOW - 1, provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 4, outputTokens: 2 }, totalTokens: 6 }),
      entry({ ts: FIXED_NOW - 2, provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 2, outputTokens: 1 }, totalTokens: 3 }),
      entry({ ts: FIXED_NOW - 3, provider: "anthropic", model: "claude-x", usageStatus: "unreported" }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(sum.models[0].model).toBe("gpt-5.5");
    expect(sum.models[0].requests).toBe(2);
    expect(sum.models[0].totalTokens).toBe(9);
    expect(sum.providers[0].provider).toBe("openai");
    expect(sum.providers[0].shareRatio).toBeCloseTo(1);
  });

  test("merges OpenAI passthrough and ChatGPT main/pool usage into one provider/model row", () => {
    const entries: PersistedUsageEntry[] = [
      entry({ ts: FIXED_NOW - 1, provider: "openai", model: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 4, outputTokens: 1 }, totalTokens: 5 }),
      entry({ ts: FIXED_NOW - 2, provider: "chatgpt", model: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 3, outputTokens: 1 }, totalTokens: 4 }),
      entry({ ts: FIXED_NOW - 3, provider: "chatgpt-main", model: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2 }),
      entry({ ts: FIXED_NOW - 4, provider: "chatgpt-p104398", model: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 2, outputTokens: 1 }, totalTokens: 3 }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(sum.providers).toHaveLength(1);
    expect(sum.providers[0]).toMatchObject({ provider: "openai", requests: 4, totalTokens: 14 });
    expect(sum.models).toHaveLength(1);
    expect(sum.models[0]).toMatchObject({ provider: "openai", model: "gpt-5.5", requests: 4, totalTokens: 14 });
    expect(sum.days.find(day => day.requests === 4)?.models).toMatchObject([
      { provider: "openai", model: "gpt-5.5", requests: 4, attemptCount: 4, totalTokens: 14, estimatedCostUsd: 0.00017 },
    ]);
  });

  test("keeps one logical combo request while attributing both physical attempts", () => {
    const combo = entry({
      ts: FIXED_NOW - 1,
      requestId: "combo-parent",
      provider: "combo",
      model: "combo/free",
      usageStatus: "estimated",
      usage: { inputTokens: 110, outputTokens: 2, totalTokens: 112, estimated: true },
      totalTokens: 112,
      attempts: [
        {
          ordinal: 1,
          provider: "a",
          model: "model-a",
          adapter: "openai-chat",
          status: 503,
          durationMs: 4,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "estimated",
          inputTokenEstimate: 100,
          usage: { inputTokens: 100, outputTokens: 0, estimated: true },
          totalTokens: 100,
        },
        {
          ordinal: 2,
          provider: "b",
          model: "model-b",
          adapter: "openai-chat",
          status: 200,
          durationMs: 3,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 10, outputTokens: 2 },
          totalTokens: 12,
        },
      ],
    });
    const sum = summarizeUsage([combo], "30d", FIXED_NOW);
    expect(sum.summary).toMatchObject({
      requests: 1,
      attemptCount: 2,
      measuredRequests: 1,
      estimatedRequests: 1,
      totalTokens: 112,
    });
    expect(sum.providers).toEqual([
      expect.objectContaining({ provider: "a", requests: 1, attemptCount: 1, totalTokens: 100 }),
      expect.objectContaining({ provider: "b", requests: 1, attemptCount: 1, totalTokens: 12 }),
    ]);
    expect(sum.providers.some(provider => provider.provider === "combo")).toBe(false);
    expect(sum.days.find(day => day.requests === 1)?.models).toMatchObject([
      { provider: "a", model: "model-a", requests: 1, attemptCount: 1, totalTokens: 100 },
      { provider: "b", model: "model-b", requests: 1, attemptCount: 1, totalTokens: 12 },
    ]);
  });

  test("counts same-provider attempts once per parent request", () => {
    const pair = (requestId: string, allReported: boolean): PersistedUsageEntry => entry({
      ts: FIXED_NOW - (allReported ? 2 : 1),
      requestId,
      provider: "combo",
      model: "combo/free",
      usageStatus: allReported ? "reported" : "estimated",
      usage: { inputTokens: 12, outputTokens: 2, ...(allReported ? {} : { estimated: true }) },
      totalTokens: 14,
      attempts: [
        {
          ordinal: 1,
          provider: "a",
          model: "m1",
          adapter: "openai-chat",
          status: 503,
          durationMs: 1,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: allReported ? "reported" : "estimated",
          usage: { inputTokens: 5, outputTokens: 0, ...(allReported ? {} : { estimated: true }) },
          totalTokens: 5,
        },
        {
          ordinal: 2,
          provider: "a",
          model: "m2",
          adapter: "openai-chat",
          status: 200,
          durationMs: 1,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 7, outputTokens: 2 },
          totalTokens: 9,
        },
      ],
    });

    const mixed = summarizeUsage([pair("mixed", false)], "30d", FIXED_NOW).providers[0]!;
    expect(mixed).toMatchObject({
      provider: "a",
      requests: 1,
      attemptCount: 2,
      measuredRequests: 1,
      reportedRequests: 0,
      estimatedRequests: 1,
    });
    const reported = summarizeUsage([pair("reported", true)], "30d", FIXED_NOW).providers[0]!;
    expect(reported).toMatchObject({
      provider: "a",
      requests: 1,
      attemptCount: 2,
      measuredRequests: 1,
      reportedRequests: 1,
      estimatedRequests: 0,
    });
  });

  test("legacy entries gain exactly one attempt without changing logical totals", () => {
    const legacy = entry({
      ts: FIXED_NOW - 1,
      usageStatus: "reported",
      usage: { inputTokens: 2, outputTokens: 1 },
      totalTokens: 3,
    });
    const sum = summarizeUsage([legacy], "30d", FIXED_NOW);
    expect(sum.summary).toMatchObject({ requests: 1, attemptCount: 1, totalTokens: 3 });
    expect(sum.models[0]).toMatchObject({ requests: 1, attemptCount: 1, totalTokens: 3 });
    expect(sum.providers[0]).toMatchObject({ requests: 1, attemptCount: 1, totalTokens: 3 });
  });

  test("merges reported and unreported rows of the same model into one row", () => {
    // Reported upstream rows carry resolvedModel; unreported rows (no usage) often do not. They
    // must still collapse into a single model row whose reportedRequests < requests.
    const entries: PersistedUsageEntry[] = [
      entry({ ts: FIXED_NOW - 1, provider: "openai", model: "gpt-5.5", resolvedModel: "gpt-5.5", usageStatus: "reported", usage: { inputTokens: 4, outputTokens: 2 }, totalTokens: 6 }),
      entry({ ts: FIXED_NOW - 2, provider: "openai", model: "gpt-5.5", usageStatus: "unreported" }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(sum.models).toHaveLength(1);
    expect(sum.models[0]).toMatchObject({ provider: "openai", model: "gpt-5.5", requests: 2, reportedRequests: 1, totalTokens: 6 });
  });

  test("all range keeps everything and reports since=null", () => {
    const entries: PersistedUsageEntry[] = [
      entry({ ts: FIXED_NOW - 365 * 86400000, usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2 }),
    ];
    const sum = summarizeUsage(entries, "all", FIXED_NOW);
    expect(sum.since).toBeNull();
    expect(sum.summary.requests).toBe(1);
    expect(sum.summary.totalTokens).toBe(2);
  });

  test("collapses google-antigravity suffix/compat wire ids into picker/call base models", () => {
    const entries: PersistedUsageEntry[] = [
      entry({
        ts: FIXED_NOW - 1,
        requestId: "ag-flash-high",
        provider: "google-antigravity",
        model: "gemini-3.5-flash-high",
        resolvedModel: "gemini-3.5-flash-high",
        usageStatus: "reported",
        usage: { inputTokens: 1000, outputTokens: 100 },
        totalTokens: 1100,
      }),
      entry({
        ts: FIXED_NOW - 2,
        requestId: "ag-flash-low",
        provider: "google-antigravity",
        model: "gemini-3.5-flash-low",
        resolvedModel: "gemini-3.5-flash-low",
        usageStatus: "reported",
        usage: { inputTokens: 500, outputTokens: 50 },
        totalTokens: 550,
      }),
      entry({
        ts: FIXED_NOW - 3,
        requestId: "ag-flash-agent",
        provider: "google-antigravity",
        model: "gemini-3-flash-agent",
        resolvedModel: "gemini-3-flash-agent",
        usageStatus: "reported",
        usage: { inputTokens: 100, outputTokens: 10 },
        totalTokens: 110,
      }),
      entry({
        ts: FIXED_NOW - 4,
        requestId: "ag-pro-agent",
        provider: "google-antigravity",
        model: "gemini-pro-agent",
        resolvedModel: "gemini-pro-agent",
        usageStatus: "reported",
        usage: { inputTokens: 2000, outputTokens: 200 },
        totalTokens: 2200,
      }),
      entry({
        ts: FIXED_NOW - 5,
        requestId: "ag-pro-low",
        provider: "google-antigravity",
        model: "gemini-3.1-pro-low",
        usageStatus: "reported",
        usage: { inputTokens: 300, outputTokens: 30 },
        totalTokens: 330,
      }),
      entry({
        ts: FIXED_NOW - 6,
        requestId: "ag-unknown",
        provider: "google-antigravity",
        model: "future-cca-model",
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 1 },
        totalTokens: 11,
      }),
      entry({
        ts: FIXED_NOW - 7,
        requestId: "openai-virtual",
        provider: "openai",
        model: "gpt-5.6-sol-pro",
        resolvedModel: "gpt-5.6-sol",
        usageStatus: "reported",
        usage: { inputTokens: 40, outputTokens: 4 },
        totalTokens: 44,
      }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);
    const byModel = Object.fromEntries(sum.models.map(m => [`${m.provider}/${m.model}`, m]));

    // Retired Flash ids keep their own usage identity. Routing now sends these ids to
    // 3.7, but a historical row records the model the user actually called — collapsing
    // them into the successor would move past spend onto a model that did not exist yet.
    expect(byModel["google-antigravity/gemini-3.5-flash-high"]).toMatchObject({
      model: "gemini-3.5-flash-high",
      requests: 1,
      totalTokens: 1100,
    });
    expect(byModel["google-antigravity/gemini-3.5-flash-low"]).toMatchObject({
      model: "gemini-3.5-flash-low",
      requests: 1,
      totalTokens: 550,
    });
    expect(byModel["google-antigravity/gemini-3-flash-agent"]).toMatchObject({
      model: "gemini-3-flash-agent",
      requests: 1,
      totalTokens: 110,
    });
    expect(byModel["google-antigravity/gemini-3.7-flash"]).toBeUndefined();

    expect(byModel["google-antigravity/gemini-3.1-pro"]).toMatchObject({
      provider: "google-antigravity",
      model: "gemini-3.1-pro",
      requests: 2,
      totalTokens: 2530,
    });
    expect(byModel["google-antigravity/gemini-3.1-pro"]?.resolvedModel).toBeUndefined();
    expect(byModel["google-antigravity/gemini-3.1-pro"]?.estimatedCostUsd).toBeGreaterThan(0);

    expect(byModel["google-antigravity/future-cca-model"]).toMatchObject({
      model: "future-cca-model",
      requests: 1,
      totalTokens: 11,
    });

    expect(byModel["openai/gpt-5.6-sol-pro"]).toMatchObject({
      model: "gpt-5.6-sol-pro",
      requests: 1,
      totalTokens: 44,
    });

    const day = sum.days.find(d => d.requests > 0)!;
    const dayModels = Object.fromEntries(day.models.map(m => [`${m.provider}/${m.model}`, m]));
    expect(dayModels["google-antigravity/gemini-3.5-flash-high"]?.requests).toBe(1);
    expect(dayModels["google-antigravity/gemini-3.1-pro"]?.requests).toBe(2);
  });

  test("keeps a retired antigravity model's history under its own id", () => {
    const entries: PersistedUsageEntry[] = [
      entry({
        ts: FIXED_NOW - 1,
        requestId: "base-call",
        provider: "google-antigravity",
        model: "gemini-3.6-flash",
        resolvedModel: "gemini-3.6-flash-high",
        usageStatus: "reported",
        usage: { inputTokens: 100, outputTokens: 10 },
        totalTokens: 110,
      }),
      entry({
        ts: FIXED_NOW - 2,
        requestId: "suffix-call",
        provider: "google-antigravity",
        model: "gemini-3.6-flash-high",
        usageStatus: "reported",
        usage: { inputTokens: 50, outputTokens: 5 },
        totalTokens: 55,
      }),
    ];
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);
    const byModel = Object.fromEntries(sum.models.map(m => [m.model, m]));
    expect(byModel["gemini-3.6-flash"]).toMatchObject({
      provider: "google-antigravity",
      model: "gemini-3.6-flash",
      requests: 1,
      totalTokens: 110,
    });
    expect(byModel["gemini-3.6-flash-high"]).toMatchObject({
      model: "gemini-3.6-flash-high",
      requests: 1,
      totalTokens: 55,
    });
  });

  test("caps top-level and per-day model breakdowns with a lossless other bucket", () => {
    const entries = Array.from({ length: 260 }, (_, index) => entry({
      ts: FIXED_NOW - index,
      requestId: index >= 255 ? "shared-overflow-request" : `request-${index}`,
      provider: `provider-${index}`,
      model: `model-${index}`,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    }));
    const sum = summarizeUsage(entries, "30d", FIXED_NOW);
    expect(sum.models).toHaveLength(256);
    expect(sum.days.find(day => day.requests > 0)?.models).toHaveLength(256);
    expect(sum.models.at(-1)).toMatchObject({
      provider: "other",
      model: "other",
      requests: 1,
      attemptCount: 5,
      measuredRequests: 1,
      reportedRequests: 1,
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
    });
    expect(sum.days.find(day => day.requests > 0)?.models.at(-1)).toMatchObject({
      provider: "other",
      model: "other",
      requests: 1,
      attemptCount: 5,
      totalTokens: 10,
    });
  });

  test("7d and 30d range windows align to calendar day boundaries (00:00:00) so completed days remain stable (#1580)", () => {
    // Construct local midnight for 2026-08-13
    const todayMidnight = new Date(2026, 7, 13, 0, 0, 0, 0).getTime();
    const dayMs = 86_400_000;

    // Day -29 (2026-07-15) at 04:00 AM (for 30d boundary)
    const dayMinus29Date = new Date(todayMidnight);
    dayMinus29Date.setDate(dayMinus29Date.getDate() - 29);
    dayMinus29Date.setHours(4, 0, 0, 0);
    const dayMinus29Ts = dayMinus29Date.getTime();

    // Day -6 (2026-08-07) at 02:30 AM (for 7d boundary)
    const dayMinus6Early = todayMidnight - 6 * dayMs + 2.5 * 3600_000;
    // Yesterday (2026-08-12) at 03:00 AM
    const yesterdayEarly = todayMidnight - 1 * dayMs + 3 * 3600_000;
    // Yesterday (2026-08-12) at 19:00 PM
    const yesterdayLate = todayMidnight - 1 * dayMs + 19 * 3600_000;
    // Today (2026-08-13) at 08:00 AM
    const todayMorning = todayMidnight + 8 * 3600_000;

    const entries: PersistedUsageEntry[] = [
      entry({ ts: dayMinus29Ts, usageStatus: "reported", usage: { inputTokens: 600, outputTokens: 600 }, totalTokens: 1200 }),
      entry({ ts: dayMinus6Early, usageStatus: "reported", usage: { inputTokens: 250, outputTokens: 250 }, totalTokens: 500 }),
      entry({ ts: yesterdayEarly, usageStatus: "reported", usage: { inputTokens: 400, outputTokens: 400 }, totalTokens: 800 }),
      entry({ ts: yesterdayLate, usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 100 }, totalTokens: 200 }),
      entry({ ts: todayMorning, usageStatus: "reported", usage: { inputTokens: 150, outputTokens: 150 }, totalTokens: 300 }),
    ];

    // Summary at 09:00 AM today (7d)
    const sumMorning7d = summarizeUsage(entries, "7d", todayMidnight + 9 * 3600_000);
    const day6Morning = sumMorning7d.days.find(d => d.date.endsWith("08-07"))?.totalTokens;
    const yesterdayMorningTotal = sumMorning7d.days.find(d => d.date.endsWith("08-12"))?.totalTokens;

    expect(day6Morning).toBe(500);
    expect(yesterdayMorningTotal).toBe(1000);

    // Summary at 09:00 AM today (30d)
    const sumMorning30d = summarizeUsage(entries, "30d", todayMidnight + 9 * 3600_000);
    const day29Morning = sumMorning30d.days.find(d => d.date.endsWith("07-15"))?.totalTokens;
    expect(sumMorning30d.days).toHaveLength(30);
    expect(day29Morning).toBe(1200);

    // Summary at 23:30 PM today (later in the day) with an additional turn today
    const todayEvening = todayMidnight + 20 * 3600_000;
    const entriesLater = [
      ...entries,
      entry({ ts: todayEvening, usageStatus: "reported", usage: { inputTokens: 50, outputTokens: 50 }, totalTokens: 100 }),
    ];

    // 7d evening
    const sumEvening7d = summarizeUsage(entriesLater, "7d", todayMidnight + 23.5 * 3600_000);
    const day6Evening = sumEvening7d.days.find(d => d.date.endsWith("08-07"))?.totalTokens;
    const yesterdayEveningTotal = sumEvening7d.days.find(d => d.date.endsWith("08-12"))?.totalTokens;
    const todayEveningTotal = sumEvening7d.days.find(d => d.date.endsWith("08-13"))?.totalTokens;

    // Critical assertion: completed days NEVER lose tokens as hours progress in 7d
    expect(day6Evening).toBe(500);
    expect(yesterdayEveningTotal).toBe(1000);
    expect(todayEveningTotal).toBe(400); // 300 + 100
    expect(sumMorning7d.since).toBe(sumEvening7d.since);

    // 30d evening
    const sumEvening30d = summarizeUsage(entriesLater, "30d", todayMidnight + 23.5 * 3600_000);
    const day29Evening = sumEvening30d.days.find(d => d.date.endsWith("07-15"))?.totalTokens;
    expect(sumEvening30d.days).toHaveLength(30);
    expect(day29Evening).toBe(1200);
    expect(sumMorning30d.since).toBe(sumEvening30d.since);
  });

  test("exposes per-provider, per-model, and per-day cache counters and price coverage (#1820)", () => {
    const entries: PersistedUsageEntry[] = [
      entry({
        ts: FIXED_NOW - 1000,
        provider: "anthropic",
        model: "claude-sonnet-5",
        usageStatus: "reported",
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 600,
          cacheCreationInputTokens: 300,
        },
      }),
      entry({
        ts: FIXED_NOW - 2000,
        provider: "anthropic",
        model: "claude-sonnet-5",
        usageStatus: "reported",
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          cacheReadInputTokens: 0,
        },
      }),
      entry({
        ts: FIXED_NOW - 3000,
        provider: "unpriced-prov",
        model: "unpriced-model",
        usageStatus: "reported",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      }),
    ];

    const summary = summarizeUsage(entries, "7d", FIXED_NOW);

    // Model-level assertions
    const sonnet = summary.models.find(m => m.model === "claude-sonnet-5");
    expect(sonnet).toBeDefined();
    expect(sonnet?.inputTokens).toBe(1500);
    expect(sonnet?.outputTokens).toBe(300);
    expect(sonnet?.cacheReadInputTokens).toBe(600);
    expect(sonnet?.cacheCreationInputTokens).toBe(300);
    expect(sonnet?.cacheHitRate).toBeCloseTo(600 / 1500);
    expect(sonnet).not.toHaveProperty("cacheObserved");

    const unpricedModel = summary.models.find(m => m.model === "unpriced-model");
    expect(unpricedModel).toBeDefined();
    expect(unpricedModel?.cacheHitRate).toBeNull();
    expect(unpricedModel?.priceCoverageRatio).toBe(0);

    // Provider-level assertions
    const anthropicProv = summary.providers.find(p => p.provider === "anthropic");
    expect(anthropicProv).toBeDefined();
    expect(anthropicProv?.inputTokens).toBe(1500);
    expect(anthropicProv?.outputTokens).toBe(300);
    expect(anthropicProv?.cacheReadInputTokens).toBe(600);
    expect(anthropicProv?.cacheCreationInputTokens).toBe(300);
    expect(anthropicProv?.cacheHitRate).toBeCloseTo(600 / 1500);
    expect(anthropicProv).not.toHaveProperty("cacheObserved");

    // Day model assertions
    const day = summary.days.find(d => d.models.some(m => m.model === "claude-sonnet-5"));
    expect(day).toBeDefined();
    const daySonnet = day?.models.find(m => m.model === "claude-sonnet-5");
    expect(daySonnet?.inputTokens).toBe(1500);
    expect(daySonnet?.outputTokens).toBe(300);
    expect(daySonnet?.cacheReadInputTokens).toBe(600);
    expect(daySonnet?.cacheCreationInputTokens).toBe(300);
    expect(daySonnet?.cacheHitRate).toBeCloseTo(600 / 1500);
    expect(daySonnet?.estimatedCostUsd).toBeGreaterThan(0);
    expect(daySonnet).not.toHaveProperty("cacheObserved");

    const dayUnpriced = summary.days
      .flatMap(d => d.models)
      .find(m => m.model === "unpriced-model");
    expect(dayUnpriced?.cacheHitRate).toBeNull();
  });

  test("clamps cache hit rate when cache reads exceed input tokens", () => {
    const sum = summarizeUsage([
      entry({
        ts: FIXED_NOW - 1000,
        provider: "anthropic",
        model: "claude-sonnet-5",
        usageStatus: "reported",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 150 },
      }),
    ], "30d", FIXED_NOW);

    expect(sum.models[0]?.cacheHitRate).toBe(1);
  });

  test("attributes combo with mixed priced and unpriced attempts per attempt", () => {
    const combo = entry({
      ts: FIXED_NOW - 1000,
      requestId: "combo-mixed-pricing",
      provider: "combo",
      model: "combo/native",
      usageStatus: "reported",
      usage: { inputTokens: 150, outputTokens: 15 },
      totalTokens: 165,
      attempts: [
        {
          ordinal: 1,
          provider: "openai",
          model: "gpt-5.5",
          adapter: "openai-responses",
          status: 502,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 100, outputTokens: 10 },
          totalTokens: 110,
        },
        {
          ordinal: 2,
          provider: "unpriced-prov",
          model: "unpriced-model",
          adapter: "openai-responses",
          status: 200,
          durationMs: 20,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 50, outputTokens: 5 },
          totalTokens: 55,
        },
      ],
    });

    const sum = summarizeUsage([combo], "30d", FIXED_NOW);

    // Totals should include the priced attempt's cost and count as priced
    expect(sum.summary.pricedRequests).toBe(1);
    expect(sum.summary.unpricedRequests).toBe(0);
    const expectedCost = (100 * 5 + 10 * 30) / 1e6;
    expect(sum.summary.estimatedCostUsd).toBeCloseTo(expectedCost, 9);

    // Model breakdown
    const gptModel = sum.models.find(m => m.model === "gpt-5.5");
    expect(gptModel).toBeDefined();
    expect(gptModel?.pricedRequests).toBe(1);
    expect(gptModel?.unpricedRequests).toBe(0);
    expect(gptModel?.priceCoverageRatio).toBe(1);
    expect(gptModel?.estimatedCostUsd).toBeCloseTo(expectedCost, 9);

    const unpricedModel = sum.models.find(m => m.model === "unpriced-model");
    expect(unpricedModel).toBeDefined();
    expect(unpricedModel?.pricedRequests).toBe(0);
    expect(unpricedModel?.unpricedRequests).toBe(1);
    expect(unpricedModel?.priceCoverageRatio).toBe(0);
    expect(unpricedModel?.estimatedCostUsd).toBeUndefined();

    // Provider breakdown
    const openaiProv = sum.providers.find(p => p.provider === "openai");
    expect(openaiProv).toBeDefined();
    expect(openaiProv?.pricedRequests).toBe(1);
    expect(openaiProv?.estimatedCostUsd).toBeCloseTo(expectedCost, 9);

    const unpricedProv = sum.providers.find(p => p.provider === "unpriced-prov");
    expect(unpricedProv).toBeDefined();
    expect(unpricedProv?.unpricedRequests).toBe(1);
    expect(unpricedProv?.estimatedCostUsd).toBeUndefined();

    // Day models breakdown
    const day = sum.days.find(d => d.requests > 0);
    const dayGpt = day?.models.find(m => m.model === "gpt-5.5");
    expect(dayGpt?.estimatedCostUsd).toBeCloseTo(expectedCost, 9);
    const dayUnpriced = day?.models.find(m => m.model === "unpriced-model");
    expect(dayUnpriced?.estimatedCostUsd).toBeUndefined();
  });

});

describe("UsageSummaryAccumulator modes", () => {
  const at = Date.UTC(2026, 5, 28, 10, 0, 0);

  test("exact mode preserves cross-partition request identity", () => {
    const accumulator = createUsageSummaryAccumulator();
    accumulator.add(entry({
      ts: at - 3_600_000,
      requestId: "duplicate-request",
      accountLogLabel: "pabcdef",
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 2 },
    }));
    accumulator.add(entry({
      ts: at,
      requestId: "duplicate-request",
      surface: "claude",
      accountLogLabel: "pabcdef",
      usageStatus: "reported",
      usage: { inputTokens: 20, outputTokens: 3 },
    }));

    const summary = accumulator.summarize("all", at);
    expect(summary.summary.requests).toBe(2);
    expect(summary.days.find(day => day.requests > 0)).toMatchObject({
      requests: 2,
      totalTokens: 35,
      models: [{ requests: 1, attemptCount: 2, totalTokens: 35 }],
    });
    expect(summary.models[0]).toMatchObject({ requests: 1, attemptCount: 2, totalTokens: 35 });
    expect(summary.providers[0]).toMatchObject({ requests: 1, attemptCount: 2, totalTokens: 35 });
    expect(summary.accounts[0]).toMatchObject({ requests: 1, attemptCount: 2, totalTokens: 35 });
  });

  test("row-unique mode matches exact mode for unique ledger rows", () => {
    const rows = [
      entry({
        ts: at - 86_400_000,
        requestId: "unique-1",
        accountLogLabel: "pabcdef",
        usageStatus: "reported",
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
      entry({
        ts: at,
        requestId: "unique-2",
        surface: "claude",
        provider: "combo",
        model: "combo/native",
        usageStatus: "reported",
        usage: { inputTokens: 70, outputTokens: 7 },
        totalTokens: 77,
        attempts: [
          {
            ordinal: 1,
            provider: "openai",
            model: "gpt-5.5",
            adapter: "openai-responses",
            status: 200,
            durationMs: 10,
            sendCount: 1,
            recoveryKinds: [],
            accountLogLabel: "pabcdef",
            usageStatus: "reported",
            usage: { inputTokens: 50, outputTokens: 5 },
            totalTokens: 55,
          },
          {
            ordinal: 2,
            provider: "unpriced-provider",
            model: "unpriced-model",
            adapter: "openai-responses",
            status: 200,
            durationMs: 20,
            sendCount: 1,
            recoveryKinds: [],
            accountLogLabel: "p123abc",
            usageStatus: "estimated",
            usage: { inputTokens: 20, outputTokens: 2 },
            totalTokens: 22,
          },
        ],
      }),
    ];
    const exact = createUsageSummaryAccumulator();
    const compact = createUsageSummaryAccumulator({ mode: "row-unique" });
    for (const row of rows) {
      exact.add(row);
      compact.add(row);
    }

    expect(compact.summarize("all", at)).toEqual(exact.summarize("all", at));
  });

  test("row-unique mode counts a same-model/provider/account retry once", () => {
    const accumulator = createUsageSummaryAccumulator({ mode: "row-unique" });
    accumulator.add(entry({
      ts: at,
      requestId: "same-dimension-retry",
      provider: "combo",
      model: "combo/native",
      usageStatus: "reported",
      usage: { inputTokens: 30, outputTokens: 3 },
      totalTokens: 33,
      attempts: [1, 2].map(ordinal => ({
        ordinal,
        provider: "openai",
        model: "gpt-5.5",
        adapter: "openai-responses",
        status: 200,
        durationMs: 10,
        sendCount: 1,
        recoveryKinds: [],
        accountLogLabel: "pabcdef" as const,
        usageStatus: "reported" as const,
        usage: { inputTokens: 15, outputTokens: ordinal },
      })),
    }));

    const summary = accumulator.summarize("30d", at);
    expect(summary.models[0]).toMatchObject({ requests: 1, attemptCount: 2 });
    expect(summary.providers[0]).toMatchObject({ requests: 1, attemptCount: 2 });
    expect(summary.accounts[0]).toMatchObject({ requests: 1, attemptCount: 2 });
  });

  test("row-unique overflow folds a multi-model request only once", () => {
    const rows = Array.from({ length: MAX_USAGE_MODEL_BREAKDOWN_ROWS - 1 }, (_, index) => entry({
      ts: at + index,
      requestId: `overflow-head-${index}`,
      provider: "head-provider",
      model: `head-model-${String(index).padStart(3, "0")}`,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    rows.push(entry({
      ts: at + MAX_USAGE_MODEL_BREAKDOWN_ROWS,
      requestId: "overflow-combo",
      provider: "combo",
      model: "combo/native",
      usageStatus: "reported",
      attempts: [
        {
          ordinal: 1,
          provider: "openai",
          model: "gpt-5.5",
          adapter: "openai-responses",
          status: 200,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 10, outputTokens: 1 },
        },
        {
          ordinal: 2,
          provider: "unpriced-provider",
          model: "tail-unpriced",
          adapter: "openai-responses",
          status: 200,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "unreported",
        },
      ],
    }));
    const exact = createUsageSummaryAccumulator();
    const compact = createUsageSummaryAccumulator({ mode: "row-unique" });
    for (const row of rows) {
      exact.add(row);
      compact.add(row);
    }

    const exactSummary = exact.summarize("30d", at + MAX_USAGE_MODEL_BREAKDOWN_ROWS);
    const compactSummary = compact.summarize("30d", at + MAX_USAGE_MODEL_BREAKDOWN_ROWS);
    expect(compactSummary).toEqual(exactSummary);
    const other = compactSummary.models.find(model => model.model === "other");
    expect(other).toMatchObject({
      requests: 1,
      attemptCount: 2,
      measuredRequests: 0,
      reportedRequests: 0,
      pricedRequests: 1,
      unpricedRequests: 1,
    });
    const dayOther = compactSummary.days.find(day => day.requests > 0)?.models
      .find(model => model.model === "other");
    expect(dayOther).toMatchObject({ requests: 1, attemptCount: 2 });
  });

  test("filtered compact overflow preserves projection compatibility", () => {
    const accumulator = createUsageSummaryAccumulator({
      mode: "row-unique",
      filter: { provider: "rare-provider" },
    });
    const rows: PersistedUsageEntry[] = [];
    for (let index = 0; index < MAX_USAGE_MODEL_BREAKDOWN_ROWS + 1; index++) {
      const row = entry({
        ts: at + index,
        requestId: `filtered-overflow-${index}`,
        provider: "rare-provider",
        model: `rare-model-${index}`,
        usageStatus: "reported",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      rows.push(row);
      accumulator.add(row);
    }

    const summary = accumulator.summarize("30d", at + MAX_USAGE_MODEL_BREAKDOWN_ROWS);
    expect(summary.models).toHaveLength(MAX_USAGE_MODEL_BREAKDOWN_ROWS - 1);
    expect(summary.models.some(model => model.model === "other")).toBe(false);
    expect(summary.days.find(day => day.requests > 0)?.models.some(model => model.model === "other")).toBe(false);

    const base = summarizeUsage(rows, "30d", at + MAX_USAGE_MODEL_BREAKDOWN_ROWS);
    expect(summary).toEqual(projectUsageSummary(base, { provider: "rare-provider" }, rows));
  });

  test("clone mutations do not affect the source", () => {
    const source = createUsageSummaryAccumulator({ mode: "row-unique" });
    source.add(entry({ ts: at, requestId: "clone-source" }));
    const before = source.summarize("30d", at);
    const cloned = source.clone();
    cloned.add(entry({ ts: at + 1, requestId: "clone-only" }));

    expect(source.summarize("30d", at)).toEqual(before);
    expect(cloned.summarize("30d", at).summary.requests).toBe(2);
    expect(cloned.estimatedBytes).toBeGreaterThanOrEqual(source.estimatedBytes);
  });

  test("estimatedBytes stays constant for ordinary compact rows in existing dimensions", () => {
    const compact = createUsageSummaryAccumulator({ mode: "row-unique" });
    const exact = createUsageSummaryAccumulator();
    const first = entry({
      ts: at,
      requestId: "estimate-1",
      accountLogLabel: "pabcdef",
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const second = entry({ ...first, ts: at + 1, requestId: "estimate-2" });
    compact.add(first);
    exact.add(first);
    const compactAfterFirst = compact.estimatedBytes;
    compact.add(second);
    exact.add(second);

    expect(compact.estimatedBytes).toBe(compactAfterFirst);
    expect(exact.estimatedBytes).toBeGreaterThan(compact.estimatedBytes);
  });

  test("estimatedBytes aggregates repeated multi-model overlap signatures", () => {
    const compact = createUsageSummaryAccumulator({ mode: "row-unique" });
    const combo = (index: number): PersistedUsageEntry => entry({
      ts: at + index,
      requestId: `repeated-overlap-${index}`,
      provider: "combo",
      model: "combo/native",
      usageStatus: "reported",
      attempts: [
        {
          ordinal: 1,
          provider: "unpriced-a",
          model: "model-a",
          adapter: "openai-responses",
          status: 200,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
        },
        {
          ordinal: 2,
          provider: "unpriced-b",
          model: "model-b",
          adapter: "openai-responses",
          status: 200,
          durationMs: 10,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
        },
      ],
    });
    compact.add(combo(0));
    const firstSignatureBytes = compact.estimatedBytes;
    for (let index = 1; index <= 100; index++) compact.add(combo(index));

    expect(compact.estimatedBytes).toBe(firstSignatureBytes);
  });
});
