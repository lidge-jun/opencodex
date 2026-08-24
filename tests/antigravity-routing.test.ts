import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterRequest } from "../src/adapters/base";
import { fetchAntigravityWithRetry } from "../src/adapters/google-http";
import {
  clearAntigravityAccountCooldown,
  getAntigravityAccountCooldown,
  isAntigravityAccountInCooldown,
  nextAntigravityAccount,
  recordAntigravityCooldown,
  sweepExpiredAntigravityRoutingHealth,
} from "../src/oauth/antigravity-routing";

const realFetch = globalThis.fetch;

const NOW = 1_700_000_000_000;
const ACCOUNT_IDS = ["account-a", "account-b", "account-c"];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const accountId of ACCOUNT_IDS) clearAntigravityAccountCooldown(accountId);
  clearAntigravityAccountCooldown("account-http-retry");
});

const antigravityRequest: AdapterRequest = {
  url: "https://daily-cloudcode-pa.googleapis.com/v1/projects/p:generateContent",
  method: "POST",
  headers: { authorization: "Bearer tok", "content-type": "application/json" },
  body: "{}",
};

function mockFetch(responses: Array<Response | Error>): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls };
}

function googleError(code: number, status: string, message: string): string {
  return JSON.stringify({ error: { code, status, message } });
}

describe("Antigravity account cooldowns", () => {
  test("records a rate-limit cooldown and sweeps it after expiry", () => {
    recordAntigravityCooldown("account-a", "rate_limited", undefined, NOW);

    expect(isAntigravityAccountInCooldown("account-a", NOW)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 4_999)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 5_000)).toBe(false);
    recordAntigravityCooldown("account-b", "rate_limited", undefined, NOW);
    expect(sweepExpiredAntigravityRoutingHealth(NOW + 5_000)).toBe(1);
    expect(sweepExpiredAntigravityRoutingHealth(NOW + 5_000)).toBe(0);
  });

  test("caps rate-limit Retry-After and uses a parsed quota reset", () => {
    recordAntigravityCooldown("account-a", "rate_limited", 120_000, NOW);
    recordAntigravityCooldown("account-b", "quota_exhausted", 30_000, NOW);

    expect(isAntigravityAccountInCooldown("account-a", NOW + 60_000)).toBe(false);
    expect(isAntigravityAccountInCooldown("account-b", NOW + 29_999)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-b", NOW + 30_000)).toBe(false);
  });

  test("honors a quota reset longer than 24 hours", () => {
    const resetDurationMs = 48 * 60 * 60_000;
    recordAntigravityCooldown("account-a", "quota_exhausted", resetDurationMs, NOW);

    expect(isAntigravityAccountInCooldown("account-a", NOW + 24 * 60 * 60_000 + 1)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + resetDurationMs)).toBe(false);
  });

  test("caps quota-exhausted Retry-After at 7 days", () => {
    const tenYearsMs = 10 * 365 * 24 * 60 * 60_000;
    const sevenDaysMs = 7 * 24 * 60 * 60_000;
    recordAntigravityCooldown("account-a", "quota_exhausted", tenYearsMs, NOW);

    expect(isAntigravityAccountInCooldown("account-a", NOW + sevenDaysMs - 1)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + sevenDaysMs)).toBe(false);
  });

  test("skips cooled accounts when selecting the next account", () => {
    recordAntigravityCooldown("account-b", "rate_limited", undefined, NOW);

    expect(nextAntigravityAccount(ACCOUNT_IDS, "account-a", NOW)).toBe("account-c");
    expect(nextAntigravityAccount(ACCOUNT_IDS, "account-c", NOW)).toBe("account-a");
    expect(nextAntigravityAccount(ACCOUNT_IDS, undefined, NOW)).toBe("account-a");
  });

  test("keeps a geo block out of the short retry-limit path", () => {
    recordAntigravityCooldown("account-a", "geo_blocked", undefined, NOW);

    expect(nextAntigravityAccount(["account-a"], "account-a", NOW + 60_000)).toBeUndefined();
    expect(isAntigravityAccountInCooldown("account-a", NOW + 60_000)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 24 * 60 * 60_000)).toBe(false);
  });

  test("retains the longest expiry from concurrent cooldown records", () => {
    recordAntigravityCooldown("account-a", "rate_limited", 60_000, NOW);
    recordAntigravityCooldown("account-a", "rate_limited", undefined, NOW + 1);

    expect(isAntigravityAccountInCooldown("account-a", NOW + 5_001)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 59_999)).toBe(true);
    expect(isAntigravityAccountInCooldown("account-a", NOW + 60_001)).toBe(false);
  });

  test("records and returns the cooldown reason via getAntigravityAccountCooldown", () => {
    recordAntigravityCooldown("account-a", "rate_limited", undefined, NOW);
    expect(getAntigravityAccountCooldown("account-a", NOW)).toEqual({
      cooldownUntil: NOW + 5_000,
      reason: "rate_limited",
    });

    recordAntigravityCooldown("account-b", "quota_exhausted", 30_000, NOW);
    expect(getAntigravityAccountCooldown("account-b", NOW)).toEqual({
      cooldownUntil: NOW + 30_000,
      reason: "quota_exhausted",
    });

    recordAntigravityCooldown("account-c", "geo_blocked", undefined, NOW);
    expect(getAntigravityAccountCooldown("account-c", NOW)).toEqual({
      cooldownUntil: NOW + 24 * 60 * 60_000,
      reason: "geo_blocked",
    });
    expect(getAntigravityAccountCooldown("account-c", NOW + 24 * 60 * 60_000)).toBeUndefined();
  });

  test("keeps the longer cooldown and its reason when a shorter one is recorded", () => {
    recordAntigravityCooldown("account-a", "geo_blocked", undefined, NOW);
    recordAntigravityCooldown("account-a", "rate_limited", undefined, NOW + 1);

    expect(getAntigravityAccountCooldown("account-a", NOW)).toEqual({
      cooldownUntil: NOW + 24 * 60 * 60_000,
      reason: "geo_blocked",
    });
  });

  test("updates reason when a longer cooldown replaces a shorter one", () => {
    recordAntigravityCooldown("account-a", "rate_limited", undefined, NOW);
    recordAntigravityCooldown("account-a", "quota_exhausted", 60_000, NOW);

    expect(getAntigravityAccountCooldown("account-a", NOW)).toEqual({
      cooldownUntil: NOW + 60_000,
      reason: "quota_exhausted",
    });
  });
});

