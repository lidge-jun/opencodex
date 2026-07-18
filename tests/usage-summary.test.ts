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
    ...(rest.attempts ? { attempts: rest.attempts } : {}),
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
      { provider: "openai", model: "gpt-5.5", requests: 4, attemptCount: 4, totalTokens: 14 },
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
    expect(sum.days.find(day => day.requests === 1)?.models).toEqual([
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
});
