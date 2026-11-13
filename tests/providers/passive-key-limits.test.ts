import { describe, expect, test } from "bun:test";
import { parsePassiveKeyLimits, PassiveKeyLimitCache } from "../../src/providers/quota/passive-key-limits";

const at = Date.parse("2026-11-07T12:00:00Z");
const home = "/fixture/home-a";
const identity = { home, owner: "opaque-owner-a", provider: "openai" as const, model: "vendor/model-v1" };
const headers = (values: Record<string, string>) => new Headers(values);

describe("passive key limit parsing", () => {
  test("missing header families produce timestamped unknown dimensions", () => {
    for (const [provider, dimensions] of [
      ["openai", [{ dimension: "requests" }, { dimension: "tokens" }]],
      ["xai", [{ dimension: "requests" }, { dimension: "tokens" }]],
      ["groq", [{ dimension: "requests", window: "day" }, { dimension: "tokens", window: "minute" }]],
      ["anthropic", [{ dimension: "requests" }, { dimension: "input-tokens" }, { dimension: "output-tokens" }, { dimension: "tokens" }]],
      ["mistral", [{ dimension: "requests", window: "minute" }, { dimension: "tokens", window: "minute" }, { dimension: "tokens", window: "month" }]],
    ] as const) {
      expect(parsePassiveKeyLimits(provider, headers({}), at)).toEqual(dimensions.map(row => ({ ...row, observedAt: at })));
    }
    expect(parsePassiveKeyLimits("groq", headers({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-tokens": "1s" }), at)).toEqual([
      { dimension: "requests", window: "day", observedAt: at, remaining: 0 },
      { dimension: "tokens", window: "minute", observedAt: at, resetAt: at + 1000 },
    ]);
  });
  for (const provider of ["openai", "xai", "groq"] as const) {
    test(`${provider} preserves request and token counts and exact reset durations`, () => {
      expect(parsePassiveKeyLimits(provider, headers({
        "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1m2.250s", "x-ratelimit-limit-tokens": "9000",
        "x-ratelimit-remaining-tokens": "700", "x-ratelimit-reset-tokens": "750ms",
      }), at)).toEqual([
        { dimension: "requests", ...(provider === "groq" ? { window: "day" } : {}), observedAt: at, limit: 100, remaining: 0, resetAt: at + 62250 },
        { dimension: "tokens", ...(provider === "groq" ? { window: "minute" } : {}), observedAt: at, limit: 9000, remaining: 700, resetAt: at + 750 },
      ]);
    });
  }
  test("untrusted malformed values stay unknown and durations cannot be rounded or overflow", () => {
    for (const reset of ["1.0001s", "1s junk", "-1s", "1e3s", "999999999999999999h", "1s1m", "1m1m", "31d"]) {
      expect(parsePassiveKeyLimits("openai", headers({ "x-ratelimit-limit-requests": "23", "x-ratelimit-reset-requests": reset }), at))
        .toEqual([{ dimension: "requests", observedAt: at, limit: 23 }, { dimension: "tokens", observedAt: at }]);
    }
    expect(parsePassiveKeyLimits("groq", headers({
      "x-ratelimit-limit-requests": "-1", "x-ratelimit-remaining-requests": "2e3",
      "x-ratelimit-limit-tokens": "1000000000001", "x-ratelimit-remaining-tokens": "NaN",
    }), at)).toEqual([{ dimension: "requests", window: "day", observedAt: at }, { dimension: "tokens", window: "minute", observedAt: at }]);
    expect(parsePassiveKeyLimits("openai", headers({ "x-ratelimit-remaining-requests": "3" }), at))
      .toEqual([{ dimension: "requests", observedAt: at, remaining: 3 }, { dimension: "tokens", observedAt: at }]);
  });
  test("Anthropic validates dates and preserves each independent token family", () => {
    const values = headers({
      "anthropic-ratelimit-requests-limit": "12", "anthropic-ratelimit-requests-reset": "2026-11-07T13:00:00+01:00",
      "anthropic-ratelimit-input-tokens-remaining": "4", "anthropic-ratelimit-input-tokens-reset": "2026-02-30T12:00:00Z",
      "anthropic-ratelimit-output-tokens-limit": "17", "anthropic-ratelimit-output-tokens-reset": "2026-11-07",
      "anthropic-ratelimit-tokens-remaining": "9", "anthropic-ratelimit-tokens-reset": "2026-11-07T12:00:02.125Z",
    });
    expect(parsePassiveKeyLimits("anthropic", values, at)).toEqual([
      { dimension: "requests", observedAt: at, limit: 12, resetAt: at },
      { dimension: "input-tokens", observedAt: at, remaining: 4 },
      { dimension: "output-tokens", observedAt: at, limit: 17 },
      { dimension: "tokens", observedAt: at, remaining: 9, resetAt: at + 2125 },
    ]);
  });
  test("Mistral recognizes named minute and month counters without inventing resets", () => {
    expect(parsePassiveKeyLimits("mistral", headers({
      "x-ratelimit-limit-req-minute": "30", "x-ratelimit-remaining-req-minute": "29",
      "x-ratelimit-limit-tokens-minute": "1000", "x-ratelimit-remaining-tokens-minute": "0",
      "x-ratelimit-limit-tokens-month": "10000", "x-ratelimit-remaining-tokens-month": "not-a-number",
      "x-ratelimit-reset-tokens-month": "1s",
    }), at)).toEqual([
      { dimension: "requests", window: "minute", observedAt: at, limit: 30, remaining: 29 },
      { dimension: "tokens", window: "minute", observedAt: at, limit: 1000, remaining: 0 },
      { dimension: "tokens", window: "month", observedAt: at, limit: 10000 },
    ]);
  });
});

describe("passive key observation cache", () => {
  const response = (n: number, reset = "10s") => headers({ "x-ratelimit-remaining-requests": String(n), "x-ratelimit-reset-requests": reset });
  test("a headerless response shows unknown and leaves a retained measurement intact", () => {
    const cache = new PassiveKeyLimitCache({ retentionMs: 20000 });
    expect(cache.record(identity, headers({}), at, 1, 200)).toBe(true);
    expect(cache.get(identity, at)).toEqual([{ dimension: "requests", observedAt: at, stale: false }, { dimension: "tokens", observedAt: at, stale: false }]);
    expect(cache.record(identity, response(7, "1s"), at + 10, 2, 200)).toBe(true);
    expect(cache.record(identity, headers({}), at + 20, 3, 200)).toBe(false);
    expect(cache.get(identity, at + 1010)).toEqual([
      { dimension: "requests", observedAt: at + 10, remaining: 7, resetAt: at + 1010, stale: true },
      { dimension: "tokens", observedAt: at + 10, stale: false },
    ]);
    expect(cache.get(identity, at + 20010)).toEqual([]);
  });
  test("eviction cannot make an older in-flight response fresh", () => {
    const cache = new PassiveKeyLimitCache({ maxEntries: 1 });
    const other = { ...identity, model: "other" };
    const older = cache.reserve(identity, 1)!;
    const newer = cache.reserve(identity, 2)!;
    expect(newer.record(response(7), at, 200)).toBe(true);
    expect(cache.reserve(other, 3)!.record(response(3), at, 200)).toBe(true);
    expect(older.record(response(2), at + 50, 200)).toBe(false);
    expect(cache.get(identity, at + 50)).toEqual([]);
  });
  test("evicted reservations stay invalid even after the same identity is reserved again", () => {
    const cache = new PassiveKeyLimitCache({ maxEntries: 1 });
    const old = cache.reserve(identity, 1)!;
    cache.reserve({ ...identity, model: "other" }, 2)!.cancel();
    const current = cache.reserve(identity, 3)!;
    expect(old.record(response(1), at, 200)).toBe(false);
    expect(current.record(response(3), at, 200)).toBe(true);
    expect(cache.get(identity, at)[0]?.remaining).toBe(3);
  });
  test("a headerless newer response does not fence an older real one", () => {
    const cache = new PassiveKeyLimitCache();
    const old = cache.reserve(identity, 1)!;
    expect(cache.reserve(identity, 2)!.record(headers({}), at, 200)).toBe(true);
    expect(old.record(response(1), at, 200)).toBe(true);
    expect(cache.get(identity, at)).toEqual([{ dimension: "requests", observedAt: at, remaining: 1, resetAt: at + 10000, stale: false }, { dimension: "tokens", observedAt: at, stale: false }]);
  });
  test("cancel, duplicate settlement and clear invalidate reservations", () => {
    const cache = new PassiveKeyLimitCache({ maxEntries: 1 });
    const cancelled = cache.reserve(identity, 1)!;
    cancelled.cancel();
    cancelled.cancel();
    expect(cancelled.record(response(1), at, 200)).toBe(false);
    const cleared = cache.reserve(identity, 2)!;
    cache.clear(home);
    expect(cleared.record(response(2), at, 200)).toBe(false);
    const settled = cache.reserve(identity, 3)!;
    expect(settled.record(response(3), at, 200)).toBe(true);
    expect(settled.record(response(4), at, 200)).toBe(false);
    settled.cancel();
    expect(cache.get(identity, at)[0]?.remaining).toBe(3);
  });
  test("cancelled sends release empty reservations without evicting observations", () => {
    const cache = new PassiveKeyLimitCache({ maxEntries: 2 });
    const other = { ...identity, model: "other" }, third = { ...identity, model: "third" };
    expect(cache.reserve(identity, 1)!.record(response(1), at, 200)).toBe(true);
    const pending = cache.reserve(other, 2)!;
    pending.cancel();
    expect(cache.reserve(third, 3)!.record(response(3), at, 200)).toBe(true);
    expect(cache.get(identity, at)[0]?.remaining).toBe(1);
    expect(cache.reserve({ ...identity, model: "bad model" }, 4)).toBeUndefined();
    expect(cache.reserve(identity, -1)).toBeUndefined();
  });
  test("a failed send releases its reservation without invalidating another send", async () => {
    const cache = new PassiveKeyLimitCache({ maxEntries: 2 });
    const surviving = cache.reserve(identity, 1)!;
    const failed = cache.reserve(identity, 2)!;
    await expect((async () => {
      try { throw new Error("send failed"); } finally { failed.cancel(); }
    })()).rejects.toThrow("send failed");
    expect(failed.record(response(2), at, 200)).toBe(false);
    expect(surviving.record(response(1), at, 200)).toBe(true);
    expect(cache.get(identity, at)[0]?.remaining).toBe(1);
  });
  test("newer send sequences win, even when an older response arrives later", () => {
    const cache = new PassiveKeyLimitCache();
    expect(cache.record(identity, response(7), at, 2, 200)).toBe(true);
    expect(cache.record(identity, response(2), at + 50, 1, 200)).toBe(false);
    expect(cache.record(identity, response(1), at + 50, 2, 200)).toBe(false);
    expect(cache.get(identity, at + 100)).toEqual([{ dimension: "requests", observedAt: at, remaining: 7, resetAt: at + 10000, stale: false }, { dimension: "tokens", observedAt: at, stale: false }]);
  });
  test("headerless responses never replace or fence a measured reading", () => {
    const cache = new PassiveKeyLimitCache();
    expect(cache.record(identity, headers({}), at, 5, 200)).toBe(true);
    expect(cache.get(identity, at)).toEqual([{ dimension: "requests", observedAt: at, stale: false }, { dimension: "tokens", observedAt: at, stale: false }]);
    expect(cache.record(identity, response(1), at, 4, 200)).toBe(true);
    expect(cache.record(identity, response(8), at, 6, 200)).toBe(true);
    expect(cache.record(identity, headers({}), at, 9, 200)).toBe(false);
    // The unreadable response advanced nothing, so the fence still rejects a send from before
    // the measurement it would have overwritten.
    expect(cache.record(identity, response(1), at, 5, 200)).toBe(false);
    expect(cache.get(identity, at)[0]?.remaining).toBe(8);
  });
  test("expired rows are stale and missing resets live only for retention", () => {
    const cache = new PassiveKeyLimitCache({ retentionMs: 20000 });
    cache.record(identity, headers({ "x-ratelimit-remaining-requests": "5", "x-ratelimit-reset-requests": "1s", "x-ratelimit-remaining-tokens": "10" }), at, 1, 200);
    expect(cache.get(identity, at + 1000)).toEqual([
      { dimension: "requests", observedAt: at, remaining: 5, resetAt: at + 1000, stale: true },
      { dimension: "tokens", observedAt: at, remaining: 10, stale: false },
    ]);
    const fresh = new PassiveKeyLimitCache({ retentionMs: 20000 });
    fresh.record(identity, headers({ "x-ratelimit-remaining-requests": "5", "x-ratelimit-reset-requests": "1s", "x-ratelimit-remaining-tokens": "10" }), at, 1, 200);
    expect(fresh.get(identity, at + 999)).toEqual([
      { dimension: "requests", observedAt: at, remaining: 5, resetAt: at + 1000, stale: false },
      { dimension: "tokens", observedAt: at, remaining: 10, stale: false },
    ]);
    expect(cache.get(identity, at + 19999)[0]?.stale).toBe(true);
    expect(cache.get(identity, at + 20000)).toEqual([]);
  });
  test("idle observations are removed after retention without another cache access", async () => {
    const cache = new PassiveKeyLimitCache({ retentionMs: 10 });
    cache.record(identity, headers({ "x-ratelimit-remaining-requests": "5" }), at, 1, 200);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(cache.get(identity, at)).toEqual([]);
    expect(cache.record(identity, response(1), at, 1, 200)).toBe(false);
  });
  test("isolates owner, provider and bounded models and evicts least recently used entries", () => {
    const cache = new PassiveKeyLimitCache({ maxEntries: 2 });
    const b = { ...identity, model: "model-b" }, c = { ...identity, owner: "opaque-owner-b" };
    cache.record(identity, response(1), at, 1, 200); cache.record(b, response(2), at, 1, 200);
    cache.get(identity, at); cache.record(c, response(3), at, 1, 200);
    expect(cache.get({ ...identity, home: "/fixture/home-b" }, at)).toEqual([]);
    expect(cache.get(b, at)).toEqual([]);
    expect(cache.get(identity, at)[0]?.remaining).toBe(1);
    expect(cache.get({ ...identity, provider: "groq" }, at)).toEqual([]);
    expect(cache.record({ ...identity, model: "x".repeat(129) }, response(9), at, 1, 200)).toBe(false);
    expect(cache.record({ ...identity, model: "../unsafe model" }, response(9), at, 1, 200)).toBe(false);
  });
  test("returned values cannot mutate the retained observation", () => {
    const cache = new PassiveKeyLimitCache();
    cache.record(identity, response(5), at, 1, 200);
    const rows = cache.get(identity, at);
    rows[0]!.remaining = 0;
    expect(cache.get(identity, at)[0]?.remaining).toBe(5);
  });
  test("enumerates models only for the selected credential and provider", () => {
    const cache = new PassiveKeyLimitCache();
    cache.record(identity, response(5), at, 1, 200);
    cache.record({ ...identity, model: "model-b" }, response(2), at, 2, 200);
    cache.record({ ...identity, owner: "other" }, response(9), at, 3, 200);
    expect(cache.list(home, identity.owner, identity.provider, at)).toEqual([
      { model: identity.model, windows: [{ dimension: "requests", observedAt: at, remaining: 5, resetAt: at + 10000, stale: false }, { dimension: "tokens", observedAt: at, stale: false }] },
      { model: "model-b", windows: [{ dimension: "requests", observedAt: at, remaining: 2, resetAt: at + 10000, stale: false }, { dimension: "tokens", observedAt: at, stale: false }] },
    ]);
    expect(cache.list("/fixture/home-b", identity.owner, identity.provider, at)).toEqual([]);
  });
  test("invalid bounds, sequence, timestamps and empty observations cannot replace data", () => {
    expect(() => new PassiveKeyLimitCache({ maxEntries: 513 })).toThrow();
    expect(() => new PassiveKeyLimitCache({ retentionMs: 86400001 })).toThrow();
    const cache = new PassiveKeyLimitCache();
    expect(cache.record(identity, response(1), at, 1, 200)).toBe(true);
    expect(cache.record(identity, headers({}), at, 2, 200)).toBe(false);
    expect(cache.record(identity, response(2), at, -1, 200)).toBe(false);
    expect(cache.record(identity, response(2), NaN, 2, 200)).toBe(false);
    expect(cache.get(identity, at)[0]?.remaining).toBe(1);
  });

  // The credential alone does not name a counter: the same provider and API key can be
  // configured in two installations. Home B must not see, replace, or retire home A's rows.
  test("the same account in another config home never observes or retires this home's rows", () => {
    const cache = new PassiveKeyLimitCache();
    const homeB = "/fixture/home-b", identityB = { ...identity, home: homeB };
    expect(cache.record(identity, response(5), at, 1, 200)).toBe(true);
    expect(cache.get(identityB, at)).toEqual([]);
    expect(cache.list(homeB, identity.owner, identity.provider, at)).toEqual([]);
    // A newer sequence in home B is written to home B only.
    expect(cache.record(identityB, response(2), at + 10, 2, 200)).toBe(true);
    expect(cache.get(identity, at + 10)[0]?.remaining).toBe(5);
    expect(cache.get(identityB, at + 10)[0]?.remaining).toBe(2);
    // Invalidating home B leaves home A's observation, and vice versa.
    cache.clear(homeB);
    expect(cache.get(identityB, at + 10)).toEqual([]);
    expect(cache.get(identity, at + 10)[0]?.remaining).toBe(5);
    cache.clear(identity.home);
    expect(cache.get(identity, at + 10)).toEqual([]);
  });

  test("clearing a sibling home keeps this home's outstanding reservation valid", () => {
    const cache = new PassiveKeyLimitCache();
    const reservation = cache.reserve(identity, 1)!;
    expect(cache.reserve({ ...identity, home: "/fixture/home-b" }, 2)!.record(response(9), at, 200)).toBe(true);
    cache.clear("/fixture/home-b");
    expect(reservation.record(response(4), at, 200)).toBe(true);
    expect(cache.get(identity, at)[0]?.remaining).toBe(4);
  });

  test("a newer headerless 302 cannot suppress an older real response", () => {
    const cache = new PassiveKeyLimitCache();
    const older = cache.reserve(identity, 1)!;
    const newer = cache.reserve(identity, 2)!;
    expect(newer.record(headers({ location: "https://elsewhere.example/v1" }), at, 302)).toBe(false);
    expect(older.record(response(6), at + 5, 200)).toBe(true);
    expect(cache.get(identity, at + 5)[0]?.remaining).toBe(6);
  });

  test("a 429 refusal still publishes its remaining count while redirects never do", () => {
    const cache = new PassiveKeyLimitCache();
    expect(cache.record(identity, response(0), at, 1, 429)).toBe(true);
    expect(cache.get(identity, at)[0]?.remaining).toBe(0);
    expect(cache.record({ ...identity, model: "redirected" }, response(0), at, 2, 307)).toBe(false);
    expect(cache.get({ ...identity, model: "redirected" }, at)).toEqual([]);
  });
});

test("first headerless response shows unknown without fencing an older numeric response", () => {
  const cache = new PassiveKeyLimitCache({ retentionMs: 1000 });
  const older = cache.reserve(identity, 1)!;
  const newer = cache.reserve(identity, 2)!;
  expect(newer.record(headers({}), at, 200)).toBe(true);
  expect(cache.get(identity, at)).toEqual([
    { dimension: "requests", observedAt: at, stale: false },
    { dimension: "tokens", observedAt: at, stale: false },
  ]);
  expect(older.record(headers({ "x-ratelimit-remaining-requests": "4" }), at + 1, 429)).toBe(true);
  expect(cache.get(identity, at + 1)[0]?.remaining).toBe(4);
  expect(cache.get(identity, at + 1001)).toEqual([]);
  const redirected = { ...identity, model: "redirect-304" };
  expect(cache.record(redirected, headers({}), at, 3, 304)).toBe(false);
  expect(cache.get(redirected, at)).toEqual([]);
});
