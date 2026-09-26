import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMainAccountHardLockStatus, isMainAccountHardLocked } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { clearAccountQuota, getAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed, type StoredAccountQuota } from "../../src/codex/quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const now = Date.UTC(2026, 8, 5);
const enabled = { codexMainAccountHardLock: true };
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-main-policy-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuota();
  clearMainAccountInfoCache();
  observeMainQuotaIdentity("policy-account-a");
});

afterEach(() => {
  clearAccountQuota();
  clearMainAccountInfoCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function observe(quota: Omit<StoredAccountQuota, "updatedAt">): void {
  const writer = captureMainQuotaWriter("policy-account-a");
  if (!writer) throw new Error("fixture identity was not observed");
  setAccountQuotaFromParsed("__main__", quota, undefined, writer);
}

describe("identity-bound main-account hard-lock policy", () => {
  test("an explicit opt-out preserves admission even at 100", () => {
    observe({ weeklyPercent: 100 });
    // The key is default-on since #5694: absent means enabled, only `false` opts out.
    expect(getMainAccountHardLockStatus({}, now)).toEqual({ enabled: true, state: "blocked" });
    expect(isMainAccountHardLocked({ codexMainAccountHardLock: false }, now)).toBe(false);
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: false }, now))
      .toEqual({ enabled: false, state: "off" });
  });

  test("unknown is not a fabricated empty or exhausted quota", () => {
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "unknown" });
    setAccountQuotaFromParsed("__main__", { weeklyPercent: 100 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("unknown");
  });

  test.each([97.99, 98, 100])("raw %s percent is compared without GUI rounding", percent => {
    observe({ weeklyPercent: percent });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe(percent < 98 ? "ready" : "blocked");
  });

  test("a short-only 98 reading blocks despite the rotation scorer's unknown sentinel", () => {
    observe({ shortPercent: 98 });
    expect(isMainAccountHardLocked(enabled, now)).toBe(true);
  });

  test("reset times accept seconds and milliseconds but recovery requires fresh evidence", () => {
    observe({ weeklyPercent: 99, weeklyResetAt: (now + 60_000) / 1000, shortPercent: 100, shortResetAt: now + 120_000 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "blocked", resetAt: now + 120_000 });
    expect(getMainAccountHardLockStatus(enabled, now + 60_000).state).toBe("blocked");
    expect(getMainAccountHardLockStatus(enabled, now + 120_000)).toEqual({ enabled: true, state: "blocked" });
    observe({ shortPercent: 0 });
    // Weekly99 still blocks on its own after the 5h window reads 0.
    expect(getMainAccountHardLockStatus(enabled, now + 120_000).state).toBe("blocked");
    observe({ weeklyPercent: 0 });
    expect(getMainAccountHardLockStatus(enabled, now + 120_000)).toEqual({ enabled: true, state: "ready" });
  });

  test.each([
    { resetCredits: 2 },
    { weeklyPercent: 20 },
    { shortWindowSeconds: 18_000, shortResetAt: 4_000_000_000 },
  ])("partial update %j preserves expired main blocking evidence", partial => {
    const elapsed = Math.floor(Date.now() / 1000) - 60;
    observe({ shortPercent: 99, shortWindowSeconds: 18_000, shortResetAt: elapsed, weeklyPercent: 20 });
    expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");
    const before = getMainPolicyQuota();
    observe(partial);
    expect(getMainPolicyQuota()).toMatchObject({
      shortPercent: 99,
      shortResetAt: elapsed,
      shortWindowSeconds: 18_000,
      shortObservedAt: before?.shortObservedAt,
    });
    expect(getAccountQuota("__main__")?.shortPercent).toBeUndefined();
    expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");
    observe({ shortPercent: 0 });
    expect(getMainAccountHardLockStatus(enabled).state).toBe("ready");
  });

  test.each([4, 101])("an expired non-blocking short reading %s cannot hide a fresh weekly block", shortPercent => {
    const elapsed = Math.floor(Date.now() / 1000) - 60;
    observe({ shortPercent, shortWindowSeconds: 18_000, shortResetAt: elapsed, weeklyPercent: 20 });

    observe({ weeklyPercent: 99 });

    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 99 });
    expect(getMainPolicyQuota()?.shortPercent).toBeUndefined();
    expect(getMainPolicyQuota()?.shortResetAt).toBeUndefined();
    expect(getMainPolicyQuota()?.shortWindowSeconds).toBeUndefined();
    expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");
  });

  test("one missing reset prevents a false scheduled-unlock promise", () => {
    observe({ weeklyPercent: 99, monthlyPercent: 99, monthlyResetAt: now + 60_000 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "blocked" });
    expect(isMainAccountHardLocked(enabled, now + 24 * 60 * 60_000)).toBe(true);
  });

  test.each(["shortPercent", "weeklyPercent"] as const)("%s resets to zero, unlocks, and rearms at 98 without disabling", field => {
    observe({ [field]: 98 });
    expect(isMainAccountHardLocked(enabled, now)).toBe(true);
    observe({ [field]: 0 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "ready" });
    observe({ [field]: 98 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("blocked");
  });

  test.each([
    { shortPercent: 98, weeklyPercent: 50, state: "blocked" },
    { shortPercent: 99, weeklyPercent: 20, state: "blocked" },
    { shortPercent: 97, weeklyPercent: 98, state: "blocked" },
    { shortPercent: 20, weeklyPercent: 100, state: "blocked" },
    { shortPercent: 97, weeklyPercent: 97.99, state: "ready" },
  ])("5h $shortPercent / weekly $weeklyPercent is $state: either window at 98 blocks alone", ({ state, ...usage }) => {
    observe({ ...usage, shortWindowSeconds: 18_000 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe(state);
  });

  test("the lock holds until every blocking window reads lower", () => {
    observe({ shortPercent: 99, shortWindowSeconds: 18_000, shortResetAt: now / 1000, weeklyPercent: 100 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "blocked" });
    observe({ shortPercent: 0 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("blocked");
    observe({ weeklyPercent: 97 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("ready");
    observe({ weeklyPercent: 98 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("blocked");
  });

  test("a blocked status reports the latest reset among the blocking windows only", () => {
    observe({ shortPercent: 99, shortResetAt: now + 60_000, weeklyPercent: 98, weeklyResetAt: now + 600_000 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "blocked", resetAt: now + 600_000 });
    observe({ shortPercent: 99, shortResetAt: now + 60_000, weeklyPercent: 40, weeklyResetAt: now + 600_000 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "blocked", resetAt: now + 60_000 });
  });

  test("an unknown 5h reading neither hides a weekly block nor blocks alone", () => {
    observe({ shortWindowSeconds: 18_000, weeklyPercent: 100 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("blocked");
    observe({ weeklyPercent: 20 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("unknown");
  });

  test("a reset-only weekly observation cannot release a retained weekly block", () => {
    observe({ shortPercent: 10, shortWindowSeconds: 18_000, weeklyPercent: 99, weeklyResetAt: now + 60_000 });
    observe({ weeklyResetAt: now + 120_000 });
    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 99, weeklyResetAt: now + 60_000 });
    expect(isMainAccountHardLocked(enabled, now)).toBe(true);
    observe({ monthlyPercent: 5, monthlyIsPrimaryWindow: true });
    expect(getMainPolicyQuota()?.weeklyPercent).toBeUndefined();
  });

  test("weekly-only accounts do not use a higher monthly bar", () => {
    observe({ weeklyPercent: 97, monthlyPercent: 100 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("ready");
  });

  test("monthly-only accounts use their available window", () => {
    observe({ monthlyPercent: 99 });
    expect(isMainAccountHardLocked(enabled, now)).toBe(true);
  });

  test("model-specific custom windows do not become a global main block", () => {
    observe({ weeklyPercent: 12, customWindows: [{ label: "Spark", percent: 100 }] });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("ready");
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 101])("invalid observation %s is unknown", percent => {
    observe({ weeklyPercent: percent });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("unknown");
  });

  test("another physical identity cannot inherit a retained block", () => {
    observe({ weeklyPercent: 100 });
    observeMainQuotaIdentity("policy-account-b");
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("unknown");
  });
});
