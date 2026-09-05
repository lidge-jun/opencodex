import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import type { OcxConfig } from "../../src/types";
import {
  clearAccountQuotaCache,
  clearProviderQuotaCache,
  fetchProviderAccountQuotas,
  fetchProviderQuotaReports,
  getCachedProviderAccountQuota,
  reconcileProviderAccountQuotaRows,
  resetProviderQuotaReconcileStateForTests,
  supportsPerAccountQuota,
  providerOAuthAccountQuotaMode,
} from "../../src/providers/quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

const FIRST = { accountId: "acct-first", email: "first@example.com" };
const SECOND = { accountId: "acct-second", email: "second@example.com" };

/** Two logged-in Claude accounts, each with its own (non-expired) bearer token. */
async function seedTwoAccounts(): Promise<void> {
  const expires = Date.now() + 60 * 60_000;
  await saveCredential("anthropic", { access: "token-first", refresh: "refresh-first", expires, ...FIRST });
  await saveCredential("anthropic", { access: "token-second", refresh: "refresh-second", expires, ...SECOND });
}

function usageBody(fiveHour: number, sevenDay: number): string {
  return JSON.stringify({
    five_hour: { utilization: fiveHour, resets_at: "2026-07-05T12:00:00Z" },
    seven_day: { utilization: sevenDay, resets_at: "2026-07-08T12:00:00Z" },
  });
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-account-quota-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearAccountQuotaCache();
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(opencodexHome);
  clearAccountQuotaCache();
  clearProviderQuotaCache();
  resetProviderQuotaReconcileStateForTests();
});

