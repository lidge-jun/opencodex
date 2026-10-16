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
  const entryFor = (legs: Attempt[]): PersistedUsageEntry => {
    const aggregate = aggregateAttemptUsage(legs);
    return { ...row(legs), timestamp: Date.UTC(2026, 5, 28), usageStatus: aggregate.status, usage: aggregate.usage };
  };
  const withRefusal = entryFor(attempts);
  const withoutRefusal = entryFor(attempts.slice(1));
  expect(withRefusal.usageStatus).toBe("unreported");
  expect(withoutRefusal.usageStatus).toBe("reported");
  const cost = computeEntryCost(withRefusal);
  const baselineCost = computeEntryCost(withoutRefusal);
  expect(baselineCost.isPriced).toBe(true);
  expect(baselineCost.costTotal).toBeGreaterThan(0);
  expect(cost.attemptEstimates?.map(Boolean)).toEqual([false, false, true]);
  expect({ ...cost, attemptEstimates: cost.attemptEstimates?.slice(1) }).toEqual(baselineCost);
  const summarize = (entry: PersistedUsageEntry) => summarizeUsage([entry], "30d", Date.UTC(2026, 5, 28, 12));
  const actual = summarize(withRefusal);
  const baseline = summarize(withoutRefusal);
  const classification = ({ pricedRequests, unpricedRequests, unmeteredRequests, estimatedCostUsd }: typeof actual.summary) =>
    ({ pricedRequests, unpricedRequests, unmeteredRequests, estimatedCostUsd });
  expect(classification(baseline.summary)).toEqual({
    pricedRequests: 1, unpricedRequests: 0, unmeteredRequests: 0, estimatedCostUsd: baselineCost.costTotal,
  });
  expect(classification(actual.summary)).toEqual(classification(baseline.summary));
  // Compare model usage and pricing; the refusal adds an unreported physical attempt.
  const models = (result: typeof actual) => result.models.map(({ provider, model, requests, inputTokens,
    outputTokens, totalTokens, pricedRequests, unpricedRequests, priceCoverageRatio, estimatedCostUsd }) =>
    ({ provider, model, requests, inputTokens, outputTokens, totalTokens,
      pricedRequests, unpricedRequests, priceCoverageRatio, estimatedCostUsd }))
    .sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
  expect(models(actual)).toEqual(models(baseline));
});

test("a row of known-zero refusals stays unmetered", () => {
  const { usage: _usage, ...withoutUsage } = measured;
  const attempts: Attempt[] = [{ ...withoutUsage, status: 429, usageStatus: "unreported" }];
  const entry = { ...row(attempts), timestamp: Date.UTC(2026, 5, 28) };
  expect(summarizeUsage([entry], "30d", Date.UTC(2026, 5, 28, 12)).summary)
    .toMatchObject({ requests: 1, pricedRequests: 0, unpricedRequests: 0, unmeteredRequests: 1 });
});
