import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

  test("expired dated windows do not make an unknown strategy credit-billed", () => {
    const dated = userStatusResponse(planInfo({ tier: 16, name: "Pro", billing: 0 }), { 6: 0, 8: 0, 14: 0, 15: 0 });
    const now = WEEKLY_RESET * 1000 + 1;
    expect(devinQuotaFromStatus(decodeDevinUserStatus(dated)!, now)).toEqual({ updatedAt: now });
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

  test("flow credits decode from #5/#9/#13 but never gate the account", () => {
    const status = decodeDevinUserStatus(creditPlanWithFlow(100, { 5: 30, 9: 70 }))!;
    expect(status.usedFlowCredits).toBe(30);
    expect(status.availableFlowCredits).toBe(70);
    expect(status.plan.monthlyFlowCredits).toBe(100);
    const exhausted = decodeDevinUserStatus(creditPlanWithFlow(100, { 5: 100, 9: 0, 6: 10, 8: 90 }))!;
    const quota = devinQuotaFromStatus(exhausted, 1);
    expect(quota.customWindows).toBeUndefined();
    expect(quota.monthlyPercent).toBe(10);
  });

  test("a credit-billed plan with nothing used and nothing left reads exhausted, not unmeasured", () => {
    expect(devinQuotaFromStatus(decodeDevinUserStatus(creditPlan({ 6: 0, 8: 0 }))!, 1).monthlyPercent).toBe(100);
  });

  test.each([6, 7])("a negative used credit field %i cannot mark a zero-available pool exhausted", usedField => {
    const status = decodeDevinUserStatus(creditPlan({ [usedField]: -1, 8: 0, 4: 0 }))!;
    expect(devinQuotaFromStatus(status, 1)).toEqual({ updatedAt: 1 });
  });

  test("missing credit balance fields do not publish an exhausted monthly window", () => {
    expect(devinQuotaFromStatus(decodeDevinUserStatus(creditPlan({}))!, 1).monthlyPercent).toBeUndefined();
  });

  test("proto3 zero omission: a used balance alone still reads as an exhausted pool", () => {
    // available_prompt = 0 is omitted on the wire; the used count is the evidence.
    expect(devinQuotaFromStatus(decodeDevinUserStatus(creditPlan({ 6: 50 }))!, 1).monthlyPercent).toBe(100);
    expect(devinQuotaFromStatus(decodeDevinUserStatus(creditPlan({ 8: 100 }))!, 1).monthlyPercent).toBe(0);
    expect(devinQuotaFromStatus(decodeDevinUserStatus(creditPlan({ 7: 5, 4: 15 }))!, 1).monthlyPercent).toBe(25);
  });

  test("a known field with the wrong protobuf wire type rejects the status", () => {
    const plan = planInfo({ tier: 16, name: "Pro", billing: 1 });
    for (const bad of [encodeMessage(6, Buffer.alloc(0)), encodeMessage(8, Buffer.alloc(0))]) {
      const status = Buffer.concat([encodeMessage(1, plan), bad, int(6, 0), int(8, 0)]);
      const response = Buffer.concat([encodeMessage(1, encodeMessage(13, status)), encodeMessage(2, plan)]);
      expect(decodeDevinUserStatus(response)).toBeNull();
    }
  });

  test("an overlong varint in a nested status is rejected", () => {
    const plan = planInfo({ tier: 16, name: "Pro", billing: 1 });
    const status = Buffer.concat([encodeMessage(1, plan), Buffer.from([0x30, ...Array(10).fill(0x80), 0x01])]);
    const response = Buffer.concat([encodeMessage(1, encodeMessage(13, status)), encodeMessage(2, plan)]);
    expect(decodeDevinUserStatus(response)).toBeNull();
  });

  test("a status with no plan copy is not decoded into a zero-valued plan", () => {
    // Neither the top-level PlanInfo nor PlanStatus #1: a zero plan would read as an exhausted account.
    const planStatus = Buffer.concat([encodeMessage(3, int(1, PLAN_END)), int(6, 0), int(8, 0)]);
    const noPlan = encodeMessage(1, Buffer.concat([int(10, 1), encodeMessage(13, planStatus)]));
    expect(decodeDevinUserStatus(noPlan)).toBeNull();
  });

  test("a present but truncated plan-end timestamp fails the decode instead of reading as absent", () => {
    const plan = planInfo({ tier: 16, name: "Pro", billing: 1 });
    // PlanStatus #3 holds a field declaring 127 bytes with none present.
    const planStatus = Buffer.concat([encodeMessage(1, plan), encodeMessage(3, Buffer.from([0x12, 0x7f])), int(6, 0), int(8, 0)]);
    const malformed = Buffer.concat([encodeMessage(1, Buffer.concat([int(10, 1), encodeMessage(13, planStatus)])), encodeMessage(2, plan)]);
    expect(decodeDevinUserStatus(malformed)).toBeNull();
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

  test("only 401 is terminal; 403, other 4xx, 5xx and network faults keep last-good", async () => {
    globalThis.fetch = (async () => new Response("unauthenticated: " + KEY, { status: 401 })) as unknown as typeof fetch;
    expect(await fetchDevinQuota("devin", KEY, undefined)).toBe(TERMINAL_QUOTA_FAILURE);
    // A 403 can forbid this one RPC for a key that still serves chat.
    for (const status of [400, 403, 404, 408, 409, 422, 429, 499, 503]) {
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

  test("one deadline stops a continuing byte drip and keeps last-good", async () => {
    const deadline = new AbortController();
    const reason = new DOMException("fixture deadline", "TimeoutError");
    const budgets: number[] = [];
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      budgets.push(ms);
      return deadline.signal;
    });
    const bytes = new Uint8Array(quotaPlan());
    let index = 0;
    let cancelledWith: unknown;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(deadline.signal);
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(bytes.subarray(index, ++index));
          if (index === 3) deadline.abort(reason);
          if (index === bytes.length) controller.close();
        },
        cancel(value) { cancelledWith = value; },
      }, { highWaterMark: 0 }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await fetchDevinQuota("devin", KEY, undefined)).toBeNull();
      expect(budgets).toEqual([8_000]);
      expect(cancelledWith).toBe(reason);
    } finally {
      timeout.mockRestore();
    }
  });

  test("a missing plan or a truncated nested timestamp keeps the last-good row", async () => {
    const plan = planInfo({ tier: 16, name: "Pro", billing: 1 });
    const truncatedEnd = Buffer.concat([encodeMessage(1, plan), encodeMessage(3, Buffer.from([0x12, 0x7f])), int(6, 0), int(8, 0)]);
    const noPlan = Buffer.concat([encodeMessage(3, int(1, PLAN_END)), int(6, 0), int(8, 0)]);
    for (const planStatus of [truncatedEnd, noPlan]) {
      const body = encodeMessage(1, Buffer.concat([int(10, 1), encodeMessage(13, planStatus)]));
      globalThis.fetch = (async () => new Response(new Uint8Array(body), { status: 200 })) as unknown as typeof fetch;
      expect(await fetchDevinQuota("devin", KEY, undefined)).toBeNull();
    }
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

  test("a legacy credential probes the configured EU tenant", async () => {
    await saveCredential("devin", { access: KEY, refresh: KEY, expires: Number.MAX_SAFE_INTEGER });
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(new Uint8Array(quotaPlan()), { status: 200 });
    }) as typeof fetch;
    const euConfig = { ...config, providers: { devin: { ...config.providers.devin, baseUrl: "https://eu.windsurf.com/_route/api_server" } } };
    const result = await fetchProviderQuotaReports(euConfig, true);
    expect(result.reports[0]?.quota.weeklyPercent).toBe(16);
    expect(urls).toEqual(["https://eu.windsurf.com/_route/api_server/exa.seat_management_pb.SeatManagementService/GetUserStatus"]);
  });

  test("a credential-owned tenant takes precedence over the configured base URL", async () => {
    await saveCredential("devin", { access: KEY, refresh: KEY, expires: Number.MAX_SAFE_INTEGER, apiBaseUrl: "https://eu.windsurf.com/_route/api_server" });
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(new Uint8Array(quotaPlan()), { status: 200 });
    }) as typeof fetch;
    await fetchProviderQuotaReports(config, true);
    expect(urls).toEqual(["https://eu.windsurf.com/_route/api_server/exa.seat_management_pb.SeatManagementService/GetUserStatus"]);
  });

  test("an unallowlisted configured host never receives a legacy credential key", async () => {
    await saveCredential("devin", { access: KEY, refresh: KEY, expires: Number.MAX_SAFE_INTEGER });
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(new Uint8Array(quotaPlan()), { status: 200 });
    }) as typeof fetch;
    const unsafeConfig = { ...config, providers: { devin: { ...config.providers.devin, baseUrl: "https://attacker.example" } } };
    await fetchProviderQuotaReports(unsafeConfig, true);
    expect(urls).toEqual(["https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus"]);
  });

  test("a rejected key publishes no row", async () => {
    await saveCredential("devin", { access: KEY, refresh: KEY, expires: Number.MAX_SAFE_INTEGER, apiBaseUrl: "https://server.codeium.com" });
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const result = await fetchProviderQuotaReports(config, true);
    expect(result.reports.filter(r => r.provider === "devin")).toEqual([]);
  });
});

