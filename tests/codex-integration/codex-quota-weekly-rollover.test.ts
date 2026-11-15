import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { isMainAccountHardLocked } from "../../src/codex/main-account-hard-lock";
import { clearAccountQuota, flushQuotaObservationsForTests, getAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed, updateAccountQuota, type StoredAccountQuota } from "../../src/codex/quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Regression coverage for "weekly bar stuck at a pre-reset high percentage".
 *
 * Before the fix, `mergeAccountQuota` carried `existing.weeklyPercent` forward unconditionally
 * whenever an observation omitted the weekly window (credits-only / reset-only / short-only
 * headers). `assignCarriedShort` already guarded the 5h window with `shortResetHasElapsed`,
 * but the weekly branch had no equivalent — so a stale 98% outlived its own `weeklyResetAt`
 * and kept suppressing a main account that was actually back to 4%.
 *
 * The bug had a second, non-obvious cost. The main-account hard lock reads the *policy* snapshot
 * and gates quota auto-refresh admission, so a percentage that can never expire also blocks the
 * one mechanism that could re-measure it. The account reported "usage limit reached" for ~20h
 * against a true 4% and could only be fixed by hand-editing the cache.
 *
 * The fix is deliberately asymmetric, and these tests pin both halves:
 * - Display path: a reading whose window is over is dropped, so the bar and the routing decision
 *   return to "unknown" — the state that invites a fresh measurement.
 * - Policy path: untouched. Releasing a hard lock must remain an explicit observation, never a
 *   side effect of a clock advancing (see `main-account-hard-lock-policy`).
 */

const ACCOUNT = "__main__";
const IDENTITY = "rollover-account";
const previousHome = process.env.OPENCODEX_HOME;
let homes: string[];
let home: string;

function secondsFromNow(offsetSeconds: number): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds;
}

const creditsOnly = {
  credits: { hasCredits: false, unlimited: false, overageLimitReached: false, allowed: true, balance: 0 },
};

/** Publish through the main writer so the identity-bound policy snapshot is exercised too. */
function observePolicy(quota: Omit<StoredAccountQuota, "updatedAt">): void {
  const writer = captureMainQuotaWriter(IDENTITY);
  if (!writer) throw new Error("fixture identity was not observed");
  setAccountQuotaFromParsed(ACCOUNT, quota, undefined, writer);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-codex-quota-rollover-"));
  homes = [home];
  process.env.OPENCODEX_HOME = home;
  clearAccountQuota();
  clearMainAccountInfoCache();
  observeMainQuotaIdentity(IDENTITY);
});

afterEach(async () => {
  clearAccountQuota();
  clearMainAccountInfoCache();
  await flushQuotaObservationsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  for (const path of homes) removeTreeWithRetry(path);
});

describe("weekly window rollover", () => {
  test("a credits-only observation after the weekly reset drops the stale percentage", () => {
    // Previous window: 98% used, reset already in the past.
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(-3600) });
    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBe(98);

    // The next request only refreshes credits (no weekly header). It must not resurrect 98%:
    // that reading belongs to a window which has already rolled over.
    setAccountQuotaFromParsed(ACCOUNT, creditsOnly);

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBeUndefined();
    // The reset clock goes with the percentage it described; a half-tuple would be a lie.
    expect(getAccountQuota(ACCOUNT)?.weeklyResetAt).toBeUndefined();
  });

  test("a still-live weekly window keeps carrying its percentage forward", () => {
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(3600) });

    // Same window, credits-only refresh: the known reading is still valid evidence.
    setAccountQuotaFromParsed(ACCOUNT, creditsOnly);

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBe(98);
  });

  test("a fresh weekly observation overwrites the rolled-over value", () => {
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(-3600) });
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 4, weeklyResetAt: secondsFromNow(604_800) });

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBe(4);
  });

  test("a weekly window with no reset clock still carries forward (unknown is not elapsed)", () => {
    // Without a deadline there is no evidence the window closed, so the reading stays. Guessing
    // here would silently erase a real reading every time upstream omits the reset header.
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98 });
    setAccountQuotaFromParsed(ACCOUNT, creditsOnly);

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBe(98);
  });

  test("a monthly-only observation still clears a live weekly reading (unchanged #382 behavior)", () => {
    // The weekly deadline is still in the future, so neither expiry signal applies; the legacy
    // monthly-only clearing rule is what retires it, and the expiry change must not alter that.
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(600) });
    setAccountQuotaFromParsed(ACCOUNT, { monthlyPercent: 5, monthlyResetAt: secondsFromNow(600) });

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBeUndefined();
  });

  test("a short-only observation also cannot resurrect an expired weekly reading", () => {
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(-3600) });
    // Rotation traffic often reports only the 5h window.
    setAccountQuotaFromParsed(ACCOUNT, { shortPercent: 12, shortResetAt: secondsFromNow(600) });

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBeUndefined();
    expect(getAccountQuota(ACCOUNT)?.shortPercent).toBe(12);
  });

  test("the policy snapshot never expires a weekly reading on its own", () => {
    // Same expired-deadline input, but published as policy evidence for the hard lock.
    observePolicy({ weeklyPercent: 99, weeklyResetAt: secondsFromNow(-3600) });

    // "A predicted reset is not recovery evidence" (#hard-lock contract): the clock passing is
    // not an observation, so the blocking tuple must survive verbatim...
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);

    // ...and an observation that only moves the deadline is not a recovery either.
    observePolicy({ weeklyResetAt: secondsFromNow(1200) });
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    expect(isMainAccountHardLocked({ codexMainAccountHardLock: true })).toBe(true);
  });

  test("a credits-only refresh never expires a blocking policy reading", () => {
    // Policy evidence for the hard lock must only change through an explicit lower observation:
    // a credits-only refresh after the weekly deadline has passed is not one.
    observePolicy({ weeklyPercent: 99, weeklyResetAt: secondsFromNow(-3600) });
    observePolicy(creditsOnly);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    expect(isMainAccountHardLocked({ codexMainAccountHardLock: true })).toBe(true);
  });

  test("a redeemed ticket on a credits-only refresh does not release the policy block", () => {
    observePolicy({ weeklyPercent: 99, weeklyResetAt: secondsFromNow(3600), resetCredits: 2 });
    observePolicy({ ...creditsOnly, resetCredits: 1 });
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    expect(isMainAccountHardLocked({ codexMainAccountHardLock: true })).toBe(true);
  });

  test("a genuinely lower weekly observation still releases the policy block", () => {
    // The escape hatch has to stay real, otherwise the guard would be a permanent trap.
    observePolicy({ weeklyPercent: 99, weeklyResetAt: secondsFromNow(-3600) });
    expect(isMainAccountHardLocked({ codexMainAccountHardLock: true })).toBe(true);

    observePolicy({ weeklyPercent: 4, weeklyResetAt: secondsFromNow(604_800) });
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(4);
    expect(isMainAccountHardLocked({ codexMainAccountHardLock: true })).toBe(false);
  });
});

