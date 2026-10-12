import { describe, expect, test } from "bun:test";
import type { AttemptTierOutcome } from "../../src/types";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { computeEntryCost } from "../../src/usage/summary";
import { estimateRequestCost, resolveMatchedPrice } from "../../src/usage/cost";

const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 10_000 };
const USER_ROWS = [{
  provider: "cursor",
  modelId: "claude-opus-5-5",
  cost4: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  source: "config:providers.cursor.modelCosts[claude-opus-5-5]",
  verifiedAt: "user-configured",
  status: "verified",
}] as const;

const cursorFastOutcome: AttemptTierOutcome = {
  canonical: "priority",
  wireKind: "cursor-variant",
  wireValue: "fast",
  fastOutcome: "applied",
  confirmation: "assumed",
};

function entry(model: string, tierOutcome?: AttemptTierOutcome): PersistedUsageEntry {
  return {
    requestId: `cursor-fast-${model}`,
    timestamp: 1,
    provider: "cursor",
    model,
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage,
    ...(tierOutcome ? { tierOutcome } : {}),
  };
}

describe("Cursor Fast pricing", () => {
  test("explicit Fast model ids use Cursor's published Fast tuples", () => {
    expect(resolveMatchedPrice("cursor", "claude-opus-4-8-high-fast")).toMatchObject({
      cost4: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      sourceRef: "https://cursor.com/docs/models/claude-opus-4-8",
      status: "verified",
    });
    expect(resolveMatchedPrice("cursor", "claude-opus-5-high-fast")?.cost4)
      .toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
    expect(resolveMatchedPrice("cursor", "claude-opus-5-5-high-fast")?.cost4)
      .toEqual({ input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 });
    expect(resolveMatchedPrice("cursor", "claude-opus-5-high-fast")).toMatchObject({
      sourceRef: "https://cursor.com/docs/models/claude-opus-5",
      status: "verified",
    });
    expect(resolveMatchedPrice("cursor", "claude-opus-5-minimal-fast")).toBeNull();
    expect(resolveMatchedPrice("cursor", "claude-opus-4-8-minimal-fast")).toBeNull();
    expect(resolveMatchedPrice("cursor", "claude-opus-4-8-none-fast")).toBeNull();
    expect(resolveMatchedPrice("cursor", "claude-opus-5-thinking-minimal-fast")).toBeNull();
    expect(resolveMatchedPrice("cursor", "claude-opus-5-thinking-none-fast")).toBeNull();
    expect(resolveMatchedPrice("cursor", "claude-opus-5-5-minimal-fast")).toBeNull();
    expect(resolveMatchedPrice("cursor", "claude-opus-5-5-none-fast")).toBeNull();
    expect(resolveMatchedPrice("cursor", "claude-opus-5-5-thinking-high-fast")).toBeNull();
  });

  test("standard Cursor rows remain at their base rates", () => {
    expect(resolveMatchedPrice("cursor", "claude-opus-5-5")?.cost4)
      .toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(resolveMatchedPrice("cursor", "claude-opus-5")?.cost4)
      .toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  test("persisted Cursor Fast tier outcome doubles the request estimate", () => {
    const standard = computeEntryCost(entry("claude-opus-5-5"));
    const fast = computeEntryCost(entry("claude-opus-5-5", cursorFastOutcome));
    expect(standard.estimate?.cost.total).toBeCloseTo(0.534, 10);
    expect(fast.estimate?.cost.total).toBeCloseTo(1.068, 10);
    expect(fast.estimate?.priorityMultiplier).toBe(2);
  });

  test("configured Cursor model prices remain authoritative for explicit Fast ids", () => {
    const price = resolveMatchedPrice("cursor", "claude-opus-5-5-high-fast", undefined, USER_ROWS);
    expect(price).toMatchObject({ source: "user", cost4: USER_ROWS[0].cost4 });
    const estimate = estimateRequestCost({
      provider: "cursor",
      model: "claude-opus-5-5-high-fast",
      usage,
      usageStatus: "reported",
    }, undefined, USER_ROWS);
    expect(estimate?.cost.total).toBeCloseTo(0.094, 10);
    expect(estimate?.price?.source).toBe("user");
  });
});