describe("Devin quota cache identity", () => {
  test("a tenant host change invalidates the cached reading; a credential without one keeps its key", async () => {
    const { quotaCredentialIdentity } = await import("../../src/providers/quota/account-cache");
    const target = { adapter: "devin", authMode: "oauth" } as any;
    const base = { access: KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER } as any;
    const us = quotaCredentialIdentity("devin", "a1", { ...base, apiBaseUrl: "https://server.codeium.com" }, target);
    const eu = quotaCredentialIdentity("devin", "a1", { ...base, apiBaseUrl: "https://eu.windsurf.com/_route/api_server" }, target);
    expect(us).not.toBe(eu);
    expect(quotaCredentialIdentity("devin", "a1", base, target)).toBe(quotaCredentialIdentity("devin", "a1", { ...base, apiBaseUrl: undefined }, target));
  });
  test("another provider's apiBaseUrl does not alter its quota credential identity", async () => {
    const { quotaCredentialIdentity } = await import("../../src/providers/quota/account-cache");
    const target = { adapter: "openai-chat", authMode: "oauth" } as any;
    const base = { access: KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER } as any;
    expect(quotaCredentialIdentity("github-copilot", "a1", base, target)).toBe(
      quotaCredentialIdentity("github-copilot", "a1", { ...base, apiBaseUrl: "https://api.githubcopilot.com" }, target),
    );
  });
});
