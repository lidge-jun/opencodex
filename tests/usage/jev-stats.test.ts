import { describe, expect, test } from "bun:test";
import {
  createJevStatsAccumulator,
  MAX_JEV_STATS_MODEL_ROWS,
  normalizePersistedJevDecision,
} from "../../src/usage/jev-stats";
import type { PersistedUsageEntry } from "../../src/usage/log";

const NOW = Date.UTC(2026, 8, 22, 12);

function entry(
  requestId: string,
  timestamp: number,
  decision: NonNullable<PersistedUsageEntry["jevDecision"]>,
  attempts: NonNullable<PersistedUsageEntry["attempts"]>,
  status = 200,
): PersistedUsageEntry {
  return {
    requestId,
    timestamp,
    provider: "combo",
    model: `combo/${decision.comboId}`,
    status,
    durationMs: 100,
    usageStatus: "reported",
    attempts,
    jevDecision: decision,
  };
}

function attempt(
  ordinal: number,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  options: { status?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number } = {},
): NonNullable<PersistedUsageEntry["attempts"]>[number] {
  const totalTokens = inputTokens + outputTokens;
  return {
    ordinal,
    provider,
    model,
    adapter: "test",
    status: options.status ?? 200,
    durationMs: 10,
    sendCount: 1,
    recoveryKinds: [],
    usageStatus: "reported",
    usage: {
      inputTokens,
      outputTokens,
      ...(options.reasoning !== undefined ? { reasoningOutputTokens: options.reasoning } : {}),
      ...(options.cacheRead !== undefined ? {
        cachedInputTokens: options.cacheRead,
        cacheReadInputTokens: options.cacheRead,
      } : {}),
      ...(options.cacheWrite !== undefined ? { cacheCreationInputTokens: options.cacheWrite } : {}),
    },
    totalTokens,
  };
}

