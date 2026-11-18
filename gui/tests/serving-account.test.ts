import { describe, expect, test } from "bun:test";
import type { CodexAccountEntry } from "../src/hooks/useCodexAccountPool";
import { servingAccount } from "../src/components/v2-accounts/serving-account";

function account(id: string, extra: Partial<CodexAccountEntry> = {}): CodexAccountEntry {
  return {
    id,
    email: "",
    isMain: false,
    paused: false,
    priority: 0,
    autoSwitchThresholdOverride: null,
    hasCredential: true,
    quota: null,
    quotaAutoRefresh: { fiveHourAvailable: false, weeklyAvailable: false, fiveHourEnabled: false, weeklyEnabled: false },
    ...extra,
  };
}

const blocked = { enabled: true, state: "blocked" } as const;

describe("servingAccount", () => {
  test("Direct mode serves the main login even when it is paused for the pool", () => {
    const main = account("main", { isMain: true, paused: true });
    expect(servingAccount([main, account("a")], "a", "direct")).toBe(main);
  });

  test("Direct mode names no account when the main hard lock is blocking", () => {
    const main = account("main", { isMain: true, mainAccountHardLock: blocked });
    expect(servingAccount([main, account("a")], null, "direct")).toBeNull();
  });

  test("Pool mode serves the selected account, else an unpaused, unlocked main", () => {
    const main = account("main", { isMain: true });
    const pooled = account("a");
    expect(servingAccount([main, pooled], "a", "pool")).toBe(pooled);
    expect(servingAccount([main, account("a", { paused: true })], "a", "pool")).toBe(main);
    expect(servingAccount([account("main", { isMain: true, mainAccountHardLock: blocked })], null, "pool")).toBeNull();
  });
});
