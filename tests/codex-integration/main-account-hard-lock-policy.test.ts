import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMainAccountHardLockStatus, isMainAccountHardLocked } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { clearAccountQuota, setAccountQuotaFromParsed, type StoredAccountQuota } from "../../src/codex/quota";
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
  test("absent and disabled preserve admission even at 100", () => {
    observe({ weeklyPercent: 100 });
    expect(getMainAccountHardLockStatus({}, now)).toEqual({ enabled: false, state: "off" });
    expect(isMainAccountHardLocked({ codexMainAccountHardLock: false }, now)).toBe(false);
  });

  test("unknown is not a fabricated empty or exhausted quota", () => {
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "unknown" });
    setAccountQuotaFromParsed("__main__", { weeklyPercent: 100 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("unknown");
  });

  test.each([98.99, 99, 100])("raw %s percent is compared without GUI rounding", percent => {
    observe({ weeklyPercent: percent });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe(percent < 99 ? "ready" : "blocked");
  });

  test("a short-only 99 reading blocks despite the rotation scorer's unknown sentinel", () => {
    observe({ shortPercent: 99 });
    expect(isMainAccountHardLocked(enabled, now)).toBe(true);
  });

  test("reset times accept seconds and milliseconds but recovery requires fresh evidence", () => {
    observe({ weeklyPercent: 99, weeklyResetAt: (now + 60_000) / 1000, shortPercent: 100, shortResetAt: now + 120_000 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "blocked", resetAt: now + 120_000 });
    expect(getMainAccountHardLockStatus(enabled, now + 60_000).state).toBe("blocked");
    expect(getMainAccountHardLockStatus(enabled, now + 120_000)).toEqual({ enabled: true, state: "blocked" });
    observe({ shortPercent: 0 });
    expect(getMainAccountHardLockStatus(enabled, now + 120_000)).toEqual({ enabled: true, state: "ready" });
  });

  test("one missing reset prevents a false scheduled-unlock promise", () => {
    observe({ weeklyPercent: 99, monthlyPercent: 99, monthlyResetAt: now + 60_000 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "blocked" });
    expect(isMainAccountHardLocked(enabled, now + 24 * 60 * 60_000)).toBe(true);
  });

  test.each(["shortPercent", "weeklyPercent"] as const)("%s resets to zero, unlocks, and rearms at 99 without disabling", field => {
    observe({ [field]: 99 });
    expect(isMainAccountHardLocked(enabled, now)).toBe(true);
    observe({ [field]: 0 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "ready" });
    observe({ [field]: 99 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("blocked");
  });

  test("5h usage wins over a higher weekly window", () => {
    observe({ shortPercent: 98, shortWindowSeconds: 18_000, weeklyPercent: 100 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("ready");
    observe({ shortPercent: 99, shortWindowSeconds: 18_000, weeklyPercent: 20 });
    expect(isMainAccountHardLocked(enabled, now)).toBe(true);
  });

  test("an expired 5h window does not fall back to the high weekly bar", () => {
    observe({ shortPercent: 99, shortWindowSeconds: 18_000, shortResetAt: now / 1000, weeklyPercent: 100 });
    expect(getMainAccountHardLockStatus(enabled, now)).toEqual({ enabled: true, state: "blocked" });
    observe({ shortPercent: 0 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("ready");
  });

  test("a known 5h shape with no percentage stays unknown instead of selecting weekly", () => {
    observe({ shortWindowSeconds: 18_000, weeklyPercent: 100 });
    expect(getMainAccountHardLockStatus(enabled, now).state).toBe("unknown");
  });

  test("weekly-only accounts do not use a higher monthly bar", () => {
    observe({ weeklyPercent: 98, monthlyPercent: 100 });
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
