import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";
import {
  clearAccountQuotaCache,
  clearProviderQuotaCache,
  fetchProviderAccountQuotas,
  fetchProviderQuotaReports,
  getCachedProviderAccountQuota,
  reconcileProviderAccountQuotaRows,
  resetProviderQuotaReconcileStateForTests,
  supportsPerAccountQuota,
} from "../src/providers/quota";

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
  rmSync(opencodexHome, { recursive: true, force: true });
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
    const { getAccountSet, setActiveAccount } = await import("../src/oauth/store");
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
    expect(supportsPerAccountQuota("kiro")).toBe(false);
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    expect(await fetchProviderAccountQuotas("kiro")).toEqual([]);
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
    const { getAccountSet, setActiveAccount } = await import("../src/oauth/store");
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
    const { getAccountSet, setActiveAccount } = await import("../src/oauth/store");
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
    const { getAccountSet, setActiveAccount } = await import("../src/oauth/store");
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
    const { getAccountSet, setActiveAccount } = await import("../src/oauth/store");
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

  test("reports Google Antigravity per-account Gem/Cla quota keyed by account credentials (#1082)", async () => {
    const { saveCredential } = await import("../src/oauth/store");
    await saveCredential("google-antigravity", {
      access: "token-agy-1",
      refresh: "refresh-agy-1",
      expires: Date.now() + 3600_000,
      projectId: "project-1",
      accountId: "acct-agy-1",
      email: "agy1@example.com",
    });
    await saveCredential("google-antigravity", {
      access: "token-agy-2",
      refresh: "refresh-agy-2",
      expires: Date.now() + 3600_000,
      projectId: "project-2",
      accountId: "acct-agy-2",
      email: "agy2@example.com",
    });

    const seenRequests: Array<{ project: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/v1internal:fetchAvailableModels");
      const body = JSON.parse(String(init?.body)) as { project?: string };
      seenRequests.push({
        project: body.project ?? "",
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (body.project === "project-1") {
        return new Response(JSON.stringify({
          models: {
            "gemini-3.7-flash": {
              quotaInfo: { remainingFraction: 0.64, resetTime: "2026-07-05T14:00:00Z" },
            },
            "claude-sonnet-4-6": {
              quotaInfo: { remainingFraction: 0.21, resetTime: "2026-07-05T15:00:00Z" },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        models: {
          "gemini-3.7-flash": {
            quotaInfo: { remainingFraction: 0.90, resetTime: "2026-07-05T14:00:00Z" },
          },
          "claude-sonnet-4-6": {
            quotaInfo: { remainingFraction: 0.85, resetTime: "2026-07-05T15:00:00Z" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("google-antigravity");
    expect(rows.length).toBe(2);
    expect(seenRequests).toEqual(expect.arrayContaining([
      { project: "project-1", authorization: "Bearer token-agy-1" },
      { project: "project-2", authorization: "Bearer token-agy-2" },
    ]));

    const byProject = Object.fromEntries(rows.map(r => [
      r.quota?.customWindows?.find(w => w.label === "Gem")?.percent,
      r.quota?.customWindows?.find(w => w.label === "Cla")?.percent,
    ]));
    // 1 - 0.64 = 36% used, 1 - 0.21 = 79% used for project 1
    // 1 - 0.90 = 10% used, 1 - 0.85 = 15% used for project 2
    expect(byProject[36]).toBe(79);
    expect(byProject[10]).toBe(15);
  });

  test("uses the configured provider baseUrl for Antigravity account quota probes", async () => {
    const { saveCredential } = await import("../src/oauth/store");
    await saveCredential("google-antigravity", {
      access: "token-agy-1",
      refresh: "refresh-agy-1",
      expires: Date.now() + 3600_000,
      projectId: "project-1",
      accountId: "acct-agy-1",
      email: "agy1@example.com",
    });

    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      return new Response(JSON.stringify({
        models: {
          "gemini-3.7-flash": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-07-05T14:00:00Z" } },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("google-antigravity", true, "https://custom-antigravity.example.com");
    expect(rows.length).toBe(1);
    expect(seenUrls).toEqual(["https://custom-antigravity.example.com/v1internal:fetchAvailableModels"]);
  });

  test("skips Antigravity accounts without projectId instead of throwing or flagging unavailable", async () => {
    const { saveCredential } = await import("../src/oauth/store");
    await saveCredential("google-antigravity", {
      access: "token-with-project",
      refresh: "refresh-with-project",
      expires: Date.now() + 3600_000,
      projectId: "project-1",
      accountId: "acct-agy-1",
      email: "agy1@example.com",
    });
    await saveCredential("google-antigravity", {
      access: "token-no-project",
      refresh: "refresh-no-project",
      expires: Date.now() + 3600_000,
      accountId: "acct-agy-2",
      email: "agy2@example.com",
    });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        models: {
          "gemini-3.7-flash": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-07-05T14:00:00Z" } },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const rows = await fetchProviderAccountQuotas("google-antigravity", true);
    expect(rows.length).toBe(2);
    expect(fetchCalls).toBe(1);
    const nullQuotaRows = rows.filter(r => r.quota === null);
    expect(nullQuotaRows.length).toBe(1);
    expect(nullQuotaRows[0]!.unavailable).toBeUndefined();
    const quotaRows = rows.filter(r => r.quota !== null);
    expect(quotaRows.length).toBe(1);
    expect(quotaRows[0]!.quota?.customWindows?.length).toBeGreaterThan(0);
  });

  test("negative-caches Antigravity upstream 404 so probes are not repeated within the TTL", async () => {
    const { saveCredential } = await import("../src/oauth/store");
    await saveCredential("google-antigravity", {
      access: "token-agy-1",
      refresh: "refresh-agy-1",
      expires: Date.now() + 3600_000,
      projectId: "project-1",
      accountId: "acct-agy-1",
      email: "agy1@example.com",
    });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("not found", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const first = await fetchProviderAccountQuotas("google-antigravity", true);
    expect(first[0]!.unavailable).toBe(true);
    expect(fetchCalls).toBe(1);

    const second = await fetchProviderAccountQuotas("google-antigravity", false);
    expect(fetchCalls).toBe(1);
  });

  test("clamps invalid or out-of-range remainingFraction values safely", async () => {
    const { fetchAntigravityUsageQuota } = await import("../src/providers/quota");
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        models: {
          "gemini-3.7-flash": { quotaInfo: { remainingFraction: 1.5, resetTime: "2026-07-05T14:00:00Z" } },
          "claude-sonnet-4-6": { quotaInfo: { remainingFraction: -0.2, resetTime: "2026-07-05T15:00:00Z" } },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const quota = await fetchAntigravityUsageQuota("token", "project-1");
    expect(quota).not.toBeNull();
    const gem = quota?.customWindows?.find(w => w.label === "Gem");
    const cla = quota?.customWindows?.find(w => w.label === "Cla");
    expect(gem?.percent).toBe(0);
    expect(cla?.percent).toBe(100);
  });

  test("gracefully handles non-JSON upstream 502 error responses without uncaught exceptions", async () => {
    const { fetchAntigravityUsageQuota } = await import("../src/providers/quota");
    globalThis.fetch = (async () => {
      return new Response("<html><head><title>502 Bad Gateway</title></head></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    const quota = await fetchAntigravityUsageQuota("token", "project-1");
    expect(quota).toBeNull();
  });
  test("destination-bound cache isolates quota across baseUrl changes and prevents cross-endpoint contamination", async () => {
    const { saveCredential } = await import("../src/oauth/store");
    await saveCredential("google-antigravity", {
      access: "token-agy-1",
      refresh: "refresh-agy-1",
      expires: Date.now() + 3600_000,
      projectId: "project-1",
      accountId: "acct-agy-1",
      email: "agy1@example.com",
    });

    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      if (requestedUrl.includes("dest-1.example.com")) {
        return new Response(JSON.stringify({
          models: {
            "gemini-3.7-flash": { quotaInfo: { remainingFraction: 0.9, resetTime: "2026-07-05T14:00:00Z" } },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        models: {
          "gemini-3.7-flash": { quotaInfo: { remainingFraction: 0.2, resetTime: "2026-07-05T14:00:00Z" } },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    // 1. Probe dest-1 (10% used)
    const rows1 = await fetchProviderAccountQuotas("google-antigravity", true, "https://dest-1.example.com");
    expect(rows1[0]!.quota?.customWindows?.find(w => w.label === "Gem")?.percent).toBe(10);

    // 2. Non-forced probe to dest-2 must NOT return dest-1 cached value (80% used)
    const rows2 = await fetchProviderAccountQuotas("google-antigravity", false, "https://dest-2.example.com");
    expect(rows2[0]!.quota?.customWindows?.find(w => w.label === "Gem")?.percent).toBe(80);
  });

  test("rejects invalid destination policy targets before sending bearer tokens", async () => {
    const { saveCredential } = await import("../src/oauth/store");
    await saveCredential("google-antigravity", {
      access: "token-agy-1",
      refresh: "refresh-agy-1",
      expires: Date.now() + 3600_000,
      projectId: "project-1",
      accountId: "acct-agy-1",
      email: "agy1@example.com",
    });

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("ok");
    }) as typeof fetch;

    // Probe blocked metadata endpoint 169.254.169.254
    const rows = await fetchProviderAccountQuotas("google-antigravity", true, "http://169.254.169.254");
    expect(rows[0]!.unavailable).toBe(true);
    expect(fetchCalled).toBe(false);
  });

  test("destination-bound in-flight promise and stale writer rejection on baseUrl change", async () => {
    const { saveCredential } = await import("../src/oauth/store");
    await saveCredential("google-antigravity", {
      access: "token-agy-1",
      refresh: "refresh-agy-1",
      expires: Date.now() + 3600_000,
      projectId: "project-1",
      accountId: "acct-agy-1",
      email: "agy1@example.com",
    });

    let resolveDest1: (value: Response) => void;
    const dest1Promise = new Promise<Response>(resolve => {
      resolveDest1 = resolve;
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("dest-1.example.com")) {
        return dest1Promise;
      }
      return new Response(JSON.stringify({
        models: {
          "gemini-3.7-flash": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-07-05T14:00:00Z" } },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    // Start probe to dest-1 (in flight)
    const probe1 = fetchProviderAccountQuotas("google-antigravity", true, "https://dest-1.example.com");

    // Immediately start probe to dest-2 (must not join probe 1)
    const probe2 = fetchProviderAccountQuotas("google-antigravity", true, "https://dest-2.example.com");
    const rows2 = await probe2;
    expect(rows2[0]!.quota?.customWindows?.find(w => w.label === "Gem")?.percent).toBe(50);

    // Resolve dest-1
    resolveDest1!(new Response(JSON.stringify({
      models: {
        "gemini-3.7-flash": { quotaInfo: { remainingFraction: 0.9, resetTime: "2026-07-05T14:00:00Z" } },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const rows1 = await probe1;
    expect(rows1[0]!.quota?.customWindows?.find(w => w.label === "Gem")?.percent).toBe(10);
  });

  test("fail-closed redirect handling: rejected destination or redirect yields null without following", async () => {
    const { fetchAntigravityUsageQuota } = await import("../src/providers/quota");

    let redirectTargetCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("redirect-sink.example.com")) {
        redirectTargetCalled = true;
        return new Response("sink", { status: 200 });
      }
      // If fetch honors redirect: error, fetch will throw or fail on 302
      if (init?.redirect === "error") {
        throw new TypeError("Failed to fetch: redirect");
      }
      return new Response("", { status: 302, headers: { Location: "https://redirect-sink.example.com" } });
    }) as typeof fetch;

    const quota = await fetchAntigravityUsageQuota("token", "project-1", "https://redirecting.example.com");
    expect(quota).toBeNull();
    expect(redirectTargetCalled).toBe(false);
  });

});
