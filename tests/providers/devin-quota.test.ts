import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeMessage, encodeString, encodeVarintField, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { saveCredential } from "../../src/oauth/store";
import { clearProviderQuotaCache, fetchProviderQuotaReports, QUOTA_RESPONSE_MAX_BYTES } from "../../src/providers/quota";
import { decodeDevinUserStatus, devinQuotaFromStatus, fetchDevinQuota } from "../../src/providers/quota/devin";
import { AUTHORITATIVE_EMPTY_QUOTA, TERMINAL_QUOTA_FAILURE } from "../../src/providers/quota/report-cache";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const KEY = "devin-session-token$synthetic.fixture.key";
// Far enough ahead that the fetch-path tests, which use the real clock, see live windows.
const PLAN_END = 4_000_000_000;
const DAILY_RESET = 3_990_000_000;
const WEEKLY_RESET = 3_995_000_000;

/** Signed ints ride the wire as 64-bit two's complement, exactly like the server sends -1. */
const int = (num: number, value: number) => encodeVarintField(num, BigInt.asUintN(64, BigInt(value)));

function planInfo(p: { tier: number; name: string; billing: number; hideDaily?: boolean; hideWeekly?: boolean; monthlyFlow?: number }): Buffer {
  return Buffer.concat([
    int(1, p.tier),
    encodeString(2, p.name),
    ...(p.monthlyFlow ? [int(13, p.monthlyFlow)] : []),
    int(35, p.billing),
    ...(p.hideDaily ? [int(36, 1)] : []),
    ...(p.hideWeekly ? [int(37, 1)] : []),
  ]);
}

function userStatusResponse(plan: Buffer, status: Record<number, number>, dated = true): Buffer {
  const planStatus = Buffer.concat([
    encodeMessage(1, plan),
    encodeMessage(3, int(1, PLAN_END)),
    ...Object.entries(status).map(([num, value]) => int(Number(num), value)),
    ...(dated ? [int(17, DAILY_RESET), int(18, WEEKLY_RESET)] : []),
  ]);
  const user = Buffer.concat([encodeString(3, "Fixture User"), int(10, 1), encodeMessage(13, planStatus)]);
  return Buffer.concat([encodeMessage(1, user), encodeMessage(2, plan)]);
}

/** Quota-billed plan, shaped like the live Max account: daily hidden, prompt credits unlimited. */
const quotaPlan = () => userStatusResponse(
  planInfo({ tier: 17, name: "Max", billing: 2, hideDaily: true }),
  { 8: -1, 14: 100, 15: 84, 16: -7_937_410 },
);

/** Credit-billed plan: the percent fields sit at their zero default and carry no reset date. */
const creditPlan = (status: Record<number, number>) => userStatusResponse(
  planInfo({ tier: 16, name: "Pro", billing: 1 }),
  status,
  false,
);

const creditPlanWithFlow = (monthlyFlow: number, status: Record<number, number>) => userStatusResponse(
  planInfo({ tier: 16, name: "Pro", billing: 1, monthlyFlow }),
  status,
  false,
);

