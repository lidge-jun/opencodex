import { describe, expect, test } from "bun:test";
import { aggregateCodexPoolCapacity, CODEX_CAPACITY_MAX_QUOTA_AGE_MS, type CodexCapacityAccount } from "../src/providers/codex-capacity";

const NOW = 1_800_000_000_000;
const account = (
  plan: unknown,
  weeklyPercent: number | undefined,
  options: Partial<CodexCapacityAccount> & { weeklyResetAt?: number; monthlyPercent?: number; monthlyResetAt?: number } = {},
): CodexCapacityAccount => ({
  isMain: false,
  plan,
  paused: false,
  quota: weeklyPercent === undefined && options.monthlyPercent === undefined ? null : {
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(options.weeklyResetAt !== undefined ? { weeklyResetAt: options.weeklyResetAt } : {}),
    ...(options.monthlyPercent !== undefined ? { monthlyPercent: options.monthlyPercent } : {}),
    ...(options.monthlyResetAt !== undefined ? { monthlyResetAt: options.monthlyResetAt } : {}),
    updatedAt: NOW,
  },
  ...options,
});

describe("configured-weight Codex pool capacity", () => {
  test("Pro + Prolite + Plus produces the issue #874 estimate and recovery share", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 10, { isMain: true, active: true, weeklyResetAt: NOW + 30_000 }),
      account("prolite", 100, { weeklyResetAt: NOW + 10_000 }),
      account("plus", 100, { weeklyResetAt: NOW + 20_000 }),
    ], NOW);
    expect(result.quota?.weeklyPercent).toBeCloseTo(30.769230769, 8);
    expect(result.aggregation?.weekly).toMatchObject({ totalWeight: 26, consumedWeight: 8, remainingWeight: 18 });
    expect(result.aggregation?.weekly?.nextRecoveryAt).toBe(NOW + 10_000);
    expect(result.aggregation?.weekly?.nextRecoveryPercent).toBeCloseTo(19.23076923, 8);
    expect(result.aggregation?.currentAccount?.quota?.weeklyPercent).toBe(10);
  });

  test("observed 8/100/100 and refreshed 9/100/100 remain exact weighted regressions", () => {
    const rows = (mainPercent: number) => [
      account("pro", mainPercent, { isMain: true, active: true }),
      account("prolite", 100),
      account("prolite", 100),
    ];
    expect(aggregateCodexPoolCapacity(rows(8), NOW).quota?.weeklyPercent).toBeCloseTo(38.66666667, 8);
    expect(aggregateCodexPoolCapacity(rows(9), NOW).quota?.weeklyPercent).toBeCloseTo(39.33333333, 8);
  });

  test("legacy Team and Business plans share configured weight", () => {
    const result = aggregateCodexPoolCapacity([
      account("team", 20, { isMain: true, active: true }),
      account("business", 60),
    ], NOW);
    expect(result.quota?.weeklyPercent).toBe(40);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 2,
      excludedAccounts: 0,
      unknownPlanAccounts: 0,
      incomplete: false,
    });
  });

  test("an all-Team pool has complete configured-weight coverage", () => {
    const result = aggregateCodexPoolCapacity([
      account("team", 20, { isMain: true, active: true }),
      account("team", 60),
    ], NOW);
    expect(result.quota?.weeklyPercent).toBe(40);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 2,
      excludedAccounts: 0,
      unknownPlanAccounts: 0,
      incomplete: false,
    });
  });

  test("same-time resets group partial consumed capacity and expose only recovery percent", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 25, { weeklyResetAt: NOW + 10_000 }),
      account("prolite", 40, { weeklyResetAt: NOW + 10_000 }),
      account("plus", 100, { weeklyResetAt: NOW + 20_000 }),
    ], NOW);
    expect(result.aggregation?.weekly?.nextRecoveryPercent).toBeCloseTo(7 / 26 * 100, 8);
    expect(result.aggregation?.weekly).not.toHaveProperty("projectedUsedPercentAfterReset");
  });

  test("the next recovery skips earlier zero-consumption resets", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 0, { weeklyResetAt: NOW + 10_000 }),
      account("prolite", 40, { weeklyResetAt: NOW + 20_000 }),
    ], NOW);
    expect(result.aggregation?.weekly?.nextRecoveryAt).toBe(NOW + 20_000);
    expect(result.aggregation?.weekly?.nextRecoveryPercent).toBeCloseTo(2 / 25 * 100, 8);
  });

  test("unknown, missing, paused, and reauth rows are excluded with incomplete coverage", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 10, { active: true, isMain: true }),
      account("future-plan", 50),
      account("plus", undefined),
      account("prolite", 20, { paused: true }),
      account("business", 30, { needsReauth: true }),
    ], NOW);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 1,
      excludedAccounts: 4,
      unknownPlanAccounts: 1,
      missingQuotaAccounts: 1,
      pausedAccounts: 1,
      reauthAccounts: 1,
      incomplete: true,
    });
    expect(result.quota?.weeklyPercent).toBe(10);
  });

  test("weekly and monthly windows aggregate independently", () => {
    const result = aggregateCodexPoolCapacity([
      account("pro", 20),
      account("prolite", undefined, { monthlyPercent: 60 }),
      account("plus", 100, { monthlyPercent: 10 }),
    ], NOW);
    expect(result.aggregation?.weekly?.totalWeight).toBe(21);
    expect(result.aggregation?.monthly?.totalWeight).toBe(6);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 3,
      excludedAccounts: 0,
      partialWindowAccounts: 2,
      incomplete: true,
    });
    expect(result.aggregation?.weekly).toMatchObject({ includedAccounts: 2, excludedAccounts: 1, incomplete: true });
    expect(result.aggregation?.monthly).toMatchObject({ includedAccounts: 2, excludedAccounts: 1, incomplete: true });
    expect(result.quota?.weeklyPercent).toBeCloseTo(23.8095238, 7);
    expect(result.quota?.monthlyPercent).toBeCloseTo(51.6666667, 7);
  });

  test("expired resets are ignored and all-excluded pools retain effective-account fallback truth", () => {
    const expired = aggregateCodexPoolCapacity([
      account("pro", 10, { weeklyResetAt: NOW - 1, active: true, isMain: true }),
    ], NOW);
    expect(expired.aggregation?.weekly).not.toHaveProperty("nextRecoveryAt");
    const fallback = aggregateCodexPoolCapacity([
      account("future-plan", 70, { active: true, isMain: true }),
      account("go", 80),
    ], NOW);
    expect(fallback.aggregation).toMatchObject({
      includedAccounts: 0,
      excludedAccounts: 2,
      unknownPlanAccounts: 2,
      incomplete: true,
    });
    expect(fallback.currentAccount?.quota?.weeklyPercent).toBe(70);
  });

  test("mixed-age rows exclude stale capacity and use the oldest included reading", () => {
    const oldestIncluded = account("plus", 40);
    oldestIncluded.quota = { ...oldestIncluded.quota!, updatedAt: NOW - 20_000 };
    const newerIncluded = account("business", 20);
    newerIncluded.quota = { ...newerIncluded.quota!, updatedAt: NOW - 5_000 };
    const staleHighWeight = account("pro", 100);
    staleHighWeight.quota = {
      ...staleHighWeight.quota!,
      updatedAt: NOW - CODEX_CAPACITY_MAX_QUOTA_AGE_MS - 1,
    };

    const result = aggregateCodexPoolCapacity([oldestIncluded, newerIncluded, staleHighWeight], NOW);
    expect(result.quota?.weeklyPercent).toBeCloseTo(30, 8);
    expect(result.quota?.updatedAt).toBe(NOW - 20_000);
    expect(result.aggregation?.weekly?.updatedAt).toBe(NOW - 20_000);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 2,
      excludedAccounts: 1,
      staleQuotaAccounts: 1,
      incomplete: true,
    });
  });

  test("a stale effective secondary quota is hidden while a fresh main account still aggregates", () => {
    const main = account("plus", 20, { isMain: true });
    const staleActive = account("pro", 90, { active: true });
    staleActive.quota = {
      ...staleActive.quota!,
      updatedAt: NOW - CODEX_CAPACITY_MAX_QUOTA_AGE_MS - 1,
    };

    const result = aggregateCodexPoolCapacity([main, staleActive], NOW);
    expect(result.quota?.weeklyPercent).toBe(20);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 1,
      excludedAccounts: 1,
      staleQuotaAccounts: 1,
      currentAccount: { plan: "pro", quota: null },
    });
  });

  test("prototype and unknown plan names never become configured weights", () => {
    const result = aggregateCodexPoolCapacity([
      account("plus", 20),
      account("constructor", 100),
      account("toString", 100),
      account("valueOf", 100),
      account("unknown", 100),
    ], NOW);
    expect(result.quota?.weeklyPercent).toBe(20);
    expect(result.aggregation).toMatchObject({
      includedAccounts: 1,
      excludedAccounts: 4,
      unknownPlanAccounts: 4,
    });
    expect(Number.isFinite(result.quota?.weeklyPercent)).toBe(true);
  });

  test("non-string plans are excluded and never exposed in current-account metadata", () => {
    const result = aggregateCodexPoolCapacity([
      account({ tier: "pro" }, 20, { active: true, isMain: true }),
    ], NOW);
    expect(result.quota).toBeNull();
    expect(result.aggregation).toMatchObject({ unknownPlanAccounts: 1, includedAccounts: 0 });
    expect(result.aggregation?.currentAccount).not.toHaveProperty("plan");
    expect(result.aggregation?.currentAccount?.quota?.weeklyPercent).toBe(20);
  });

  test("all-stale rows expose incomplete coverage without an aggregate window", () => {
    const rows = [account("pro", 80, { active: true, isMain: true }), account("prolite", 20)];
    for (const row of rows) {
      row.quota = { ...row.quota!, updatedAt: NOW - CODEX_CAPACITY_MAX_QUOTA_AGE_MS - 1 };
    }
    const result = aggregateCodexPoolCapacity(rows, NOW);
    expect(result.quota).toBeNull();
    expect(result.aggregation).toMatchObject({
      includedAccounts: 0,
      excludedAccounts: 2,
      staleQuotaAccounts: 2,
      incomplete: true,
    });
    expect(result.aggregation?.weekly).toBeUndefined();
  });

  test("all exclusion reasons retain a coverage envelope without a quota window", () => {
    const stale = account("pro", 90);
    stale.quota = { ...stale.quota!, updatedAt: NOW - CODEX_CAPACITY_MAX_QUOTA_AGE_MS - 1 };
    const result = aggregateCodexPoolCapacity([
      account("future-plan", 10, { active: true, isMain: true }),
      account("plus", undefined),
      account("prolite", 20, { paused: true }),
      account("business", 30, { needsReauth: true }),
      stale,
    ], NOW);
    expect(result.quota).toBeNull();
    expect(result.aggregation).toMatchObject({
      includedAccounts: 0,
      excludedAccounts: 5,
      unknownPlanAccounts: 1,
      missingQuotaAccounts: 1,
      pausedAccounts: 1,
      reauthAccounts: 1,
      staleQuotaAccounts: 1,
      incomplete: true,
    });
  });
});
