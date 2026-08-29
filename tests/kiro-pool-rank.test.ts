import { afterEach, describe, expect, test } from "bun:test";
import { exhaustedCooldownMs, rankAccountsByHeadroom } from "../src/oauth/account-quota-rank";
import {
  clearAccountQuotaCache,
  setCachedProviderAccountQuotaForTests,
} from "../src/providers/quota";
import {
  clearKiroAccountUsageState,
  commitKiroAccountUsageState,
} from "../src/providers/kiro-usage";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccountQuotaCache();
  clearKiroAccountUsageState();
});

function seedPercent(provider: string, accountId: string, monthlyPercent: number): void {
  setCachedProviderAccountQuotaForTests(provider, accountId, { monthlyPercent, updatedAt: Date.now() });
}

function seedExhausted(accountId: string, nextResetAt?: number): void {
  commitKiroAccountUsageState(`kiro\u0000${accountId}`, {
    quota: { monthlyPercent: 100, updatedAt: Date.now() },
    exhausted: true,
    ...(nextResetAt !== undefined ? { nextResetAt } : {}),
  });
}

describe("headroom ranking", () => {
  test("the account with more remaining allowance goes first", () => {
    seedPercent("kiro", "a", 10);
    seedPercent("kiro", "b", 90);
    expect(rankAccountsByHeadroom("kiro", ["b", "a"])).toEqual(["a", "b"]);
  });

  test("a measured-healthy account outranks an unknown one even when heavily used", () => {
    // 95% used is still healthy: only a provider exhaustion verdict demotes an account.
    seedPercent("kiro", "b", 95);
    expect(rankAccountsByHeadroom("kiro", ["a", "b"])).toEqual(["b", "a"]);
  });

  test("an unknown account outranks one known to be exhausted", () => {
    seedExhausted("b");
    expect(rankAccountsByHeadroom("kiro", ["b", "a"])).toEqual(["a", "b"]);
  });

  test("an exhausted account sorts last even with a low percentage on record", () => {
    seedPercent("kiro", "a", 80);
    seedPercent("kiro", "b", 5);
    seedExhausted("b");
    expect(rankAccountsByHeadroom("kiro", ["b", "a"])).toEqual(["a", "b"]);
  });

  test("with no quota evidence the ring order is returned untouched", () => {
    expect(rankAccountsByHeadroom("xai", ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  test("equal headroom preserves ring order", () => {
    seedPercent("kiro", "a", 40);
    seedPercent("kiro", "b", 40);
    expect(rankAccountsByHeadroom("kiro", ["b", "a"])).toEqual(["b", "a"]);
  });

  test("the tightest window decides, not the roomiest", () => {
    setCachedProviderAccountQuotaForTests("anthropic", "a", {
      fiveHourPercent: 95, monthlyPercent: 5, updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("anthropic", "b", {
      fiveHourPercent: 30, monthlyPercent: 30, updatedAt: Date.now(),
    });
    expect(rankAccountsByHeadroom("anthropic", ["a", "b"])).toEqual(["b", "a"]);
  });

  test("ranking never reaches the network", () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    seedPercent("kiro", "a", 10);
    rankAccountsByHeadroom("kiro", ["a", "b"]);
    expect(called).toBe(false);
  });

  test("a single candidate is returned as-is", () => {
    expect(rankAccountsByHeadroom("kiro", ["only"])).toEqual(["only"]);
  });
});

describe("exhaustion cooldown", () => {
  test("a distant reset is clamped to a day", () => {
    const now = Date.now();
    seedExhausted("a", now + 3 * 24 * 60 * 60_000);
    expect(exhaustedCooldownMs("kiro", "a", now)).toBe(24 * 60 * 60_000);
  });

  test("an imminent reset is floored at five minutes", () => {
    const now = Date.now();
    seedExhausted("a", now + 30_000);
    expect(exhaustedCooldownMs("kiro", "a", now)).toBe(5 * 60_000);
  });

  test("a reset inside the window is honoured exactly", () => {
    const now = Date.now();
    seedExhausted("a", now + 60 * 60_000);
    expect(exhaustedCooldownMs("kiro", "a", now)).toBe(60 * 60_000);
  });

  test("a healthy account has no exhaustion cooldown", () => {
    seedPercent("kiro", "a", 10);
    expect(exhaustedCooldownMs("kiro", "a")).toBeNull();
  });

  test("providers without an exhaustion verdict are unaffected", () => {
    expect(exhaustedCooldownMs("xai", "a")).toBeNull();
  });
});
