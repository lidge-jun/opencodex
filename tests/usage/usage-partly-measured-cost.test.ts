import { expect, test } from "bun:test";
import { computeEntryCost, summarizeUsage } from "../../src/usage/summary";
import { aggregateAttemptUsage } from "../../src/server/request-log";
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

test("a refused retry and a measured send total the measured cost on the summary", () => {
  const { usage: _usage, ...withoutUsage } = measured;
  const attempts: Attempt[] = [{ ...withoutUsage, status: 429, usageStatus: "unreported" }, { ...measured, ordinal: 2 }];
  // The row request-log writes for a non-combo retry: status and usage aggregate its attempts.
  const aggregate = aggregateAttemptUsage(attempts);
  const entry = { ...row(attempts), timestamp: Date.UTC(2026, 5, 28), usageStatus: aggregate.status, usage: aggregate.usage };
  const { costTotal } = computeEntryCost(entry);
  expect(summarizeUsage([entry], "30d", Date.UTC(2026, 5, 28, 12)).summary).toMatchObject({
    requests: 1, pricedRequests: 1, unpricedRequests: 0, unmeteredRequests: 0, estimatedCostUsd: costTotal,
  });
});

test("a send the client cancelled before output is an unknown cost, not a known zero", () => {
  const { usage: _usage, ...withoutUsage } = measured;
  const attempts: Attempt[] = [measured, { ...withoutUsage, ordinal: 2, status: 499, usageStatus: "unreported" }];
  const aggregate = aggregateAttemptUsage(attempts);
  const entry = { ...row(attempts), timestamp: Date.UTC(2026, 5, 28), usageStatus: aggregate.status, usage: aggregate.usage };
  expect(computeEntryCost(entry).isPriced).toBe(false);
  const { summary, models } = summarizeUsage([entry], "30d", Date.UTC(2026, 5, 28, 12));
  expect(summary).toMatchObject({ requests: 1, pricedRequests: 0, unpricedRequests: 1, unmeteredRequests: 0 });
  expect(models).toEqual([expect.objectContaining({ model: "gpt-5.5", pricedRequests: 0, unpricedRequests: 1 })]);
});

test("a refusal cannot hide a measured attempt with no matching price", () => {
  const { usage: _usage, ...withoutUsage } = measured;
  const attempts: Attempt[] = [
    { ...withoutUsage, status: 429, usageStatus: "unreported" },
    { ...measured, ordinal: 2, provider: "unknown-provider", model: "unknown-model" },
    { ...measured, ordinal: 3 },
  ];
  const aggregate = aggregateAttemptUsage(attempts);
  expect(aggregate.status).toBe("unreported");
  const entry = { ...row(attempts), timestamp: Date.UTC(2026, 5, 28), usageStatus: aggregate.status, usage: aggregate.usage };
  const cost = computeEntryCost(entry);
  expect(cost.attemptEstimates?.map(Boolean)).toEqual([false, false, true]);
  expect(cost.costTotal).toBeGreaterThan(0);
  const { summary } = summarizeUsage([entry], "30d", Date.UTC(2026, 5, 28, 12));
  expect(summary).toMatchObject({
    requests: 1, pricedRequests: 0, unpricedRequests: 1, unmeteredRequests: 0, estimatedCostUsd: 0,
  });
  expect(cost.isPriced).toBe(false);
});

test("a row of known-zero refusals stays unmetered", () => {
  const { usage: _usage, ...withoutUsage } = measured;
  const attempts: Attempt[] = [{ ...withoutUsage, status: 429, usageStatus: "unreported" }];
  const entry = { ...row(attempts), timestamp: Date.UTC(2026, 5, 28) };
  expect(summarizeUsage([entry], "30d", Date.UTC(2026, 5, 28, 12)).summary)
    .toMatchObject({ requests: 1, pricedRequests: 0, unpricedRequests: 0, unmeteredRequests: 1 });
});
