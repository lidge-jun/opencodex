import { expect, test } from "bun:test";
import { computeEntryCost } from "../../src/usage/summary";
import type { PersistedUsageEntry } from "../../src/usage/log";

type Attempt = NonNullable<PersistedUsageEntry["attempts"]>[number];
const measured: Attempt = {
  ordinal: 1, provider: "openai", model: "gpt-5.5", adapter: "openai-responses",
  status: 200, durationMs: 10, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
  usage: { inputTokens: 100, outputTokens: 10 },
};
function row(attempts: Attempt[]): PersistedUsageEntry {
  return { requestId: "partial-cost", timestamp: 1, provider: "openai", model: "gpt-5.5",
    status: 200, durationMs: 10, usageStatus: "unreported", attempts };
}

for (const usageStatus of ["unreported", "unsupported"] as const) {
  test(`an ${usageStatus} attempt with partial tokens cannot complete a priced request`, () => {
    const partial: Attempt = { ...measured, ordinal: 2, usageStatus };
    for (const attempts of [[measured, partial], [partial, measured]]) {
      const result = computeEntryCost(row(attempts));
      expect(result.costTotal).toBeGreaterThan(0);
      expect(result.isPriced).toBe(false);
      expect(result.attemptEstimates.filter(Boolean)).toHaveLength(1);
    }
  });
}

test("an upstream refusal without usage remains a known zero alongside measured usage", () => {
  const { usage: _usage, ...withoutUsage } = measured;
  const result = computeEntryCost(row([measured, { ...withoutUsage, ordinal: 2, status: 429, usageStatus: "unreported" }]));
  expect(result.isPriced).toBe(true);
  expect(result.costTotal).toBeGreaterThan(0);
});