describe("Devin GetUserStatus decode and mapping", () => {
  test("quota-billed plan publishes the dated weekly window and nothing hidden or unlimited", () => {
    const status = decodeDevinUserStatus(quotaPlan());
    expect(status?.plan).toMatchObject({ teamsTier: 17, planName: "Max", billingStrategy: 2, hideDailyQuota: true });
    expect(status?.availablePromptCredits).toBe(-1);
    expect(status?.overageBalanceMicros).toBe(-7_937_410);
    expect(status?.dailyResetMs).toBe(DAILY_RESET * 1000);
    expect(devinQuotaFromStatus(status!, 1)).toEqual({
      updatedAt: 1,
      weeklyPercent: 16,
      weeklyResetAt: WEEKLY_RESET * 1000,
    });
  });

  test("an unhidden dated daily window becomes a custom window", () => {
    const buf = userStatusResponse(planInfo({ tier: 17, name: "Max", billing: 2 }), { 8: -1, 14: 40, 15: 90 });
    expect(devinQuotaFromStatus(decodeDevinUserStatus(buf)!, 1).customWindows).toEqual([
      { label: "Daily", percent: 60, resetAt: DAILY_RESET * 1000 },
    ]);
  });

  test("credit-billed plan omits undated percent windows instead of reporting them exhausted", () => {
    const quota = devinQuotaFromStatus(decodeDevinUserStatus(creditPlan({ 6: 300, 8: 200 }))!, 1);
    expect(quota).toEqual({ updatedAt: 1, monthlyPercent: 60, monthlyResetAt: PLAN_END * 1000 });
  });

  test("flex credits keep an account with spent prompt credits servable", () => {
    const quota = devinQuotaFromStatus(decodeDevinUserStatus(creditPlan({ 6: 500, 8: 0, 4: 100 }))!, 1);
    expect(quota.monthlyPercent).toBeCloseTo((500 / 600) * 100);
    const spent = devinQuotaFromStatus(decodeDevinUserStatus(creditPlan({ 6: 500, 8: 0 }))!, 1);
    expect(spent.monthlyPercent).toBe(100);
  });

  test("a quota-billed plan with a zero credit balance is not credit-exhausted", () => {
    const buf = userStatusResponse(planInfo({ tier: 17, name: "Max", billing: 2 }), { 6: 10, 8: 0, 14: 100, 15: 90 });
    const quota = devinQuotaFromStatus(decodeDevinUserStatus(buf)!, 1);
    expect(quota.weeklyPercent).toBe(10);
    expect(quota.monthlyPercent).toBeUndefined();
  });

  test("an unknown billing strategy uses credits only when no window is dated", () => {
    const undated = userStatusResponse(planInfo({ tier: 16, name: "Pro", billing: 0 }), { 6: 50, 8: 50 }, false);
    expect(devinQuotaFromStatus(decodeDevinUserStatus(undated)!, 1).monthlyPercent).toBe(50);
    const dated = userStatusResponse(planInfo({ tier: 16, name: "Pro", billing: 0 }), { 6: 50, 8: 50, 14: 100, 15: 100 });
    expect(devinQuotaFromStatus(decodeDevinUserStatus(dated)!, 1).monthlyPercent).toBeUndefined();
  });

  test("a window whose reset has already passed is dropped rather than read as spent", () => {
    const buf = userStatusResponse(planInfo({ tier: 17, name: "Max", billing: 2 }), { 8: -1, 14: 0, 15: 0 });
    const status = decodeDevinUserStatus(buf)!;
    expect(devinQuotaFromStatus(status, WEEKLY_RESET * 1000 + 1)).toEqual({ updatedAt: WEEKLY_RESET * 1000 + 1 });
    expect(devinQuotaFromStatus(status, DAILY_RESET * 1000 + 1)).toEqual({
      updatedAt: DAILY_RESET * 1000 + 1,
      weeklyPercent: 100,
      weeklyResetAt: WEEKLY_RESET * 1000,
    });
  });

  test("hide_weekly_quota (#37) suppresses the weekly window", () => {
    const buf = userStatusResponse(planInfo({ tier: 17, name: "Max", billing: 2, hideWeekly: true }), { 8: -1, 14: 70, 15: 10 });
    expect(devinQuotaFromStatus(decodeDevinUserStatus(buf)!, 1)).toEqual({
      updatedAt: 1,
      customWindows: [{ label: "Daily", percent: 30, resetAt: DAILY_RESET * 1000 }],
    });
  });

  test("flow credits read used #5 against available #9 only when the plan grants them (#13)", () => {
    const granted = creditPlanWithFlow(100, { 5: 30, 9: 70 });
    expect(devinQuotaFromStatus(decodeDevinUserStatus(granted)!, 1).customWindows).toEqual([
      { label: "Flow credits", percent: 30, resetAt: PLAN_END * 1000 },
    ]);
    const ungranted = creditPlanWithFlow(0, { 5: 30, 9: 70 });
    expect(devinQuotaFromStatus(decodeDevinUserStatus(ungranted)!, 1).customWindows).toBeUndefined();
  });

  test("a response without PlanStatus is not a usable status", () => {
    expect(decodeDevinUserStatus(encodeMessage(1, encodeString(3, "Fixture User")))).toBeNull();
    expect(decodeDevinUserStatus(Buffer.alloc(0))).toBeNull();
  });
});

