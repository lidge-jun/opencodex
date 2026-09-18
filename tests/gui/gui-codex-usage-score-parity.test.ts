import { describe, expect, test } from "bun:test";
import { computeCodexUsageScore as guiScore, normalizeQuotaForPlan } from "../../gui/src/codex-quota-utils";
import type { AccountQuota } from "../../gui/src/codex-quota-utils";
import { computeCodexUsageScore as routerScore } from "../../src/codex/routing/cooldown-math";
import { CODEX_UNKNOWN_USAGE_SCORE } from "../../src/codex/quota";
import { TERMINAL_SHORT_WINDOW_FRESHNESS_MS } from "../../src/codex/quota-types";

/**
 * The account-switch warning and the router must reach the same verdict for one snapshot, or
 * the dashboard reports an account as usable while the router refuses it (#5045).
 *
 * The two disagreed in three places, each of which looked local and correct: the dashboard
 * compared a stored reset against `now` without normalizing Unix seconds to milliseconds; it
 * accepted a fresh observation even when an ELAPSED reset was present, where the router treats
 * a reset as authoritative once it exists; and the Free/Go projection dropped the burst window
 * that the router counts on every plan.
 *
 * So this compares the two implementations on shared fixtures rather than asserting either
 * one against a literal. A future edit that moves one side alone fails here.
 */
const NOW = 1_800_000_000_000;

/** The router spells unknown as a sentinel above the 0..100 domain; the dashboard spells it null. */
type RouterQuota = Parameters<typeof routerScore>[0];
const asRouterQuota = (quota: AccountQuota): RouterQuota => quota as unknown as RouterQuota;

function agree(quota: AccountQuota, plan?: string | null): { gui: number | null; router: number } {
  return {
    gui: guiScore(quota, plan ?? null, NOW),
    router: routerScore(asRouterQuota(quota), plan ?? null, NOW),
  };
}

function expectSame(quota: AccountQuota, plan?: string | null): void {
  const { gui, router } = agree(quota, plan);
  const guiAsRouter = gui === null ? CODEX_UNKNOWN_USAGE_SCORE : gui;
  expect({ quota, plan: plan ?? null, gui: guiAsRouter }).toEqual({ quota, plan: plan ?? null, gui: router });
}

describe("account-switch warning agrees with routing (#5045)", () => {
  test("a terminal burst window reads the same in seconds and in milliseconds", () => {
    // Both units reach storage. Read as milliseconds, a seconds-form instant lands in 1970 and
    // every future reset looks elapsed — a check that passes its own test and does nothing.
    const futureMs = NOW + 60_000;
    for (const shortResetAt of [futureMs, Math.floor(futureMs / 1000)]) {
      const quota: AccountQuota = { shortPercent: 100, shortResetAt, updatedAt: NOW };
      expectSame(quota);
      expect(guiScore(quota, null, NOW)).toBe(100);
    }
  });

  test("an elapsed reset is authoritative even with a fresh observation", () => {
    // The reset says the window is over. Freshness is the fallback for a reading that has no
    // reset at all, not a second opinion that can override one.
    expectSame({
      shortPercent: 100,
      shortResetAt: Math.floor((NOW - 60_000) / 1000),
      shortObservedAt: NOW - 1_000,
      updatedAt: NOW,
    });
  });

  test("a reset-less reading follows its observation freshness on both sides", () => {
    for (const age of [0, TERMINAL_SHORT_WINDOW_FRESHNESS_MS, TERMINAL_SHORT_WINDOW_FRESHNESS_MS + 1]) {
      expectSame({ shortPercent: 100, shortObservedAt: NOW - age, updatedAt: NOW });
    }
    // Neither reset nor observation is still unknown, not exhausted: a wrongly-excluded account
    // is invisible until someone reads the pool by hand.
    expectSame({ shortPercent: 100, updatedAt: NOW });
  });

  test("a known governing window still wins over the burst refinement", () => {
    expectSame({ weeklyPercent: 42, monthlyPercent: 7, shortPercent: 100, updatedAt: NOW });
    expectSame({ monthlyPercent: 90, updatedAt: NOW }, "plus");
  });

  test("the Free/Go projection keeps the evidence its own score needs", () => {
    // Free/Go has no weekly window, which is what this projection exists to drop. The burst
    // window is upstream-enforced on every plan, so dropping it too left the dashboard with no
    // governing window AND no terminal evidence for an account the router was refusing.
    const stored: AccountQuota = {
      weeklyPercent: 50,
      shortPercent: 100,
      shortObservedAt: NOW - 1_000,
      updatedAt: NOW,
    };
    const projected = normalizeQuotaForPlan(stored, "free");
    expect(projected?.weeklyPercent).toBeUndefined();
    expect(guiScore(projected, "free", NOW)).toBe(100);
    expect(guiScore(projected, "free", NOW)).toBe(routerScore(asRouterQuota(stored), "free", NOW));
  });
});