describe("fetchProviderAccountQuotas", () => {
  test("reports each account's own rate limits, keyed by the account's bearer token", async () => {
    await seedTwoAccounts();
    const seenTokens: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.anthropic.com/api/oauth/usage");
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seenTokens.push(auth);
      // Distinct upstream numbers per credential — the whole point of a per-account probe.
      const body = auth.endsWith("token-first") ? usageBody(70, 15) : usageBody(3, 21);
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("anthropic");
    const byId = Object.fromEntries(rows.map(row => [row.accountId, row]));
    const ids = Object.keys(byId);
    expect(ids.length).toBe(2);

    const values = rows.map(row => `${row.quota?.fiveHourPercent}/${row.quota?.weeklyPercent}`).sort();
    expect(values).toEqual(["3/21", "70/15"]);
    expect(seenTokens.sort()).toEqual(["Bearer token-first", "Bearer token-second"]);
    // The 5-hour window lands in the canonical fields, not in customWindows.
    for (const row of rows) expect(row.quota?.customWindows).toBeUndefined();
  });

  test("a cached row is reused instead of re-probing upstream", async () => {
    await seedTwoAccounts();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(usageBody(50, 10), { status: 200 });
    }) as typeof fetch;

    await fetchProviderAccountQuotas("anthropic");
    expect(calls).toBe(2);
    await fetchProviderAccountQuotas("anthropic");
    expect(calls).toBe(2);

    // A forced refresh bypasses the TTL.
    await fetchProviderAccountQuotas("anthropic", true);
    expect(calls).toBe(4);
  });

  test("a failing probe is flagged unavailable without dropping the other account", async () => {
    await seedTwoAccounts();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      // Anthropic rate-limits this endpoint; one 429 must not blank the sibling account.
      if (auth.endsWith("token-first")) return new Response("rate limited", { status: 429 });
      return new Response(usageBody(3, 21), { status: 200 });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("anthropic");
    const failed = rows.find(row => row.quota === null);
    const ok = rows.find(row => row.quota !== null);
    expect(failed?.unavailable).toBe(true);
    expect(ok?.quota?.fiveHourPercent).toBe(3);
  });

  test("success-then-fail preserves last-good quota and keeps unavailable", async () => {
    await seedTwoAccounts();
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      calls += 1;
      if (calls <= 2) {
        const body = auth.endsWith("token-first") ? usageBody(70, 15) : usageBody(3, 21);
        return new Response(body, { status: 200 });
      }
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;

    const first = await fetchProviderAccountQuotas("anthropic");
    expect(first.every(row => row.quota && !row.unavailable)).toBe(true);
    expect(calls).toBe(2);
    const firstByValues = Object.fromEntries(
      first.map(row => [`${row.quota?.fiveHourPercent}/${row.quota?.weeklyPercent}`, row.accountId]),
    );

    const second = await fetchProviderAccountQuotas("anthropic", true);
    expect(calls).toBe(4);
    for (const row of second) {
      expect(row.unavailable).toBe(true);
      expect(row.quota).not.toBeNull();
    }
    const byId = Object.fromEntries(second.map(row => [row.accountId, row]));
    expect(byId[firstByValues["70/15"]!]?.quota?.fiveHourPercent).toBe(70);
    expect(byId[firstByValues["3/21"]!]?.quota?.fiveHourPercent).toBe(3);
  });

  test("failed probes negative-cache for the account TTL instead of re-probing", async () => {
    await seedTwoAccounts();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;

    const first = await fetchProviderAccountQuotas("anthropic");
    expect(first.every(row => row.unavailable && row.quota === null)).toBe(true);
    expect(calls).toBe(2);

    const second = await fetchProviderAccountQuotas("anthropic");
    expect(second.every(row => row.unavailable && row.quota === null)).toBe(true);
    expect(calls).toBe(2);
  });

  test("expired background accounts skip CLI-adopting refresh for quota probes", async () => {
    const expires = Date.now() - 60_000;
    await saveCredential("anthropic", {
      access: "token-active", refresh: "refresh-active", expires: Date.now() + 60 * 60_000,
      accountId: "acct-active", email: "active@example.com",
    });
    await saveCredential("anthropic", {
      access: "token-bg", refresh: "refresh-bg", expires,
      accountId: "acct-bg", email: "bg@example.com", source: "local-cli",
    });
    const { getAccountSet, setActiveAccount } = await import("../../src/oauth/store");
    const set = getAccountSet("anthropic");
    const active = set?.accounts.find(a => a.credential.email === "active@example.com");
    const background = set?.accounts.find(a => a.credential.email === "bg@example.com");
    expect(active && background).toBeTruthy();
    await setActiveAccount("anthropic", active!.id);

    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      expect(auth).toBe("Bearer token-active");
      return new Response(usageBody(11, 22), { status: 200 });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("anthropic");
    const byId = Object.fromEntries(rows.map(row => [row.accountId, row]));
    expect(byId[active!.id]?.quota?.fiveHourPercent).toBe(11);
    expect(byId[active!.id]?.unavailable).toBeUndefined();
    expect(byId[background!.id]?.quota).toBeNull();
    expect(byId[background!.id]?.unavailable).toBe(true);
    // Only the active credential was probed; background expired slot failed closed.
    expect(calls).toBe(1);
    // Credential integrity: the expired local-cli background slot must not have
    // been overwritten with the active (or any other) disk/CLI identity.
    const after = getAccountSet("anthropic")?.accounts.find(a => a.id === background!.id);
    expect(after?.credential.access).toBe("token-bg");
    expect(after?.credential.email).toBe("bg@example.com");
    expect(after?.credential.source).toBe("local-cli");
  });

  test("providers without a per-account usage API are skipped", async () => {
    expect(supportsPerAccountQuota("anthropic")).toBe(true);
    // Login capability alone must never select another provider's quota reader.
    expect(supportsPerAccountQuota("kiro")).toBe(true);
    expect(supportsPerAccountQuota("github-copilot")).toBe(false);
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    expect(await fetchProviderAccountQuotas("github-copilot")).toEqual([]);
    expect(called).toBe(false);
  });

  test("a provider with no logged-in accounts yields no rows and no upstream calls", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    expect(await fetchProviderAccountQuotas("anthropic")).toEqual([]);
    expect(called).toBe(false);
  });

  test("provider-report probe seeds the active account cache for per-account reads", async () => {
    await seedTwoAccounts();
    const { getAccountSet, setActiveAccount } = await import("../../src/oauth/store");
    const set = getAccountSet("anthropic");
    const first = set?.accounts.find(a => a.credential.email === "first@example.com");
    expect(first).toBeTruthy();
    await setActiveAccount("anthropic", first!.id);
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const body = auth.endsWith("token-first") ? usageBody(70, 15) : usageBody(3, 21);
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 1455,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          authMode: "oauth",
          baseUrl: "https://api.anthropic.com/v1",
        },
      },
    };
    await fetchProviderQuotaReports(config, true);
    expect(calls).toBe(1);

    const rows = await fetchProviderAccountQuotas("anthropic");
    const byId = Object.fromEntries(rows.map(row => [row.accountId, row]));
    // Active account reused the provider-report probe; only the sibling was hit again.
    expect(calls).toBe(2);
    expect(byId[first!.id]?.quota?.fiveHourPercent).toBe(70);
    const sibling = rows.find(row => row.accountId !== first!.id);
    expect(sibling?.quota?.fiveHourPercent).toBe(3);
  });

  test("empty Anthropic usage payloads are treated as probe failures", async () => {
    await seedTwoAccounts();
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const rows = await fetchProviderAccountQuotas("anthropic");
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.unavailable && row.quota === null)).toBe(true);
  });

  test("expired ordinary OAuth background accounts still refresh for quota probes", async () => {
    const expires = Date.now() - 60_000;
    await saveCredential("anthropic", {
      access: "token-active", refresh: "refresh-active", expires: Date.now() + 60 * 60_000,
      accountId: "acct-active", email: "active@example.com", source: "oauth",
    });
    await saveCredential("anthropic", {
      access: "token-bg", refresh: "refresh-bg", expires,
      accountId: "acct-bg", email: "bg@example.com", source: "oauth",
    });
    const { getAccountSet, setActiveAccount } = await import("../../src/oauth/store");
    const set = getAccountSet("anthropic");
    const active = set?.accounts.find(a => a.credential.email === "active@example.com");
    const background = set?.accounts.find(a => a.credential.email === "bg@example.com");
    expect(active && background).toBeTruthy();
    await setActiveAccount("anthropic", active!.id);

    let refreshCalls = 0;
    let usageForBg = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/oauth/token")) {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          access_token: "token-bg-fresh",
          refresh_token: "refresh-bg",
          expires_in: 3600,
        }), { status: 200 });
      }
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.endsWith("token-bg-fresh")) {
        usageForBg += 1;
        return new Response(usageBody(44, 55), { status: 200 });
      }
      return new Response(usageBody(11, 22), { status: 200 });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("anthropic");
    const byId = Object.fromEntries(rows.map(row => [row.accountId, row]));
    expect(refreshCalls).toBeGreaterThanOrEqual(1);
    expect(usageForBg).toBe(1);
    expect(byId[background!.id]?.quota?.fiveHourPercent).toBe(44);
    expect(byId[background!.id]?.unavailable).toBeUndefined();
  });

  test("clearing account quota cache after failure allows a fresh probe", async () => {
    await seedTwoAccounts();
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    const failed = await fetchProviderAccountQuotas("anthropic");
    expect(failed.every(row => row.unavailable)).toBe(true);

    // runLogin / reauth clears this cache after credentials are replaced.
    clearAccountQuotaCache("anthropic");
    globalThis.fetch = (async () => new Response(usageBody(9, 8), { status: 200 })) as typeof fetch;
    const after = await fetchProviderAccountQuotas("anthropic");
    expect(after.every(row => row.quota && !row.unavailable)).toBe(true);
  });

  test("provider-report seeding binds to the probed account across an active switch", async () => {
    await seedTwoAccounts();
    const { getAccountSet, setActiveAccount } = await import("../../src/oauth/store");
    const set = getAccountSet("anthropic");
    const first = set?.accounts.find(a => a.credential.email === "first@example.com");
    const second = set?.accounts.find(a => a.credential.email === "second@example.com");
    expect(first && second).toBeTruthy();
    await setActiveAccount("anthropic", first!.id);

    let releaseUsage!: () => void;
    const usageGate = new Promise<void>(resolve => { releaseUsage = resolve; });
    let usageCalls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.endsWith("token-first")) {
        usageCalls += 1;
        await usageGate;
        return new Response(usageBody(70, 15), { status: 200 });
      }
      return new Response(usageBody(3, 21), { status: 200 });
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 1455,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          authMode: "oauth",
          baseUrl: "https://api.anthropic.com/v1",
        },
      },
    };
    const reportPromise = fetchProviderQuotaReports(config, true);
    // Switch active mid-flight before Anthropic responds.
    await setActiveAccount("anthropic", second!.id);
    releaseUsage();
    await reportPromise;

    // First account still owns token-first — seed must land on first, not second.
    clearProviderQuotaCache();
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const body = auth.endsWith("token-first") ? usageBody(70, 15) : usageBody(3, 21);
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const rows = await fetchProviderAccountQuotas("anthropic");
    const byId = Object.fromEntries(rows.map(row => [row.accountId, row]));
    // First was seeded (no re-probe); only second needs a fresh probe after the switch.
    expect(usageCalls).toBe(1);
    expect(byId[first!.id]?.quota?.fiveHourPercent).toBe(70);
    expect(byId[second!.id]?.quota?.fiveHourPercent).toBe(3);
    expect(calls).toBe(1);
  });

  test("provider removal during an Anthropic report probe cannot recreate its account quota row", async () => {
    await seedTwoAccounts();
    const { getAccountSet, setActiveAccount } = await import("../../src/oauth/store");
    const first = getAccountSet("anthropic")?.accounts.find(account => account.credential.email === FIRST.email);
    expect(first).toBeTruthy();
    await setActiveAccount("anthropic", first!.id);

    let releaseUsage!: () => void;
    const usageGate = new Promise<void>(resolve => { releaseUsage = resolve; });
    globalThis.fetch = (async () => {
      await usageGate;
      return new Response(usageBody(70, 15), { status: 200 });
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 1455,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          authMode: "oauth",
          baseUrl: "https://api.anthropic.com/v1",
        },
      },
    };
    const reportPromise = fetchProviderQuotaReports(config, true);
    reconcileProviderAccountQuotaRows({
      generation: 10_000,
      providerNames: new Set(),
      comboIds: new Set(),
      comboTargets: new Set(),
      codexAccountIds: new Set(),
      oauthAccountKeys: new Set(),
      configRoots: new Set(),
    });
    releaseUsage();
    await reportPromise;

    expect(getCachedProviderAccountQuota("anthropic", first!.id)).toBeNull();
  });
});

