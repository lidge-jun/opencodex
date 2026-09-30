import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAnthropicAccountPoolState,
  getAnthropicAccountHealthSnapshot,
  rotateAnthropicAccountOn429,
} from "../../../src/oauth/anthropic-routing";
import { getAccountSet, saveAccountCredential, saveCredential } from "../../../src/oauth/store";
import { clearAccountQuotaCache, fetchProviderAccountQuotas, getCachedProviderAccountQuota } from "../../../src/providers/quota";
import { fetchAnthropicUsageQuota } from "../../../src/providers/quota/vendor-probes-oauth";
import { setAnthropicQuotaAfterSettlementForTests } from "../../../src/providers/quota/anthropic-cooldown-recovery";
import { accountCacheKey, accountQuotaCache } from "../../../src/providers/quota/account-cache";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-cooldown-recovery-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
  setAnthropicQuotaAfterSettlementForTests(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
  setAnthropicQuotaAfterSettlementForTests(undefined);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

const config = {
  port: 0,
  defaultProvider: "anthropic",
  providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" } },
  anthropicAccountPool: { enabled: true },
} as OcxConfig;

async function seed(): Promise<string> {
  await saveCredential("anthropic", {
    access: "access-old",
    refresh: "refresh-old",
    expires: Date.now() + 60 * 60_000,
    accountId: "upstream-account",
    email: "recovery@example.test",
  });
  return getAccountSet("anthropic")!.activeAccountId;
}

function rejected(resetAt: number, windows: Array<"5h" | "7d"> = ["5h"]): Headers {
  const headers = new Headers();
  for (const window of windows) {
    headers.set(`anthropic-ratelimit-unified-${window}-status`, "rejected");
    headers.set(`anthropic-ratelimit-unified-${window}-reset`, String(Math.floor(resetAt / 1_000)));
  }
  return headers;
}

function quotaResponse(fiveHour?: number, weekly?: number): Response {
  const reset = new Date(Date.now() + 60 * 60_000).toISOString();
  return Response.json({
    ...(fiveHour === undefined ? {} : { five_hour: { utilization: fiveHour, resets_at: reset } }),
    ...(weekly === undefined ? {} : { seven_day: { utilization: weekly, resets_at: reset } }),
  });
}

describe("Anthropic reset-derived cooldown recovery", () => {
  test("a fresh credential-matched quota report clears the exact recovered cooldown", async () => {
    const id = await seed();
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(Date.now() + 60 * 60_000));
    globalThis.fetch = (async () => quotaResponse(20, 30)) as typeof fetch;

    const [row] = await fetchProviderAccountQuotas("anthropic", true);
    expect(row?.quota).toMatchObject({ fiveHourPercent: 20, weeklyPercent: 30 });
    expect(getAnthropicAccountHealthSnapshot(id)).toBeNull();
  });

  test("partial, exhausted, and failed probes retain a reset-derived cooldown", async () => {
    const id = await seed();
    const resetAt = Date.now() + 2 * 60 * 60_000;
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(resetAt, ["5h", "7d"]));

    globalThis.fetch = (async () => quotaResponse(20)) as typeof fetch;
    await fetchProviderAccountQuotas("anthropic", true);
    expect(getAnthropicAccountHealthSnapshot(id)?.cooldownUntil).toBe(Math.floor(resetAt / 1_000) * 1_000);

    globalThis.fetch = (async () => quotaResponse(20, 100)) as typeof fetch;
    await fetchProviderAccountQuotas("anthropic", true);
    expect(getAnthropicAccountHealthSnapshot(id)?.cooldownSource).toBe("reset-derived");

    globalThis.fetch = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    const [failed] = await fetchProviderAccountQuotas("anthropic", true);
    expect(failed?.unavailable).toBe(true);
    expect(getAnthropicAccountHealthSnapshot(id)?.cooldownSource).toBe("reset-derived");

    globalThis.fetch = (async () => quotaResponse(20, 30)) as typeof fetch;
    await fetchProviderAccountQuotas("anthropic", true);
    expect(getAnthropicAccountHealthSnapshot(id)).toBeNull();
  });

  test("successful quota reports do not clear Retry-After or guessed cooldowns", async () => {
    const id = await seed();
    globalThis.fetch = (async () => quotaResponse(0, 0)) as typeof fetch;

    rotateAnthropicAccountOn429(config, id, "3600", null, Date.now());
    await fetchProviderAccountQuotas("anthropic", true);
    expect(getAnthropicAccountHealthSnapshot(id)?.cooldownSource).toBe("retry-after");

    clearAnthropicAccountPoolState();
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), new Headers());
    await fetchProviderAccountQuotas("anthropic", true);
    expect(getAnthropicAccountHealthSnapshot(id)?.cooldownSource).toBe("default");
  });

  test("credential replacement while the probe is in flight retains the cooldown", async () => {
    const id = await seed();
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(Date.now() + 60 * 60_000));
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finish = resolve; });
    globalThis.fetch = (async () => { started(); return response; }) as typeof fetch;

    const pending = fetchProviderAccountQuotas("anthropic", true);
    await dispatched;
    await saveCredential("anthropic", {
      access: "access-new",
      refresh: "refresh-new",
      expires: Date.now() + 60 * 60_000,
      accountId: "upstream-account",
      email: "recovery@example.test",
    });
    finish(quotaResponse(0, 0));
    const [row] = await pending;
    expect(row?.unavailable).toBe(true);
    expect(getCachedProviderAccountQuota("anthropic", id)).toBeNull();
    expect(getAnthropicAccountHealthSnapshot(id)?.cooldownSource).toBe("reset-derived");
  });

  test("an older quota probe cannot erase a newer 429 generation", async () => {
    const id = await seed();
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(Date.now() + 60 * 60_000));
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finish = resolve; });
    globalThis.fetch = (async () => { started(); return response; }) as typeof fetch;

    const pending = fetchProviderAccountQuotas("anthropic", true);
    await dispatched;
    const newerReset = Date.now() + 2 * 60 * 60_000;
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(newerReset));
    finish(quotaResponse(0, 0));
    const [stale] = await pending;
    expect(stale?.unavailable).toBe(true);
    expect(getCachedProviderAccountQuota("anthropic", id)).toBeNull();
    expect(getAnthropicAccountHealthSnapshot(id)?.cooldownUntil).toBe(Math.floor(newerReset / 1_000) * 1_000);
  });

  test("a newer 429 after settlement blocks the older quota publication", async () => {
    const id = await seed();
    const firstReset = Date.now() + 60 * 60_000;
    const newerReset = Date.now() + 2 * 60 * 60_000;
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(firstReset));
    setAnthropicQuotaAfterSettlementForTests(() => {
      rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(newerReset));
    });
    globalThis.fetch = (async () => quotaResponse(10, 20)) as typeof fetch;

    const [stale] = await fetchProviderAccountQuotas("anthropic", true);
    expect(stale?.unavailable).toBe(true);
    expect(getCachedProviderAccountQuota("anthropic", id)).toBeNull();
    expect(getAnthropicAccountHealthSnapshot(id)?.cooldownUntil).toBe(Math.floor(newerReset / 1_000) * 1_000);
  });

  test("forced recovery bypasses an account-level quota flight started before the 429", async () => {
    const id = await seed();
    let finishOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>(resolve => { finishOld = resolve; });
    let oldStarted!: () => void;
    const dispatched = new Promise<void>(resolve => { oldStarted = resolve; });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        oldStarted();
        return oldResponse;
      }
      return quotaResponse(10, 20);
    }) as typeof fetch;

    const oldProbe = fetchProviderAccountQuotas("anthropic", true);
    await dispatched;
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(Date.now() + 60 * 60_000));

    const [recovered] = await fetchProviderAccountQuotas("anthropic", true);
    expect(calls).toBe(2);
    expect(recovered?.quota).toMatchObject({ fiveHourPercent: 10, weeklyPercent: 20 });
    expect(getAnthropicAccountHealthSnapshot(id)).toBeNull();

    finishOld(quotaResponse(90, 90));
    const [stale] = await oldProbe;
    expect(stale?.unavailable).toBe(true);
    expect(getCachedProviderAccountQuota("anthropic", id)).toMatchObject({
      fiveHourPercent: 10,
      weeklyPercent: 20,
    });
  });

  test("recovery dispatch does not join a usage request started before the cooldown", async () => {
    const id = await seed();
    let finishOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>(resolve => { finishOld = resolve; });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? oldResponse : quotaResponse(0, 0);
    }) as typeof fetch;
    const oldProbe = fetchAnthropicUsageQuota("access-old");
    await Promise.resolve();
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(Date.now() + 60 * 60_000));

    await fetchProviderAccountQuotas("anthropic", true);
    expect(calls).toBe(2);
    expect(getAnthropicAccountHealthSnapshot(id)).toBeNull();
    finishOld(quotaResponse(100, 100));
    await oldProbe;
  });

  test("a post-recovery third flight cannot rejoin the pre-429 usage request", async () => {
    const id = await seed();
    let finishOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>(resolve => { finishOld = resolve; });
    let finishThird!: (response: Response) => void;
    const thirdResponse = new Promise<Response>(resolve => { finishThird = resolve; });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? oldResponse : calls === 2 ? quotaResponse(10, 20) : thirdResponse;
    }) as typeof fetch;

    const oldProbe = fetchProviderAccountQuotas("anthropic", true);
    while (calls < 1) await Promise.resolve();
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(Date.now() + 60 * 60_000));
    await fetchProviderAccountQuotas("anthropic", true);
    const thirdTransport = fetchAnthropicUsageQuota("access-old");
    const thirdProbe = fetchProviderAccountQuotas("anthropic", true);
    finishOld(quotaResponse(100, 100));
    await oldProbe;
    if (calls === 3) finishThird(quotaResponse(30, 40));
    await thirdTransport;
    const [third] = await thirdProbe;
    expect(calls).toBe(3);
    expect(third?.quota).toMatchObject({ fiveHourPercent: 30, weeklyPercent: 40 });
    expect(getCachedProviderAccountQuota("anthropic", id)).toMatchObject({ fiveHourPercent: 30, weeklyPercent: 40 });
  });

  for (const failure of ["null", "reject"] as const) {
    test(`superseded ${failure} cannot replace recovered cache availability or timestamp`, async () => {
      const id = await seed();
      let finishOld!: (response: Response) => void;
      let rejectOld!: (reason: Error) => void;
      const oldResponse = new Promise<Response>((resolve, reject) => { finishOld = resolve; rejectOld = reject; });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return calls === 1 ? oldResponse : quotaResponse(10, 20);
      }) as typeof fetch;

      const oldProbe = fetchProviderAccountQuotas("anthropic", true);
      while (calls < 1) await Promise.resolve();
      rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(Date.now() + 60 * 60_000));
      await fetchProviderAccountQuotas("anthropic", true);
      const recovered = accountQuotaCache.get(accountCacheKey("anthropic", id));
      expect(recovered?.unavailable).toBeUndefined();
      if (failure === "null") finishOld(new Response("busy", { status: 503 }));
      else rejectOld(new Error("timeout"));
      await oldProbe;

      expect(accountQuotaCache.get(accountCacheKey("anthropic", id))).toBe(recovered);
      expect(getCachedProviderAccountQuota("anthropic", id)).toMatchObject({ fiveHourPercent: 10, weeklyPercent: 20 });
      const [cached] = await fetchProviderAccountQuotas("anthropic");
      expect(cached?.unavailable).toBeUndefined();
      expect(calls).toBe(2);
    });
  }

  test("an old token-resolution failure cannot replace a newer recovered quota entry", async () => {
    const id = await seed();
    await saveAccountCredential("anthropic", id, {
      access: "access-expired", refresh: "refresh-old", expires: Date.now() - 60_000,
      accountId: "upstream-account", email: "recovery@example.test",
    });
    let failRefresh!: (error: Error) => void;
    let refreshStarted!: () => void;
    const refreshPending = new Promise<Response>((_resolve, reject) => { failRefresh = reject; });
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/v1/oauth/token")) { refreshStarted(); return refreshPending; }
      return quotaResponse(10, 20);
    }) as typeof fetch;

    const older = fetchProviderAccountQuotas("anthropic", true);
    await started;
    await saveAccountCredential("anthropic", id, {
      access: "access-recovered", refresh: "refresh-new", expires: Date.now() + 60 * 60_000,
      accountId: "upstream-account", email: "recovery@example.test",
    });
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(Date.now() + 60 * 60_000));
    const [newer] = await fetchProviderAccountQuotas("anthropic", true);
    expect(newer?.unavailable).toBeUndefined();
    const key = accountCacheKey("anthropic", id);
    const recovered = accountQuotaCache.get(key);
    expect(recovered?.quota).toMatchObject({ fiveHourPercent: 10, weeklyPercent: 20 });

    failRefresh(new Error("old refresh failed"));
    const [stale] = await older;
    expect(stale?.unavailable).toBe(true);
    expect(accountQuotaCache.get(key)).toBe(recovered);
    expect(accountQuotaCache.get(key)?.ts).toBe(recovered?.ts);
    const [cached] = await fetchProviderAccountQuotas("anthropic");
    expect(cached?.unavailable).toBeUndefined();
  });

  test("credential replacement invalidates a live success on routing and account reads", async () => {
    const id = await seed();
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return quotaResponse(calls === 1 ? 10 : 30, 20); }) as typeof fetch;
    const [live] = await fetchProviderAccountQuotas("anthropic", true);
    expect(live?.isCurrent?.()).toBe(true);
    expect(getCachedProviderAccountQuota("anthropic", id)?.fiveHourPercent).toBe(10);

    await saveCredential("anthropic", {
      access: "access-new", refresh: "refresh-new", expires: Date.now() + 60 * 60_000,
      accountId: "upstream-account", email: "recovery@example.test",
    });
    expect(live?.isCurrent?.()).toBe(false);
    expect(getCachedProviderAccountQuota("anthropic", id)).toBeNull();
    const [fresh] = await fetchProviderAccountQuotas("anthropic");
    expect(calls).toBe(2);
    expect(fresh?.quota?.fiveHourPercent).toBe(30);
  });

  test("a later cooldown invalidates live cached success before the account TTL", async () => {
    const id = await seed();
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return quotaResponse(calls === 1 ? 10 : 30, 20); }) as typeof fetch;
    const [live] = await fetchProviderAccountQuotas("anthropic", true);
    expect(live?.isCurrent?.()).toBe(true);
    rotateAnthropicAccountOn429(config, id, null, null, Date.now(), rejected(Date.now() + 60 * 60_000));
    expect(live?.isCurrent?.()).toBe(false);
    expect(getCachedProviderAccountQuota("anthropic", id)).toBeNull();
    const [fresh] = await fetchProviderAccountQuotas("anthropic");
    expect(calls).toBe(2);
    expect(fresh?.quota?.fiveHourPercent).toBe(30);
  });
});
