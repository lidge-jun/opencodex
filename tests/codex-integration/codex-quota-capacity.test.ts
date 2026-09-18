import { describe, expect, test } from "bun:test";
import { estimateCodexQuotaCapacity } from "../../src/codex/quota-capacity";
import type { QuotaHistorySample } from "../../src/codex/quota-history";
import type { PersistedUsageEntry, PersistedUsageAttempt } from "../../src/usage/log";

const label = "pabcdef";
const shared = (model: string) => model !== "independent";
const point = (at: number, percent: number): Omit<QuotaHistorySample, "credentialGeneration"> => ({
  observedAt: at, source: "wham", windows: [{ family: "account", window: "weekly", usedPercent: percent, resetAtMs: 10_000 }],
});
const attempt = (overrides: Partial<PersistedUsageAttempt> = {}): PersistedUsageAttempt => ({
  ordinal: 1, provider: "openai", model: "gpt-test", adapter: "openai-responses", status: 200, durationMs: 10,
  sendCount: 1, recoveryKinds: [], usageStatus: "reported", accountLogLabel: label,
  usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 }, ...overrides,
});
const entry = (overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry => ({
  requestId: "r1", timestamp: 1100, durationMs: 100, provider: "openai", model: "gpt-test", status: 200, usageStatus: "reported",
  attempts: [attempt()], ...overrides,
});
const points = [point(1000, 10), point(2000, 20)];

describe("observed effective quota capacity", () => {
  test("hand-calculated 1000 reported tokens over ten percentage points estimates 10000", () => {
    const result = estimateCodexQuotaCapacity(points, [entry()], label, shared);
    expect(result.status).toBe("estimated");
    expect(result.estimates).toEqual([{ window: "weekly", estimatedTokens: 10000, sampleCount: 1, confidence: "low" }]);
    expect(result.assumptions.length).toBeGreaterThan(0);
  });

  test("duplicate rows and ordinals count once while conflicts refuse estimation", () => {
    expect(estimateCodexQuotaCapacity(points, [entry(), entry()], label, shared).estimates[0].estimatedTokens).toBe(10000);
    expect(estimateCodexQuotaCapacity(points, [entry({ attempts: [attempt(), attempt()] })], label, shared).estimates[0].estimatedTokens).toBe(10000);
    expect(estimateCodexQuotaCapacity(points, [entry(), entry({ durationMs: 101 })], label, shared).status).toBe("insufficient-evidence");
    expect(estimateCodexQuotaCapacity(points, [entry({ attempts: [attempt(), attempt({ sendCount: 2 })] })], label, shared).status).toBe("insufficient-evidence");
  });

  test.each([
    entry({ timestamp: 1000 }), entry({ timestamp: 1999, durationMs: 2 }), entry({ attempts: [] }), entry({ attempts: undefined }),
    entry({ attempts: [attempt({ sendCount: 2 })] }), entry({ attempts: [attempt({ locallyAnswered: true })] }),
    entry({ attempts: [attempt({ usage: { inputTokens: 1, outputTokens: 1, estimated: true } })] }),
    entry({ attempts: [attempt({ usageStatus: "unreported" })] }), entry({ attempts: [attempt({ accountLogLabel: "p123456" })] }),
    entry({ attempts: [attempt({ model: "independent" })] }),
  ])("unknown or outside-interval usage supplies no sample", row => {
    expect(estimateCodexQuotaCapacity(points, [row], label, shared).status).toBe("insufficient-evidence");
  });

  test("window/provenance/reset changes, refunds and tiny deltas are not capacity intervals", () => {
    for (const right of [point(2000, 9), point(2000, 10), point(2000, 10.1), { ...point(2000, 20), source: "response-header" as const },
      { ...point(2000, 20), windows: [{ ...point(2000, 20).windows[0], resetAtMs: undefined }] },
      { ...point(2000, 20), windows: [{ ...point(2000, 20).windows[0], resetAtMs: 20_000 }] },
      { ...point(2000, 20), windows: [{ ...point(2000, 20).windows[0], family: "spark" as const }] },
    ]) expect(estimateCodexQuotaCapacity([points[0], right], [entry()], label, shared).status).toBe("insufficient-evidence");
  });

  test("overflow and bounded scan cannot produce a finite-looking false result", () => {
    const oversized = entry({ attempts: [attempt({ usage: { inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE } })] });
    expect(estimateCodexQuotaCapacity(points, [oversized], label, shared).status).toBe("insufficient-evidence");
    expect(estimateCodexQuotaCapacity(points, Array.from({ length: 10001 }, () => entry()), label, shared).reason).toBe("ledger_truncated");
  });
});


test("a positive fractional inference never publishes zero capacity after rounding", () => {
  const small = entry({ attempts: [attempt({ usage: { inputTokens: 0.1, outputTokens: 0 } })] });
  expect(estimateCodexQuotaCapacity([point(1000, 0), point(2000, 90)], [small], label, shared).status).toBe("insufficient-evidence");
});
