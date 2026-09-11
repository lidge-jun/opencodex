/**
 * #4211: a lapsed subscription downgrades a pooled ChatGPT account to Free. The first round
 * taught selection to skip it (codexPool.excludedPlans); this covers the half the issue asked
 * for after that -- the operator being able to see, on the surface they already read, that the
 * account is out of rotation and why.
 *
 * The predicate mirrors src/codex/routing.ts, so these cases are also the contract between the
 * two copies: if routing's rule changes, one of these should go red.
 */
import { describe, expect, test } from "bun:test";
import { formatAccountTable, planExcludedFromRotation, type AccountRow } from "../../src/cli/account";
import type { OcxConfig } from "../../src/types";

function config(excludedPlans?: string[]): OcxConfig {
  return { providers: {}, ...(excludedPlans ? { codexPool: { excludedPlans } } : {}) } as OcxConfig;
}

function codexRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    provider: "openai",
    type: "codex",
    id: "chatgpt_1",
    label: "work",
    plan: "free",
    active: false,
    ...overrides,
  };
}

describe("#4211 plan policy on the account surface", () => {
  test("an account whose plan the operator excluded is held out", () => {
    expect(planExcludedFromRotation(config(["free"]), codexRow())).toBe(true);
  });

  test("no policy leaves every account exactly as it was", () => {
    expect(planExcludedFromRotation(config(), codexRow())).toBe(false);
    expect(planExcludedFromRotation(config([]), codexRow())).toBe(false);
  });

  test("the plan is matched by key, not by the string the provider happened to send", () => {
    // The stored plan is an unrestricted provider string whose casing and padding this
    // repository does not control, so a policy written as "free" must still catch " Free ".
    expect(planExcludedFromRotation(config([" Free "]), codexRow({ plan: "FREE" }))).toBe(true);
  });

  test("a plan nobody holds excludes nobody", () => {
    expect(planExcludedFromRotation(config(["team"]), codexRow())).toBe(false);
  });

  test("an account with no stored plan is never excluded", () => {
    // Absent evidence is not a downgrade. Excluding here would drain a pool on a field the
    // provider simply did not send.
    expect(planExcludedFromRotation(config(["free"]), codexRow({ plan: null }))).toBe(false);
    expect(planExcludedFromRotation(config(["free"]), codexRow({ plan: undefined }))).toBe(false);
  });

  test("the main app login is exempt, as it is in routing", () => {
    // getPoolAccountPlanForSelection withholds the main plan during a selection-only drain, so
    // a display rule that covered __main__ would disagree with routing exactly when it matters.
    expect(planExcludedFromRotation(config(["free"]), codexRow({ id: "__main__" }))).toBe(false);
  });

  test("only Codex pool rows carry the policy", () => {
    expect(planExcludedFromRotation(config(["free"]), codexRow({ type: "oauth" }))).toBe(false);
    expect(planExcludedFromRotation(config(["free"]), codexRow({ type: "api-key" }))).toBe(false);
  });
});

describe("#4211 listing an excluded account", () => {
  test("the status column names the exclusion and the plan that caused it", () => {
    const table = formatAccountTable([{ ...codexRow(), planExcluded: true }]);

    // The tier is inside the token on purpose: "not selected" without it leaves the operator
    // doing the same diagnosis the issue was filed to remove.
    expect(table).toContain("plan-excluded(free)");
  });

  test("an excluded account that is still selected shows both", () => {
    // Same reasoning as the paused-but-selected case (#2703): one word hiding the other is
    // exactly the state an operator most needs named.
    const table = formatAccountTable([{ ...codexRow(), active: true, planExcluded: true }]);

    expect(table).toContain("plan-excluded(free) selected");
  });

  test("a row without the verdict prints what it always printed", () => {
    const table = formatAccountTable([codexRow({ active: true })]);

    expect(table).toContain("selected");
    expect(table).not.toContain("plan-excluded");
  });
});