describe("explicit OAuth account quota readers", () => {
  test("explicit OAuth probe failure drops last-good quota that expires during the upstream await", async () => {
    const realDateNow = Date.now;
    const observedAt = realDateNow();
    await saveCredential("kimi", {
      access: "quota-settlement-fixture", refresh: "refresh-settlement-fixture",
      expires: observedAt + 60 * 60_000, accountId: "quota-settlement-user",
    });
    let now = observedAt;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return Response.json({ usage: { limit: 100, used: 25 } });
      expect(now).toBe(observedAt + 29 * 60_000 + 59_000);
      now = observedAt + 30 * 60_000;
      return new Response("{}", { status: 429 });
    }) as typeof fetch;
    Date.now = () => now;
    try {
      expect((await fetchProviderAccountQuotas("kimi"))[0]?.quota?.updatedAt).toBe(observedAt);
      now = observedAt + 29 * 60_000 + 59_000;
      const [failed] = await fetchProviderAccountQuotas("kimi", true);
      expect(calls).toBe(2);
      expect(failed?.quota).toBeNull();
      expect(failed?.unavailable).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("a recent failed explicit OAuth probe cannot extend a last-good measurement past thirty minutes", async () => {
    const realDateNow = Date.now;
    const observedAt = realDateNow();
    await saveCredential("kimi", {
      access: "quota-age-fixture", refresh: "refresh-age-fixture",
      expires: observedAt + 60 * 60_000, accountId: "quota-age-user",
    });
    let now = observedAt;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? Response.json({ usage: { limit: 100, used: 25 } }) : new Response("{}", { status: 429 });
    }) as typeof fetch;
    Date.now = () => now;
    try {
      const [initial] = await fetchProviderAccountQuotas("kimi");
      expect(initial?.quota?.updatedAt).toBe(observedAt);
      now = observedAt + 29 * 60_000 + 59_000;
      const [failed] = await fetchProviderAccountQuotas("kimi", true);
      expect(failed?.unavailable).toBe(true);
      expect(failed?.quota?.updatedAt).toBe(observedAt);
      expect(calls).toBe(2);
      now += 1_000;
      const [expired] = await fetchProviderAccountQuotas("kimi");
      expect(expired?.quota).toBeNull();
      expect(expired?.unavailable).toBe(true);
      expect(calls).toBe(3);
      now += 1;
      expect((await fetchProviderAccountQuotas("kimi"))[0]?.quota).toBeNull();
      expect(calls).toBe(3);
    } finally {
      Date.now = realDateNow;
    }
  });

  const cases = [
    { provider: "xai", adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", field: "weeklyPercent" },
    { provider: "cursor", adapter: "cursor", baseUrl: "https://api2.cursor.sh", field: "monthlyPercent" },
    { provider: "kimi", adapter: "openai-chat", baseUrl: "https://api.kimi.com/coding/v1", field: "weeklyPercent" },
    { provider: "command-code", adapter: "command-code", baseUrl: "https://api.commandcode.ai", field: "fiveHourPercent" },
  ] as const;

  test("capability distinguishes seven readers, passive observations and unsupported login providers", () => {
    for (const provider of ["anthropic", "kiro", "google-antigravity", ...cases.map(row => row.provider)]) {
      expect(providerOAuthAccountQuotaMode(provider)).toBe("probe");
    }
    expect(providerOAuthAccountQuotaMode("meta-muse")).toBe("passive");
    expect(supportsPerAccountQuota("meta-muse")).toBe(false);
    expect(providerOAuthAccountQuotaMode("github-copilot")).toBe("unsupported");
  });

  for (const fixture of cases) {
    test(`${fixture.provider} reads both credentials without switching active selection`, async () => {
      const expires = Date.now() + 60 * 60_000;
      for (const name of ["first", "second"]) {
        await saveCredential(fixture.provider, { access: `quota-${name}`, refresh: `refresh-${name}`, expires, accountId: `user-${name}`, email: `${name}@example.com` });
      }
      const active = getAccountSet(fixture.provider)!.activeAccountId;
      const seen = new Set<string>();
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const auth = headers.get("authorization")!;
        const first = auth === "Bearer quota-first";
        const amount = first ? 12 : 68;
        const label = first ? "first" : "second";
        seen.add(auth);
        const url = String(input);
        expect(init?.redirect).toBe("error");
        expect(new URL(url).protocol).toBe("https:");
        if (fixture.provider === "xai") {
          expect(headers.get("x-userid")).toBe(`user-${label}`);
          return Response.json({ config: { creditUsagePercent: amount, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } });
        }
        if (fixture.provider === "cursor") return Response.json({ planUsage: { totalPercentUsed: amount } });
        if (fixture.provider === "kimi") return Response.json({ usage: { limit: 100, used: amount } });
        if (url.endsWith("/alpha/whoami")) return Response.json({ org: { id: `org-${label}` } });
        expect(new URL(url).searchParams.get("orgId")).toBe(`org-${label}`);
        if (url.includes("subscriptions")) return Response.json({ currentPeriodStart: "2026-09-01T00:00:00Z" });
        if (url.includes("usage/summary")) return Response.json({ totalCost: amount });
        return Response.json({ credits: { monthlyCredits: 10 }, windowLimits: { fiveHour: { cap: 100, used: amount } } });
      }) as typeof fetch;
      const rows = await fetchProviderAccountQuotas(fixture.provider, false, { adapter: fixture.adapter, baseUrl: fixture.baseUrl, authMode: "oauth" });
      expect(rows.map(row => row.quota?.[fixture.field]).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([12, 68]);
      expect(seen.size).toBe(2);
      expect(getAccountSet(fixture.provider)!.activeAccountId).toBe(active);
      expect(rows.every(row => row.isCurrent?.())).toBe(true);
      expect(Object.keys(rows[0]!)).toEqual(["accountId", "quota"]);
      expect(JSON.stringify(rows)).not.toContain("quota-first");
      expect(JSON.stringify(rows)).not.toContain("identity");
      clearAccountQuotaCache(fixture.provider);
      expect(rows.every(row => row.isCurrent?.() === false)).toBe(true);
    });
  }

  test("same-id credential replacement invalidates a pending row and cannot poison the cache", async () => {
    const credential = { access: "cursor-before", refresh: "cursor-refresh", expires: Date.now() + 60 * 60_000, accountId: "same-user", email: "same@example.com" };
    await saveCredential("cursor", credential);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = (async () => {
      started(); await gate;
      return Response.json({ planUsage: { totalPercentUsed: 95 } });
    }) as typeof fetch;
    const pending = fetchProviderAccountQuotas("cursor");
    await entered;
    await saveCredential("cursor", { ...credential, access: "cursor-after" });
    release();
    const [row] = await pending;
    expect(row?.isCurrent?.()).toBe(false);
    expect(row?.quota).toBeNull();
    expect(getCachedProviderAccountQuota("cursor", row!.accountId)).toBeNull();
  });

  test("current provider report rejects an account switch during its explicit read", async () => {
    for (const accountId of ["first-user", "second-user"]) {
      await saveCredential("cursor", { access: accountId, refresh: `${accountId}-refresh`, expires: Date.now() + 60 * 60_000, accountId });
    }
    const set = getAccountSet("cursor")!;
    const next = set.accounts.find(row => row.id !== set.activeAccountId)!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = (async () => { started(); await gate; return Response.json({ planUsage: { totalPercentUsed: 90 } }); }) as typeof fetch;
    const config = { defaultProvider: "cursor", providers: { cursor: { adapter: "cursor", authMode: "oauth", baseUrl: "https://api2.cursor.sh" } } } as OcxConfig;
    const pending = fetchProviderQuotaReports(config, true);
    await entered;
    await setActiveAccount("cursor", next.id);
    release();
    expect((await pending).reports).toEqual([]);
  });

  test("invalid configured Kimi destination never resolves to the default quota host", async () => {
    await saveCredential("kimi", { access: "kimi-fixture", refresh: "refresh", expires: Date.now() + 60 * 60_000, accountId: "kimi-user" });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    const rows = await fetchProviderAccountQuotas("kimi", true, { adapter: "openai-chat", authMode: "oauth", baseUrl: "https://kimi.example.invalid/v1" });
    expect(rows[0]?.unavailable).toBe(true);
    expect(rows[0]?.quota).toBeNull();
    expect(calls).toBe(0);
  });

  test("OAuth roster uses four workers and force joins same-identity work", async () => {
    for (let i = 0; i < 6; i++) {
      await saveCredential("cursor", { access: `cursor-${i}`, refresh: `refresh-${i}`, expires: Date.now() + 60 * 60_000, accountId: `user-${i}` });
    }
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fourStarted!: () => void;
    const entered = new Promise<void>(resolve => { fourStarted = resolve; });
    let calls = 0;
    let active = 0;
    let peak = 0;
    globalThis.fetch = (async () => {
      calls++; active++; peak = Math.max(peak, active);
      if (calls === 4) fourStarted();
      await gate;
      active--;
      return Response.json({ planUsage: { totalPercentUsed: 20 } });
    }) as typeof fetch;
    const pending = fetchProviderAccountQuotas("cursor");
    await entered;
    expect(calls).toBe(4);
    release();
    expect(await pending).toHaveLength(6);
    expect(peak).toBe(4);
    await fetchProviderAccountQuotas("cursor");
    expect(calls).toBe(6);
    await fetchProviderAccountQuotas("cursor", true);
    expect(calls).toBe(12);
  });

  test("forced OAuth quota waits for an already-running same-identity probe", async () => {
    await saveCredential("cursor", { access: "cursor-only", refresh: "refresh", expires: Date.now() + 60 * 60_000, accountId: "only-user" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; started(); await gate; return Response.json({ planUsage: { totalPercentUsed: 20 } }); }) as typeof fetch;
    const ordinary = fetchProviderAccountQuotas("cursor");
    await entered;
    const force = fetchProviderAccountQuotas("cursor", true);
    release();
    const [a, b] = await Promise.all([ordinary, force]);
    expect(calls).toBe(1);
    expect(a[0]?.quota).toEqual(b[0]?.quota);
  });
});

