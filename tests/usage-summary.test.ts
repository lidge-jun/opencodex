import { describe, expect, test } from "bun:test";
import { parseRange, parseUsageSurface, summarizeUsage } from "../src/usage/summary";
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
    ...(rest.resolvedModel !== undefined ? { resolvedModel: rest.resolvedModel } : {}),
    ...(rest.usage ? { usage: rest.usage } : {}),
    ...(rest.totalTokens !== undefined ? { totalTokens: rest.totalTokens } : {}),
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
    expect(sum.days.find(day => day.requests === 4)?.models).toEqual([
      { provider: "openai", model: "gpt-5.5", requests: 4, totalTokens: 14 },
    ]);
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
});