/**
 * A manual reset ticket zeroes the window's usage without ending the window: the deadline moves
 * further out, so the "expired" and "deadline advanced" checks can both stay silent while the
 * pre-redemption percentage is already meaningless. The ticket count is the only signal that
 * survives in that shape, and it is also the only one that catches a redemption performed in the
 * ChatGPT web UI or on another machine.
 */
describe("redeemed reset ticket", () => {
  test("a redeemed ticket retires the pre-redemption percentage", () => {
    // One ticket available, window still live, 98% used.
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(7200), resetCredits: 1 });

    // The user redeems it elsewhere. The next observation may carry only credits plus the new
    // ticket count — no weekly value at all.
    setAccountQuotaFromParsed(ACCOUNT, { ...creditsOnly, resetCredits: 0 });

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBeUndefined();
    expect(getAccountQuota(ACCOUNT)?.weeklyResetAt).toBeUndefined();
    expect(getAccountQuota(ACCOUNT)?.resetCredits).toBe(0);
  });

  test("a granted ticket says nothing about usage and keeps the reading", () => {
    // Upstream periodically tops tickets up. That is not evidence the window emptied.
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(7200), resetCredits: 0 });

    setAccountQuotaFromParsed(ACCOUNT, { ...creditsOnly, resetCredits: 1 });

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBe(98);
  });

  test("an unchanged ticket count keeps the reading", () => {
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(7200), resetCredits: 2 });
    setAccountQuotaFromParsed(ACCOUNT, { ...creditsOnly, resetCredits: 2 });

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBe(98);
  });

  test("a missing ticket count is not a redemption", () => {
    // Absent evidence must never be read as "spent" — that would erase live readings.
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(7200), resetCredits: 1 });
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 97, weeklyResetAt: secondsFromNow(7200) });

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBe(97);
  });
});

/**
 * The WHAM (`/backend-api/wham/usage`) write path pre-seeds from the existing snapshot and only
 * overwrites when the caller supplies a value. It has the same hazard as the header path, and had
 * the same missing guard, so an expired weekly reading could survive there even after the merge
 * path was fixed.
 */
describe("wham usage path", () => {
  test("a credits-only WHAM update cannot resurrect an expired weekly reading", () => {
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(-3600) });

    // resetCredits only: no weekly value in the call, so it takes the carry-forward branch.
    updateAccountQuota(ACCOUNT, undefined, undefined, undefined, undefined, 1);

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBeUndefined();
    expect(getAccountQuota(ACCOUNT)?.weeklyResetAt).toBeUndefined();
    expect(getAccountQuota(ACCOUNT)?.resetCredits).toBe(1);
  });

  test("a live weekly window still carries through a credits-only WHAM update", () => {
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(3600) });

    updateAccountQuota(ACCOUNT, undefined, undefined, undefined, undefined, 1);

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBe(98);
  });

  test("a real WHAM weekly value always wins over the carry", () => {
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 98, weeklyResetAt: secondsFromNow(-3600) });

    updateAccountQuota(ACCOUNT, 4, secondsFromNow(604_800));

    expect(getAccountQuota(ACCOUNT)?.weeklyPercent).toBe(4);
  });
});
