/**
 * On-demand Muse quota, read from the key endpoint.
 *
 * Until this unit the provider quota could only be OBSERVED mid-stream, so a dashboard
 * load could not refresh it without spending an inference turn. These tests cover the
 * probe that changes that, and the two rate limits that keep it from becoming a mint loop.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { fetchMuseKeyQuotaSnapshot, museKeyQuotaBackoffRemainingMs, resetMuseKeyQuotaBackoff } from "../../src/providers/muse-key-quota";
import { getProviderRegistryEntry, mergeRegistryStaticHeaders } from "../../src/providers/registry";

const KEY = `LLM|${"1".repeat(16)}|${"c".repeat(27)}`;
const TOKEN = "meta-account-" + "z".repeat(48);

function harness(replies: Array<{ status?: number; body?: unknown } | "reject">) {
  let index = 0;
  const bodies: string[] = [];
  let clock = 1_700_000_000_000;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(init.body);
    const r = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (r === "reject") throw new Error("network down");
    return new Response(JSON.stringify(r?.body ?? {}), { status: r?.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return {
    deps: { fetchImpl, now: () => clock },
    bodies,
    calls: () => index,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
  };
}

const USAGE_OK = {
  api_key: KEY,
  is_subs_active: true,
  subs_usage: {
    window: { used_percent: 12, resets_at: 1_788_431_188, window_duration_mins: 300 },
    weekly: { used_percent: 34, resets_at: 1_788_739_200 },
  },
};

describe("muse key quota probe", () => {
  beforeEach(() => { resetMuseKeyQuotaBackoff(); });

  test("maps the five-hour window and the weekly window", async () => {
    const h = harness([{ body: USAGE_OK }]);
    const quota = await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps);
    expect(quota?.fiveHourPercent).toBe(12);
    expect(quota?.fiveHourResetAt).toBe(1_788_431_188_000);
    expect(quota?.weeklyPercent).toBe(34);
    expect(quota?.weeklyResetAt).toBe(1_788_739_200_000);
  });

  // A window of another length must never be filed in the five-hour slot: that would
  // understate usage by the ratio of the two windows, with full confidence.
  test("a window of another length keeps its real duration", async () => {
    const h = harness([{ body: { subs_usage: { window: { used_percent: 50, window_duration_mins: 600 } } } }]);
    const quota = await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps);
    expect(quota?.fiveHourPercent).toBeUndefined();
    expect(quota?.customWindows).toEqual([{ label: "600m", percent: 50 }]);
  });

  test("no usage object is no measurement, never zero usage", async () => {
    const h = harness([{ body: { api_key: KEY, is_subs_active: true } }]);
    expect(await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps)).toBeNull();
  });

  test("an inactive subscription reports nothing rather than a stale row", async () => {
    const h = harness([{ body: { ...USAGE_OK, is_subs_active: false } }]);
    expect(await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps)).toBeNull();
  });

  // Onboarding on a dashboard poll would be a side effect on the account.
  test("a read never asks Meta to onboard", async () => {
    const h = harness([{ body: USAGE_OK }]);
    await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps);
    expect(h.bodies[0]).toBe("{}");
  });

  test("the response key is never returned", async () => {
    const h = harness([{ body: USAGE_OK }]);
    const quota = await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps);
    expect(JSON.stringify(quota)).not.toContain(KEY);
    expect(JSON.stringify(quota)).not.toContain("api_key");
  });

  test("a rejected fetch costs a row, not a page", async () => {
    const h = harness(["reject"]);
    expect(await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps)).toBeNull();
  });

  test("a failure backs off and the next poll performs no request", async () => {
    const h = harness(["reject"]);
    await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps);
    expect(h.calls()).toBe(1);
    await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps);
    expect(h.calls()).toBe(1);
    expect(museKeyQuotaBackoffRemainingMs("acct-a", h.now())).toBeGreaterThan(0);
  });

  test("the backoff expires after five minutes", async () => {
    const h = harness(["reject", { body: USAGE_OK }]);
    await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps);
    h.advance(5 * 60_000 + 1);
    const quota = await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps);
    expect(h.calls()).toBe(2);
    expect(quota?.weeklyPercent).toBe(34);
  });

  // The second rate limit, and the one a failure backoff alone does not provide:
  // ?refresh=1 and the reset poller both bypass the ordinary quota cache, so without a
  // success TTL a held-down refresh button would drive one key-mint per click.
  test("a success spaces the next mint by five minutes, with no way to force it", async () => {
    const h = harness([{ body: USAGE_OK }, { body: USAGE_OK }]);
    expect(await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps)).not.toBeNull();
    expect(h.calls()).toBe(1);
    h.advance(60_000);
    expect(await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps)).toBeNull();
    expect(h.calls()).toBe(1);
    h.advance(4 * 60_000 + 1);
    expect(await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps)).not.toBeNull();
    expect(h.calls()).toBe(2);
  });

  test("one account rate limit does not silence another", async () => {
    const h = harness(["reject", { body: USAGE_OK }]);
    await fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps);
    const other = await fetchMuseKeyQuotaSnapshot("acct-b", TOKEN, h.deps);
    expect(h.calls()).toBe(2);
    expect(other?.weeklyPercent).toBe(34);
  });
  // The TTL check alone is not atomic. ?refresh=1 and the reset poller can both pass it
  // before either writes, so without an in-flight gate one window would spend two mints.
  test("two overlapping callers share one mint instead of racing it", async () => {
    const h = harness([{ body: USAGE_OK }]);
    const [a, b] = await Promise.all([
      fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps),
      fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps),
    ]);
    expect(h.calls()).toBe(1);
    expect(a?.weeklyPercent).toBe(34);
    expect(b?.weeklyPercent).toBe(34);
  });

  test("overlapping callers for different accounts are not serialised", async () => {
    const h = harness([{ body: USAGE_OK }, { body: USAGE_OK }]);
    await Promise.all([
      fetchMuseKeyQuotaSnapshot("acct-a", TOKEN, h.deps),
      fetchMuseKeyQuotaSnapshot("acct-b", TOKEN, h.deps),
    ]);
    expect(h.calls()).toBe(2);
  });
});

describe("muse model api version header", () => {
  test("the registry row declares it", () => {
    expect(getProviderRegistryEntry("meta-muse")?.staticHeaders).toEqual({ "x-api-version": "1.0.0" });
  });

  test("a user-set header of the same name still wins", () => {
    const entry = getProviderRegistryEntry("meta-muse");
    const merged = mergeRegistryStaticHeaders(entry?.staticHeaders, { "X-Api-Version": "9.9.9" });
    expect(merged).toEqual({ "X-Api-Version": "9.9.9" });
  });

  test("it is merged in when the user sets an unrelated header", () => {
    const entry = getProviderRegistryEntry("meta-muse");
    const merged = mergeRegistryStaticHeaders(entry?.staticHeaders, { "X-Trace": "1" });
    expect(merged).toEqual({ "X-Trace": "1", "x-api-version": "1.0.0" });
  });
});
