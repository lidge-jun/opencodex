import { afterEach, describe, expect, test } from "bun:test";
import {
  clearAntigravityAccountCooldown,
  isAntigravityAccountInCooldown,
  nextAntigravityAccount,
  recordAntigravityCooldown,
  sweepExpiredAntigravityRoutingHealth,
} from "../src/oauth/antigravity-routing";

const NOW = 1_700_000_000_000;
const ACCOUNT_IDS = ["account-a", "account-b", "account-c"];

afterEach(() => {
  for (const accountId of ACCOUNT_IDS) clearAntigravityAccountCooldown(accountId);
});

describe("Antigravity account cooldowns", () => {
  test("records a rate-limit cooldown and sweeps it after expiry", () => {
    recordAntigravityCooldown("account-a", "rate_limited", undefined, NOW);

    expect(isAntigravityAccountInCooldown("account-a", NOW)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 4_999)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 5_000)).toBe(false);
    recordAntigravityCooldown("account-b", "rate_limited", undefined, NOW);
    expect(sweepExpiredAntigravityRoutingHealth(NOW + 5_000)).toBe(1);
    expect(sweepExpiredAntigravityRoutingHealth(NOW + 5_000)).toBe(0);
  });

  test("caps rate-limit Retry-After and uses a parsed quota reset", () => {
    recordAntigravityCooldown("account-a", "rate_limited", 120_000, NOW);
    recordAntigravityCooldown("account-b", "quota_exhausted", 30_000, NOW);

    expect(isAntigravityAccountInCooldown("account-a", NOW + 60_000)).toBe(false);
    expect(isAntigravityAccountInCooldown("account-b", NOW + 29_999)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-b", NOW + 30_000)).toBe(false);
  });

  test("honors a quota reset longer than 24 hours", () => {
    const resetDurationMs = 48 * 60 * 60_000;
    recordAntigravityCooldown("account-a", "quota_exhausted", resetDurationMs, NOW);

    expect(isAntigravityAccountInCooldown("account-a", NOW + 24 * 60 * 60_000 + 1)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + resetDurationMs)).toBe(false);
  });

  test("caps quota-exhausted Retry-After at 7 days", () => {
    const tenYearsMs = 10 * 365 * 24 * 60 * 60_000;
    const sevenDaysMs = 7 * 24 * 60 * 60_000;
    recordAntigravityCooldown("account-a", "quota_exhausted", tenYearsMs, NOW);

    expect(isAntigravityAccountInCooldown("account-a", NOW + sevenDaysMs - 1)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + sevenDaysMs)).toBe(false);
  });

  test("skips cooled accounts when selecting the next account", () => {
    recordAntigravityCooldown("account-b", "rate_limited", undefined, NOW);

    expect(nextAntigravityAccount(ACCOUNT_IDS, "account-a", NOW)).toBe("account-c");
    expect(nextAntigravityAccount(ACCOUNT_IDS, "account-c", NOW)).toBe("account-a");
    expect(nextAntigravityAccount(ACCOUNT_IDS, undefined, NOW)).toBe("account-a");
  });

  test("keeps a geo block out of the short retry-limit path", () => {
    recordAntigravityCooldown("account-a", "geo_blocked", undefined, NOW);

    expect(nextAntigravityAccount(["account-a"], "account-a", NOW + 60_000)).toBeUndefined();
    expect(isAntigravityAccountInCooldown("account-a", NOW + 60_000)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 24 * 60 * 60_000)).toBe(false);
  });

  test("retains the longest expiry from concurrent cooldown records", () => {
    recordAntigravityCooldown("account-a", "rate_limited", 60_000, NOW);
    recordAntigravityCooldown("account-a", "rate_limited", undefined, NOW + 1);

    expect(isAntigravityAccountInCooldown("account-a", NOW + 5_001)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 59_999)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 60_001)).toBe(false);
  });
});