describe("fetchDevinQuota transport", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("sends a unary proto POST to the allowlisted host with redirects refused", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), init };
      return new Response(new Uint8Array(quotaPlan()), { status: 200 });
    }) as typeof fetch;
    const result = await fetchDevinQuota("devin", KEY, "https://server.codeium.com");
    expect(typeof result === "object" && result?.quota.weeklyPercent).toBe(16);
    expect(seen?.url).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    expect(seen?.init?.redirect).toBe("error");
    expect((seen?.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/proto");
    // GetUserStatusRequest #1 carries the Metadata, whose #3 is the api_key.
    const body = Buffer.from(seen?.init?.body as Uint8Array);
    const metadata = [...iterFields(body)].find(f => f.num === 1)?.value as Buffer;
    expect(([...iterFields(metadata)].find(f => f.num === 3)?.value as Buffer).toString()).toBe(KEY);
  });

  test("401/403/404 are terminal; 408/409/429/499, 5xx and network faults keep the last-good row", async () => {
    for (const status of [401, 403, 404]) {
      globalThis.fetch = (async () => new Response("unauthenticated: " + KEY, { status })) as unknown as typeof fetch;
      expect(await fetchDevinQuota("devin", KEY, undefined)).toBe(TERMINAL_QUOTA_FAILURE);
    }
    for (const status of [408, 409, 429, 499, 503]) {
      globalThis.fetch = (async () => new Response("", { status })) as unknown as typeof fetch;
      expect(await fetchDevinQuota("devin", KEY, undefined)).toBeNull();
    }
    globalThis.fetch = (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    expect(await fetchDevinQuota("devin", KEY, undefined)).toBeNull();
  });

  test("a truncated or oversized body keeps the last-good row instead of throwing", async () => {
    // Tag for field 1 varint, then a continuation byte with nothing after it.
    globalThis.fetch = (async () => new Response(new Uint8Array([0x08, 0x80]), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchDevinQuota("devin", KEY, undefined)).toBeNull();
    globalThis.fetch = (async () => new Response(new Uint8Array(QUOTA_RESPONSE_MAX_BYTES + 1), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchDevinQuota("devin", KEY, undefined)).toBeNull();
  });

  test("a complete field followed by a truncated one is malformed, not authoritative-empty", async () => {
    // An empty UserStatus, then field 2 declaring 127 bytes with none present.
    globalThis.fetch = (async () => new Response(new Uint8Array([0x0a, 0x02, 0x6a, 0x00, 0x12, 0x7f]), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchDevinQuota("devin", KEY, undefined)).toBeNull();
  });

  test("a decoded status with nothing measurable is authoritative-empty", async () => {
    const unlimited = userStatusResponse(planInfo({ tier: 17, name: "Max", billing: 2 }), { 8: -1 }, false);
    globalThis.fetch = (async () => new Response(new Uint8Array(unlimited), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchDevinQuota("devin", KEY, undefined)).toBe(AUTHORITATIVE_EMPTY_QUOTA);
  });

  test("never sends the key to a host outside the allowlist", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
    expect(await fetchDevinQuota("devin", KEY, "https://attacker.example")).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("Devin provider quota through the aggregator", () => {
  const originalFetch = globalThis.fetch;
  const previousHome = process.env.OPENCODEX_HOME;
  let home: string;
  const config = { defaultProvider: "devin", providers: { devin: { adapter: "devin", authMode: "oauth", baseUrl: "https://server.codeium.com" } } } as unknown as OcxConfig;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-devin-quota-"));
    process.env.OPENCODEX_HOME = home;
    clearProviderQuotaCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearProviderQuotaCache();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  test("the active account's quota is published without leaking the key", async () => {
    await saveCredential("devin", { access: KEY, refresh: KEY, expires: Number.MAX_SAFE_INTEGER, apiBaseUrl: "https://server.codeium.com" });
    globalThis.fetch = (async () => new Response(new Uint8Array(quotaPlan()), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchProviderQuotaReports(config, true);
    expect(result.reports[0]).toMatchObject({ provider: "devin", source: "devin:user-status", quota: { weeklyPercent: 16 } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  test("a rejected key publishes no row", async () => {
    await saveCredential("devin", { access: KEY, refresh: KEY, expires: Number.MAX_SAFE_INTEGER, apiBaseUrl: "https://server.codeium.com" });
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const result = await fetchProviderQuotaReports(config, true);
    expect(result.reports.filter(r => r.provider === "devin")).toEqual([]);
  });
});
