import { expect, test } from "bun:test";
import { capacityAggregationFromReport } from "../src/provider-workspace/report";

function selectorBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

test("legacy provider quota reports remain valid without aggregation metadata", () => {
  expect(capacityAggregationFromReport({ quota: { weeklyPercent: 42 } })).toBeNull();
});

test("capacity metadata preserves estimate, raw current quota, recovery percent, and incomplete coverage", () => {
  const aggregation = capacityAggregationFromReport({
    quota: { weeklyPercent: 30.769230769, updatedAt: 123 },
    aggregation: {
      kind: "capacity-weighted-v1",
      scope: "routable-known",
      presentation: "aggregate",
      incomplete: true,
      excludedAccounts: 2,
      unknownPlanAccounts: 1,
      partialWindowAccounts: 0,
      weekly: {
        usedPercent: 30.769230769,
        nextRecoveryAt: 1_800_000_010_000,
        nextRecoveryPercent: 19.23076923,
      },
      currentAccount: {
        plan: "pro",
        quota: { weeklyPercent: 10, weeklyResetAt: 1_800_000_030, updatedAt: 123 },
      },
    },
  });
  expect(aggregation).toMatchObject({
    presentation: "aggregate",
    incomplete: true,
    excludedAccounts: 2,
    unknownPlanAccounts: 1,
    partialWindowAccounts: 0,
    weekly: { usedPercent: 30.769230769, nextRecoveryPercent: 19.23076923 },
    currentAccount: { plan: "pro", quota: { weeklyPercent: 10 } },
  });
  expect(aggregation?.weekly).not.toHaveProperty("projectedUsedPercentAfterReset");
});

test("window coverage metadata keeps monthly, weekly, and complete states independent", () => {
  const adapt = (weeklyIncomplete: boolean, monthlyIncomplete: boolean) => capacityAggregationFromReport({
    quota: { weeklyPercent: 20, monthlyPercent: 40, updatedAt: 123 },
    aggregation: {
      kind: "capacity-weighted-v1",
      scope: "routable-known",
      presentation: "aggregate",
      incomplete: weeklyIncomplete || monthlyIncomplete,
      excludedAccounts: 0,
      unknownPlanAccounts: 0,
      partialWindowAccounts: weeklyIncomplete || monthlyIncomplete ? 1 : 0,
      weekly: { usedPercent: 20, incomplete: weeklyIncomplete, excludedAccounts: weeklyIncomplete ? 1 : 0 },
      monthly: { usedPercent: 40, incomplete: monthlyIncomplete, excludedAccounts: monthlyIncomplete ? 1 : 0 },
    },
  });

  expect(adapt(false, true)).toMatchObject({
    weekly: { incomplete: false, excludedAccounts: 0 },
    monthly: { incomplete: true, excludedAccounts: 1 },
  });
  expect(adapt(true, false)).toMatchObject({
    weekly: { incomplete: true, excludedAccounts: 1 },
    monthly: { incomplete: false, excludedAccounts: 0 },
  });
  expect(adapt(false, false)).toMatchObject({
    weekly: { incomplete: false, excludedAccounts: 0 },
    monthly: { incomplete: false, excludedAccounts: 0 },
  });
});

test("fallback and coverage-only metadata never become aggregate presentation", () => {
  const fallback = capacityAggregationFromReport({
    quota: { weeklyPercent: 80, updatedAt: 123 },
    aggregation: {
      kind: "capacity-weighted-v1",
      scope: "routable-known",
      presentation: "effective-account-fallback",
      incomplete: true,
      excludedAccounts: 2,
      unknownPlanAccounts: 0,
    },
  });
  expect(fallback?.presentation).toBe("effective-account-fallback");
  const legacyCoverage = capacityAggregationFromReport({
    aggregation: {
      kind: "capacity-weighted-v1",
      scope: "routable-known",
      incomplete: true,
      excludedAccounts: 2,
      unknownPlanAccounts: 1,
    },
  });
  expect(legacyCoverage?.presentation).toBe("coverage-only");
});

test("capacity recovery layout wraps and stacks in narrow provider panes", async () => {
  const css = await Bun.file(new URL("../src/styles/provider-overview-dashboard.css", import.meta.url)).text();
  const quotaCss = await Bun.file(new URL("../src/styles/provider-quota.css", import.meta.url)).text();
  const recovery = selectorBlock(css, ".pws-capacity-recovery");
  const recoveryText = selectorBlock(css, ".pws-capacity-recovery span");
  expect(recovery).toContain("flex-wrap: wrap;");
  expect(recoveryText).toContain("overflow-wrap: anywhere;");
  expect(css).toContain("@container (max-width: 520px)");
  expect(css.slice(css.indexOf("@container (max-width: 520px)"))).toContain("grid-template-columns: minmax(0, 1fr);");
  const limitGroup = selectorBlock(quotaCss, ".quota-stacked-limit-group");
  expect(limitGroup).toContain("flex-wrap: wrap;");
  expect(limitGroup).toContain("overflow-wrap: anywhere;");
});

test("malformed or future aggregation contracts fail closed", () => {
  expect(capacityAggregationFromReport({ aggregation: { kind: "capacity-weighted-v2" } })).toBeNull();
  expect(capacityAggregationFromReport({ aggregation: { kind: "capacity-weighted-v1", scope: "routable-known" } })).toBeNull();
});