describe("JEV decision telemetry", () => {
  test("normalizes a bounded, closed decision record", () => {
    expect(normalizePersistedJevDecision({
      version: 1,
      comboId: " jev-auto ",
      selected: { provider: " openai ", model: " gpt-6-astra ", effort: "high" },
      gate: "apply",
      latencyMs: 12.8,
      confidence: 0.75,
      chosenProbability: 0.6,
      usage: { inputTokens: 14, outputTokens: 3 },
    })).toEqual({
      version: 1,
      comboId: "jev-auto",
      selected: { provider: "openai", model: "gpt-6-astra", effort: "high" },
      gate: "apply",
      latencyMs: 13,
      confidence: 0.75,
      chosenProbability: 0.6,
      usage: { inputTokens: 14, outputTokens: 3, totalTokens: 17 },
    });

    expect(normalizePersistedJevDecision({
      version: 1,
      comboId: "jev-auto",
      selected: { provider: "openai", model: "gpt-6-astra", effort: "impossible" },
      gate: "invented",
      latencyMs: 1,
    })).toBeUndefined();
  });

  test("separates JEV picks from physical model attempts and token usage", () => {
    const applied = normalizePersistedJevDecision({
      version: 1,
      comboId: "jev-auto",
      selected: { provider: "openai", model: "gpt-6-astra", effort: "high" },
      gate: "apply",
      latencyMs: 20,
      confidence: 0.8,
      chosenProbability: 0.7,
      usage: { inputTokens: 12, outputTokens: 3 },
    })!;
    const failOpen = normalizePersistedJevDecision({
      version: 1,
      comboId: "jev-auto",
      selected: { provider: "openai", model: "gpt-6-astra", effort: "medium" },
      gate: "timeout",
      latencyMs: 4_000,
    })!;
    const otherCombo = normalizePersistedJevDecision({
      version: 1,
      comboId: "other",
      selected: { provider: "anthropic", model: "claude-sonnet-5", effort: null },
      gate: "apply",
      latencyMs: 10,
    })!;
    const accumulator = createJevStatsAccumulator({
      comboId: "jev-auto",
      since: NOW - 30 * 86_400_000,
      until: NOW,
    });
    accumulator.add(entry("applied", NOW - 1_000, applied, [
      attempt(1, "openai", "gpt-6-astra", 100, 20, { reasoning: 8, cacheRead: 30 }),
    ]));
    accumulator.add(entry("fail-open", NOW - 500, failOpen, [
      attempt(1, "openai", "gpt-6-astra", 50, 5, { status: 503 }),
      attempt(2, "openai", "gpt-5.6-sol", 80, 10, { cacheWrite: 4 }),
    ]));
    accumulator.add(entry("other", NOW - 250, otherCombo, [
      attempt(1, "anthropic", "claude-sonnet-5", 500, 50),
    ]));
    accumulator.add(entry("too-old", NOW - 40 * 86_400_000, applied, [
      attempt(1, "openai", "gpt-6-astra", 1_000, 100),
    ]));

    const stats = accumulator.summarize("30d", NOW);

    expect(stats).toMatchObject({
      range: "30d",
      comboId: "jev-auto",
      since: NOW - 30 * 86_400_000,
      generatedAt: NOW,
      summary: {
        decisions: 2,
        appliedDecisions: 1,
        failOpenDecisions: 1,
        successfulRequests: 2,
        requestsWithModelFallback: 1,
        modelAttempts: 3,
        measuredModelAttempts: 3,
        modelInputTokens: 230,
        modelOutputTokens: 35,
        modelReasoningTokens: 8,
        modelCacheReadTokens: 30,
        modelCacheWriteTokens: 4,
        modelTotalTokens: 265,
        decisionUsageReported: 1,
        decisionInputTokens: 12,
        decisionOutputTokens: 3,
        decisionTotalTokens: 15,
        averageLatencyMs: 2_010,
        averageConfidence: 0.8,
        averageChosenProbability: 0.7,
      },
    });
    expect(stats.gates).toEqual([
      { gate: "apply", decisions: 1 },
      { gate: "timeout", decisions: 1 },
    ]);
    expect(stats.models).toEqual([
      {
        provider: "openai",
        model: "gpt-6-astra",
        overflow: false,
        picks: 2,
        appliedPicks: 1,
        failOpenPicks: 1,
        attempts: 2,
        measuredAttempts: 2,
        inputTokens: 150,
        outputTokens: 25,
        reasoningTokens: 8,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
        totalTokens: 175,
        efforts: [
          { effort: "high", picks: 1 },
          { effort: "medium", picks: 1 },
        ],
      },
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        overflow: false,
        picks: 0,
        appliedPicks: 0,
        failOpenPicks: 0,
        attempts: 1,
        measuredAttempts: 1,
        inputTokens: 80,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 4,
        totalTokens: 90,
        efforts: [],
      },
    ]);
  });

  test("counts physical sends and ignores unsent fallback rows", () => {
    const decision = normalizePersistedJevDecision({
      version: 1,
      comboId: "jev-auto",
      selected: { provider: "openai", model: "gpt-6-astra", effort: "high" },
      gate: "apply",
      latencyMs: 5,
    })!;
    const retried = attempt(1, "openai", "gpt-6-astra", 20, 5);
    retried.sendCount = 3;
    const unsent = attempt(2, "openai", "gpt-5.6-sol", 0, 0, { status: 503 });
    unsent.sendCount = 0;
    unsent.usageStatus = "unreported";
    delete unsent.usage;
    delete unsent.totalTokens;
    const accumulator = createJevStatsAccumulator({ comboId: "jev-auto" });

    accumulator.add(entry("physical-sends", NOW, decision, [retried, unsent]));
    const summary = accumulator.summarize("all", NOW);

    expect(summary.summary).toMatchObject({
      modelAttempts: 3,
      measuredModelAttempts: 1,
      requestsWithModelFallback: 0,
      modelTotalTokens: 25,
    });
    expect(summary.models).toEqual([expect.objectContaining({
      provider: "openai",
      model: "gpt-6-astra",
      attempts: 3,
      measuredAttempts: 1,
    })]);
  });

  test("keeps a valid long selected model joined to its physical attempt", () => {
    const model = `model-${"x".repeat(240)}`;
    const decision = normalizePersistedJevDecision({
      version: 1,
      comboId: "jev-auto",
      selected: { provider: "provider", model, effort: "medium" },
      gate: "apply",
      latencyMs: 1,
    })!;
    const accumulator = createJevStatsAccumulator({ comboId: "jev-auto" });

    accumulator.add(entry("long-model", NOW, decision, [attempt(1, "provider", model, 1, 1)]));
    const summary = accumulator.summarize("all", NOW);

    expect(summary.summary.requestsWithModelFallback).toBe(0);
    expect(summary.models).toEqual([expect.objectContaining({
      provider: "provider",
      model,
      picks: 1,
      attempts: 1,
    })]);
  });

  test("bounds high-cardinality model rows and folds overflow without losing totals", () => {
    const accumulator = createJevStatsAccumulator({ comboId: "jev-auto" });
    const distinctModels = MAX_JEV_STATS_MODEL_ROWS + 44;
    for (let index = 0; index < distinctModels; index += 1) {
      const provider = index === 0 ? "other" : "provider";
      const model = index === 0 ? "other" : `model-${index}`;
      const decision = normalizePersistedJevDecision({
        version: 1,
        comboId: "jev-auto",
        selected: { provider, model, effort: "medium" },
        gate: "apply",
        latencyMs: 1,
      })!;
      accumulator.add(entry(String(index), NOW + index, decision, [
        attempt(1, provider, model, 1, 1),
      ]));
    }

    const summary = accumulator.clone().summarize("all", NOW + distinctModels);
    expect(summary.models).toHaveLength(MAX_JEV_STATS_MODEL_ROWS);
    expect(summary.summary).toMatchObject({
      decisions: distinctModels,
      modelAttempts: distinctModels,
      modelTotalTokens: distinctModels * 2,
    });
    expect(summary.models.find(row => !row.overflow && row.provider === "other" && row.model === "other"))
      .toMatchObject({ picks: 1, attempts: 1, totalTokens: 2 });
    expect(summary.models.find(row => row.overflow))
      .toMatchObject({ picks: 45, attempts: 45, totalTokens: 90 });
  });
});
