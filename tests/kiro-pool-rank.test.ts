import { afterEach, describe, expect, test } from "bun:test";
import { exhaustedCooldownMs, rankAccountsByHeadroom } from "../src/oauth/account-quota-rank";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearGenericFailoverHealth,
  forgetGenericFailoverRoster,
  genericFailoverRetryAfterSeconds,
  preferredInitialAccount,
  rotateGenericOAuthAccountOn429,
} from "../src/oauth/generic-account-failover";
import {
  getAccountSet,
  markAccountNeedsReauth,
  removeAccount,
  saveCredential,
  setActiveAccount,
} from "../src/oauth/store";
import { getValidAccessSnapshotForAccount } from "../src/oauth";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import {
  clearAccountQuotaCache,
  setCachedProviderAccountQuotaForTests,
} from "../src/providers/quota";
import {
  clearKiroAccountUsageState,
  commitKiroAccountUsageState,
} from "../src/providers/kiro-usage";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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

describe("pre-dispatch account preference", () => {
  const OAUTH_PROVIDER = {
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authMode: "oauth",
  } as unknown as OcxProviderConfig;

  const config = { providers: { xai: OAUTH_PROVIDER } } as unknown as OcxConfig;
  const originalHome = process.env.OPENCODEX_HOME;
  let home: string;

  async function seedAccounts(count: number, providerName = "xai"): Promise<string[]> {
    for (let i = 0; i < count; i++) {
      await saveCredential(providerName, {
        access: `access-${i}`,
        refresh: `refresh-${i}`,
        expires: Date.now() + 3_600_000,
        accountId: `uuid-${i}`,
      } as never, { addAccount: true });
    }
    return getAccountSet(providerName)?.accounts.map(a => a.id) ?? [];
  }

  test("the account with more headroom is chosen before the first request", async () => {
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2);
      await setActiveAccount("xai", ids[0]!);
      setCachedProviderAccountQuotaForTests("xai", ids[0]!, { monthlyPercent: 95, updatedAt: Date.now() });
      setCachedProviderAccountQuotaForTests("xai", ids[1]!, { monthlyPercent: 5, updatedAt: Date.now() });
      expect(preferredInitialAccount(config, "xai")).toBe(ids[1]);
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("no quota evidence leaves the active account alone", async () => {
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2);
      await setActiveAccount("xai", ids[0]!);
      // Null means "use the ordinary active-account path", so nothing changes for a
      // provider that reports no per-account quota.
      expect(preferredInitialAccount(config, "xai")).toBeNull();
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("a single account is never redirected", async () => {
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(1);
      setCachedProviderAccountQuotaForTests("xai", ids[0]!, { monthlyPercent: 99, updatedAt: Date.now() });
      expect(preferredInitialAccount(config, "xai")).toBeNull();
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("an account cooled by a recent 429 is not chosen to open the next request", async () => {
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2);
      await setActiveAccount("xai", ids[0]!);
      // Cool the roomier account: positive evidence against it outweighs its headroom.
      setCachedProviderAccountQuotaForTests("xai", ids[0]!, { monthlyPercent: 50, updatedAt: Date.now() });
      setCachedProviderAccountQuotaForTests("xai", ids[1]!, { monthlyPercent: 1, updatedAt: Date.now() });
      rotateGenericOAuthAccountOn429(config, "xai", ids[1]!, null);
      expect(preferredInitialAccount(config, "xai")).toBeNull();
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("an exhausted account without Retry-After stays cooled through its reset window", async () => {
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2, "kiro");
      const now = Date.now();
      seedExhausted(ids[0]!, now + 60 * 60_000);
      const kiroConfig = {
        providers: { kiro: OAUTH_PROVIDER },
      } as unknown as OcxConfig;

      expect(rotateGenericOAuthAccountOn429(kiroConfig, "kiro", ids[0]!, null, now)).toBe(ids[1]);
      expect(genericFailoverRetryAfterSeconds("kiro", now)).toBe(60 * 60);
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("an unparseable Retry-After uses an exhausted account reset", async () => {
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2, "kiro");
      const now = Date.now();
      seedExhausted(ids[0]!, now + 60 * 60_000);
      const kiroConfig = {
        providers: { kiro: OAUTH_PROVIDER },
      } as unknown as OcxConfig;

      expect(
        rotateGenericOAuthAccountOn429(kiroConfig, "kiro", ids[0]!, "not-a-duration", now),
      ).toBe(ids[1]);
      expect(genericFailoverRetryAfterSeconds("kiro", now)).toBe(60 * 60);
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("valid immediate Retry-After values override an exhausted account reset", async () => {
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2, "kiro");
      const now = Date.now();
      seedExhausted(ids[0]!, now + 60 * 60_000);
      const kiroConfig = {
        providers: { kiro: OAUTH_PROVIDER },
      } as unknown as OcxConfig;

      for (const retryAfter of ["0", new Date(now - 1_000).toUTCString()]) {
        clearGenericFailoverHealth();
        expect(
          rotateGenericOAuthAccountOn429(kiroConfig, "kiro", ids[0]!, retryAfter, now),
        ).toBe(ids[1]);
        expect(genericFailoverRetryAfterSeconds("kiro", now)).toBe(1);
      }
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("a valid Retry-After overrides an exhausted account reset", async () => {
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2, "kiro");
      const now = Date.now();
      seedExhausted(ids[0]!, now + 60 * 60_000);
      const kiroConfig = {
        providers: { kiro: OAUTH_PROVIDER },
      } as unknown as OcxConfig;

      expect(rotateGenericOAuthAccountOn429(kiroConfig, "kiro", ids[0]!, "120", now)).toBe(ids[1]);
      expect(genericFailoverRetryAfterSeconds("kiro", now)).toBe(120);
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("a quota-less provider is never redirected, even when the ACTIVE account is cooled", async () => {
    // The inverse of the case above, and the one that actually broke the no-op guarantee:
    // cooling the active account collapses the eligible list to a single candidate, which
    // any ranking returns unchanged. That looks like a ranked answer but nothing was ever
    // measured, so evidence has to be checked against the whole roster first.
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2);
      await setActiveAccount("xai", ids[0]!);
      rotateGenericOAuthAccountOn429(config, "xai", ids[0]!, null);
      expect(preferredInitialAccount(config, "xai")).toBeNull();
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("neither a redirecting nor a non-redirecting selection touches the credential store", async () => {
    // loadAuthStore chmods the config dir, chmods the secret, and re-parses the whole
    // credential file on every call — and this runs on the initial resolution of EVERY
    // request. The steady state of this feature is a pool where one account consistently
    // ranks higher, so the REDIRECTING path must be cached too — validating the winner here
    // would put a second uncached read in front of every such request. Deleting the store
    // proves it: an uncached path could not answer at all. Staleness is caught at
    // resolution instead, inside a store read the resolver already performs.
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2);
      await setActiveAccount("xai", ids[0]!);
      // Redirecting: the other account holds more headroom on every call.
      setCachedProviderAccountQuotaForTests("xai", ids[0]!, { monthlyPercent: 95, updatedAt: Date.now() });
      setCachedProviderAccountQuotaForTests("xai", ids[1]!, { monthlyPercent: 5, updatedAt: Date.now() });
      expect(preferredInitialAccount(config, "xai")).toBe(ids[1]);
      rmSync(join(home, "auth.json"), { force: true });
      for (let i = 0; i < 4; i++) expect(preferredInitialAccount(config, "xai")).toBe(ids[1]);

      // Non-redirecting: the active account already ranks best.
      setCachedProviderAccountQuotaForTests("xai", ids[0]!, { monthlyPercent: 5, updatedAt: Date.now() });
      setCachedProviderAccountQuotaForTests("xai", ids[1]!, { monthlyPercent: 95, updatedAt: Date.now() });
      for (let i = 0; i < 4; i++) expect(preferredInitialAccount(config, "xai")).toBeNull();
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("a preferred account removed inside the TTL degrades to the active account", async () => {
    // The roster is cached for a short window, so an account can be removed after it was
    // chosen. Resolving it then throws, and the request path must fall back to the active
    // account rather than 401 — a preference must never break a request that would have
    // worked without it.
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2);
      await setActiveAccount("xai", ids[0]!);
      setCachedProviderAccountQuotaForTests("xai", ids[0]!, { monthlyPercent: 95, updatedAt: Date.now() });
      setCachedProviderAccountQuotaForTests("xai", ids[1]!, { monthlyPercent: 5, updatedAt: Date.now() });
      expect(preferredInitialAccount(config, "xai")).toBe(ids[1]);

      await removeAccount("xai", ids[1]!);
      // Selection is a cached PREFERENCE, so it may still name the removed account...
      expect(preferredInitialAccount(config, "xai")).toBe(ids[1]);
      // ...and resolution is where that is caught. The request path absorbs this throw and
      // falls back to the active account.
      await expect(
        getValidAccessSnapshotForAccount("xai", ids[1]!, { requireUsableAccount: true }),
      ).rejects.toThrow();
      expect(getAccountSet("xai")?.accounts.map(a => a.id)).toEqual([ids[0]!]);
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });

  test("a preferred account flagged for reauth inside the TTL is not selected", async () => {
    // The dangerous variant of stale roster data: unlike a removal, a needsReauth account
    // still has a readable credential, so resolution SUCCEEDS and no error path fires. The
    // request would dispatch on an account already known to need a fresh login while a
    // healthy active account sat unused.
    home = mkdtempSync(join(tmpdir(), "ocx-predispatch-"));
    process.env.OPENCODEX_HOME = home;
    clearGenericFailoverHealth();
    clearAccountQuotaCache();
    try {
      const ids = await seedAccounts(2);
      await setActiveAccount("xai", ids[0]!);
      setCachedProviderAccountQuotaForTests("xai", ids[0]!, { monthlyPercent: 95, updatedAt: Date.now() });
      setCachedProviderAccountQuotaForTests("xai", ids[1]!, { monthlyPercent: 5, updatedAt: Date.now() });
      expect(preferredInitialAccount(config, "xai")).toBe(ids[1]);

      await markAccountNeedsReauth("xai", ids[1]!, true);
      // An ordinary resolve SUCCEEDS — the credential is still readable — which is exactly
      // why the flag must be checked inside the resolver rather than trusted to throw.
      await expect(getValidAccessSnapshotForAccount("xai", ids[1]!)).resolves.toBeDefined();
      // With the opt-in the request path uses, it is rejected and the caller falls back.
      await expect(
        getValidAccessSnapshotForAccount("xai", ids[1]!, { requireUsableAccount: true }),
      ).rejects.toThrow();
    } finally {
      clearGenericFailoverHealth();
      clearAccountQuotaCache();
      if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = originalHome;
      removeTreeWithRetry(home);
    }
  });
});
