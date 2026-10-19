import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential } from "../../../src/oauth/store";
import {
  clearAccountQuotaCache,
  clearProviderQuotaCache,
  fetchProviderAccountQuotas,
  getCachedProviderAccountQuota,
  resetProviderQuotaReconcileStateForTests,
} from "../../../src/providers/quota";
import type { QuotaFailureCode } from "../../../src/providers/quota-types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const previousHome = process.env.OPENCODEX_HOME;
const creditsUrl = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const monthlyUrl = "https://cli-chat-proxy.grok.com/v1/billing";
const provider = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" } as const;
const privateMarker = "private-upstream-details-not-for-diagnostics";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-xai-quota-refresh-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
  clearProviderQuotaCache();
  globalThis.fetch = (async () => { throw new Error("Unmocked request forbidden"); }) as typeof fetch;
});

afterEach(() => {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  // Cache clearing may persist state, so it must happen inside the synthetic home.
  clearAccountQuotaCache();
  clearProviderQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function seed(access = "quota-fixture-before") {
  await saveCredential("xai", {
    access,
    refresh: "quota-fixture-refresh",
    expires: Date.now() + 60 * 60_000,
    accountId: "quota-fixture-upstream-user",
  });
  return getAccountSet("xai")!.activeAccountId;
}

function unusableMonthly() {
  return Response.json({ config: { monthlyLimit: { val: 0 }, used: { val: 0 }, onDemandCap: { val: 0 } } });
}

function weekly(percent: number) {
  return Response.json({ config: {
    creditUsagePercent: percent,
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: new Date(Date.now() + 7 * 86_400_000).toISOString() },
  } });
}

function transport(replies: Array<Response | Error>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect([creditsUrl, monthlyUrl]).toContain(url);
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.redirect).toBe("error");
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected additional metadata request");
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return calls;
}

async function refresh() {
  const rows = await fetchProviderAccountQuotas("xai", true, provider);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function expectPrivateDataAbsent(value: unknown) {
  const json = JSON.stringify(value);
  expect(json).not.toContain(privateMarker);
  expect(json).not.toContain("quota-fixture-before");
  expect(json).not.toContain("quota-fixture-refresh");
  expect(json).not.toContain("quota-fixture-upstream-user");
  expect(json).not.toContain("identity");
}

describe("xAI account quota refresh failure evidence", () => {
  const failures: Array<{ name: string; response: () => Response | Error; code: QuotaFailureCode }> = [
    { name: "weekly 503 with unusable monthly quota", response: () => Response.json({ error: privateMarker }, { status: 503 }), code: "upstream_error" },
    { name: "weekly 401", response: () => Response.json({ error: privateMarker }, { status: 401 }), code: "access_denied" },
    { name: "weekly 403", response: () => Response.json({ error: privateMarker }, { status: 403 }), code: "access_denied" },
    { name: "weekly 429", response: () => Response.json({ error: privateMarker }, { status: 429 }), code: "rate_limited" },
    { name: "weekly timeout", response: () => new DOMException(privateMarker, "TimeoutError"), code: "timeout" },
    { name: "malformed weekly JSON", response: () => new Response(privateMarker, { status: 200 }), code: "response_unusable" },
    { name: "unusable weekly percentage", response: () => Response.json({ config: { creditUsagePercent: "not-a-number", currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } }), code: "response_unusable" },
  ];

  for (const failure of failures) {
    test(`${failure.name} is unavailable with a closed reason, never zero usage`, async () => {
      const accountId = await seed();
      const calls = transport([failure.response(), unusableMonthly()]);
      const row = await refresh();
      expect(calls).toEqual([creditsUrl, monthlyUrl]);
      expect(row.accountId).toBe(accountId);
      expect(row.quota).toBeNull();
      expect(row.unavailable).toBe(true);
      expect(row.quotaFailure).toBe(failure.code);
      expect(row.quotaFailureIsCurrent?.()).toBe(true);
      expect(row.isCurrent?.()).toBe(true);
      expect(getAccountSet("xai")!.activeAccountId).toBe(accountId);
      expect(getAccountSet("xai")!.accounts[0]!.needsReauth).not.toBe(true);
      expectPrivateDataAbsent(row);
    });
  }

  test("a fresh weekly result clears the earlier failure without requesting monthly quota", async () => {
    await seed();
    transport([new Response(null, { status: 503 }), unusableMonthly()]);
    expect((await refresh()).quotaFailure).toBe("upstream_error");
    const calls = transport([weekly(12.5)]);
    const row = await refresh();
    expect(calls).toEqual([creditsUrl]);
    expect(row.quota?.weeklyPercent).toBe(12.5);
    expect(row.quota?.monthlyPercent).toBeUndefined();
    expect(row.unavailable).toBeUndefined();
    expect(row.quotaFailure).toBeUndefined();
    expectPrivateDataAbsent(row);
  });

  test("a valid legacy fallback clears the failed weekly diagnosis without inventing a weekly value", async () => {
    await seed();
    const calls = transport([
      new Response(null, { status: 503 }),
      Response.json({ config: { monthlyLimit: { val: 1000 }, used: { val: 250 } } }),
    ]);
    const row = await refresh();
    expect(calls).toEqual([creditsUrl, monthlyUrl]);
    expect(row.quota?.monthlyPercent).toBe(25);
    expect(row.quota?.weeklyPercent).toBeUndefined();
    expect(row.unavailable).toBeUndefined();
    expect(row.quotaFailure).toBeUndefined();
  });
  test("a failed probe preserves the last-good timestamp only inside its age bound", async () => {
    let now = originalNow();
    Date.now = () => now;
    await seed();
    transport([weekly(22)]);
    const first = await refresh();
    const observedAt = first.quota!.updatedAt;
    now += 60_000;
    transport([new Response(null, { status: 503 }), unusableMonthly()]);
    const preserved = await refresh();
    expect(preserved.quota?.weeklyPercent).toBe(22);
    expect(preserved.quota?.updatedAt).toBe(observedAt);
    expect(preserved.unavailable).toBe(true);
    expect(preserved.quotaFailure).toBe("upstream_error");
    now = observedAt + 31 * 60_000;
    transport([new Response(null, { status: 503 }), unusableMonthly()]);
    const expired = await refresh();
    expect(expired.quota).toBeNull();
    expect(expired.unavailable).toBe(true);
    expect(expired.quotaFailure).toBe("upstream_error");
  });

  test("credential replacement during a probe cannot publish its old-generation diagnosis", async () => {
    const accountId = await seed();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === creditsUrl) {
        entered();
        await gate;
        return new Response(null, { status: 503 });
      }
      expect(url).toBe(monthlyUrl);
      return unusableMonthly();
    }) as typeof fetch;
    const pending = refresh();
    await started;
    await seed("quota-fixture-replacement");
    expect(getAccountSet("xai")!.activeAccountId).toBe(accountId);
    release();
    const stale = await pending;
    expect(calls).toEqual([creditsUrl, monthlyUrl]);
    expect(stale.quota).toBeNull();
    expect(stale.isCurrent?.()).toBe(false);
    expect(stale.quotaFailure).toBeUndefined();
    expect(getCachedProviderAccountQuota("xai", accountId)).toBeNull();
    transport([weekly(8)]);
    const current = await refresh();
    expect(current.quota?.weeklyPercent).toBe(8);
    expect(current.quotaFailure).toBeUndefined();
    expect(current.isCurrent?.()).toBe(true);
  });
});