describe("google-antigravity per-account quota (#1082)", () => {
  const { setAntigravityAccountQuotaTransportForTests } = require("../../src/providers/quota") as typeof import("../../src/providers/quota");
  const { getAccountSet } = require("../../src/oauth/store") as typeof import("../../src/oauth/store");
  const idFor = (email: string) => getAccountSet("google-antigravity")!.accounts.find(a => a.credential.email === email)!.id;

  function antigravityBody(gemRemaining: number, claRemaining: number): string {
    return JSON.stringify({
      models: {
        "gemini-3.7-flash": { displayName: "Gemini 3.7 Flash", quotaInfo: { remainingFraction: gemRemaining, resetTime: "2026-09-02T12:00:00Z" } },
        "claude-opus-5": { displayName: "Claude Opus 5", quotaInfo: { remainingFraction: claRemaining, resetTime: "2026-09-02T18:00:00Z" } },
      },
    });
  }

  function antigravitySummaryBody(gemRemaining: number, claRemaining: number): string {
    return JSON.stringify({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: gemRemaining, resetTime: "2026-09-09T12:00:00Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: gemRemaining, resetTime: "2026-09-02T12:00:00Z" },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: claRemaining, resetTime: "2026-09-09T18:00:00Z" },
            { bucketId: "3p-5h", window: "5h", remainingFraction: claRemaining, resetTime: "2026-09-02T18:00:00Z" },
          ],
        },
      ],
    });
  }

  afterEach(() => setAntigravityAccountQuotaTransportForTests(null));

  test("probes each account with its own bearer and project id on the fixed Google host using retrieveUserQuotaSummary", async () => {
    const expires = Date.now() + 60 * 60_000;
    await saveCredential("google-antigravity", { access: "agy-first", refresh: "r1", expires, projectId: "proj-first", accountId: "agy-a", email: "a@example.com" });
    await saveCredential("google-antigravity", { access: "agy-second", refresh: "r2", expires, projectId: "proj-second", accountId: "agy-b", email: "b@example.com" });
    globalThis.fetch = (async () => { throw new Error("plain fetch must not be used for account bearers"); }) as typeof fetch;

    const seen: Array<{ url: string; auth: string; project: string; address: string }> = [];
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
      pinnedPost: async (url, pinned, body, _signal, requestOptions) => {
        const auth = new Headers(requestOptions?.headers).get("authorization") ?? "";
        const project = String(JSON.parse(String(body)).project);
        seen.push({ url, auth, project, address: pinned.address });
        if (url.endsWith("retrieveUserQuotaSummary")) {
          return new Response(auth.endsWith("agy-first") ? antigravitySummaryBody(0.86, 0.38) : antigravitySummaryBody(0.97, 0.91), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(auth.endsWith("agy-first") ? antigravityBody(0.86, 0.38) : antigravityBody(0.97, 0.91), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    expect(supportsPerAccountQuota("google-antigravity")).toBe(true);
    const rows = await fetchProviderAccountQuotas("google-antigravity");
    const byId = Object.fromEntries(rows.map(row => [row.accountId, row]));
    const [idA, idB] = [idFor("a@example.com"), idFor("b@example.com")];
    expect(Object.keys(byId).sort()).toEqual([idA, idB].sort());
    const windows = (id: string) => byId[id]!.quota!.customWindows!.map(w => `${w.label}=${w.percent}`);
    expect(windows(idA)).toEqual(["Gem=14", "Gem (Weekly)=14", "Cla=62", "Cla (Weekly)=62"]);
    expect(windows(idB)).toEqual(["Gem=3", "Gem (Weekly)=3", "Cla=9", "Cla (Weekly)=9"]);
    expect(byId[idA]!.quota!.customWindows![0]!.resetAt).toBeDefined();
    expect(seen.map(s => `${s.auth}|${s.project}`).sort()).toEqual(["Bearer agy-first|proj-first", "Bearer agy-second|proj-second"]);
    for (const s of seen) {
      expect(s.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
      expect(s.address).toBe("142.250.0.1");
    }
  });

  test("falls back to fetchAvailableModels when retrieveUserQuotaSummary returns 404", async () => {
    const expires = Date.now() + 60 * 60_000;
    await saveCredential("google-antigravity", { access: "agy-first", refresh: "r1", expires, projectId: "proj-first", accountId: "agy-a", email: "a@example.com" });
    await saveCredential("google-antigravity", { access: "agy-second", refresh: "r2", expires, projectId: "proj-second", accountId: "agy-b", email: "b@example.com" });
    globalThis.fetch = (async () => { throw new Error("plain fetch must not be used for account bearers"); }) as typeof fetch;

    const seen: Array<{ url: string; auth: string; project: string; address: string }> = [];
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
      pinnedPost: async (url, pinned, body, _signal, requestOptions) => {
        const auth = new Headers(requestOptions?.headers).get("authorization") ?? "";
        const project = String(JSON.parse(String(body)).project);
        seen.push({ url, auth, project, address: pinned.address });
        if (url.endsWith("retrieveUserQuotaSummary")) {
          return new Response(null, { status: 404 });
        }
        return new Response(auth.endsWith("agy-first") ? antigravityBody(0.86, 0.38) : antigravityBody(0.97, 0.91), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const rows = await fetchProviderAccountQuotas("google-antigravity");
    const byId = Object.fromEntries(rows.map(row => [row.accountId, row]));
    const [idA, idB] = [idFor("a@example.com"), idFor("b@example.com")];
    const windows = (id: string) => byId[id]!.quota!.customWindows!.map(w => `${w.label}=${w.percent}`);
    expect(windows(idA)).toEqual(["Gem=14", "Cla=62"]);
    expect(windows(idB)).toEqual(["Gem=3", "Cla=9"]);
    expect(byId[idA]!.quota!.customWindows![0]!.resetAt).toBeDefined();
  });

  test("a rejected destination never receives a bearer; the row is unavailable, not 0%", async () => {
    const expires = Date.now() + 60 * 60_000;
    await saveCredential("google-antigravity", { access: "agy-first", refresh: "r1", expires, projectId: "proj-first", accountId: "agy-a", email: "a@example.com" });
    let posted = 0;
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => { throw new Error("provider URL resolves to private space"); },
      pinnedPost: async () => { posted += 1; return new Response("{}", { status: 200 }); },
    });
    const rows = await fetchProviderAccountQuotas("google-antigravity");
    expect(posted).toBe(0);
    expect(rows).toEqual([{ accountId: idFor("a@example.com"), quota: null, unavailable: true }]);
  });

  test("a redirecting upstream yields unavailable and the credential-less account is skipped without a request", async () => {
    const expires = Date.now() + 60 * 60_000;
    await saveCredential("google-antigravity", { access: "agy-first", refresh: "r1", expires, projectId: "proj-first", accountId: "agy-a", email: "a@example.com" });
    await saveCredential("google-antigravity", { access: "agy-noproj", refresh: "r2", expires, accountId: "agy-np", email: "np@example.com" });
    const projects: string[] = [];
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
      pinnedPost: async (_url, _pinned, body) => {
        projects.push(String(JSON.parse(String(body)).project));
        return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } });
      },
    });
    const rows = await fetchProviderAccountQuotas("google-antigravity");
    expect(projects).toEqual(["proj-first"]);
    for (const row of rows) {
      expect(row.unavailable).toBe(true);
      expect(row.quota).toBeNull();
    }
  });
});