describe("Antigravity HTTP cooldown fail-fast", () => {
  test("does not retry a rate-limited 429 after recording cooldown", async () => {
    const mock = mockFetch([
      new Response(googleError(429, "RESOURCE_EXHAUSTED", "rate limit, try again"), {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
      new Response("ok", { status: 200 }),
    ]);

    const res = await fetchAntigravityWithRetry(antigravityRequest, {
      timeoutMs: 5_000,
      accountId: "account-http-retry",
    });

    expect(res.status).toBe(429);
    expect(mock.calls).toHaveLength(1);
    expect(getAntigravityAccountCooldown("account-http-retry")?.reason).toBe("rate_limited");
  });

  test("does not retry a quota-exhausted 429 after recording cooldown", async () => {
    const mock = mockFetch([
      new Response(
        googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for your current billing plan"),
        { status: 429, headers: { "Retry-After": "0" } },
      ),
      new Response("ok", { status: 200 }),
    ]);

    const res = await fetchAntigravityWithRetry(antigravityRequest, {
      timeoutMs: 5_000,
      accountId: "account-http-retry",
    });

    expect(res.status).toBe(429);
    expect(mock.calls).toHaveLength(1);
    expect(getAntigravityAccountCooldown("account-http-retry")?.reason).toBe("quota_exhausted");
  });

  test("selects the next eligible account after the first cools on 429", async () => {
    mockFetch([
      new Response(googleError(429, "RESOURCE_EXHAUSTED", "rate limit, try again"), {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    ]);

    const res = await fetchAntigravityWithRetry(antigravityRequest, {
      timeoutMs: 5_000,
      accountId: "account-a",
    });

    expect(res.status).toBe(429);
    expect(getAntigravityAccountCooldown("account-a")?.reason).toBe("rate_limited");
    expect(nextAntigravityAccount(ACCOUNT_IDS, undefined)).toBe("account-b");
    expect(nextAntigravityAccount(ACCOUNT_IDS, "account-a")).toBe("account-b");
  });

  test("does not retry a geo-blocked 403 after recording cooldown", async () => {
    const mock = mockFetch([
      new Response(
        googleError(403, "PERMISSION_DENIED", "User location is not supported for the API use"),
        { status: 403 },
      ),
      new Response("ok", { status: 200 }),
    ]);

    const res = await fetchAntigravityWithRetry(antigravityRequest, {
      timeoutMs: 5_000,
      accountId: "account-http-retry",
    });

    expect(res.status).toBe(403);
    expect(mock.calls).toHaveLength(1);
    expect(getAntigravityAccountCooldown("account-http-retry")?.reason).toBe("geo_blocked");
  });
});
