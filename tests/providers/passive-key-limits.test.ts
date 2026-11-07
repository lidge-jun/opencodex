import { describe, expect, test } from "bun:test";
import { parsePassiveKeyLimits, PassiveKeyLimitCache } from "../../src/providers/quota/passive-key-limits";

const at = Date.parse("2026-11-07T12:00:00Z");
const identity = { owner: "opaque-owner-a", provider: "openai" as const, model: "vendor/model-v1" };
const headers = (values: Record<string, string>) => new Headers(values);

describe("passive key limit parsing", () => {
  for (const provider of ["openai", "xai", "groq"] as const) {
    test(`${provider} preserves request and token counts and exact reset durations`, () => {
      expect(parsePassiveKeyLimits(provider, headers({
        "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1m2.250s", "x-ratelimit-limit-tokens": "9000",
        "x-ratelimit-remaining-tokens": "700", "x-ratelimit-reset-tokens": "750ms",
      }), at)).toEqual([
        { dimension: "requests", observedAt: at, limit: 100, remaining: 0, resetAt: at + 62250 },
        { dimension: "tokens", observedAt: at, limit: 9000, remaining: 700, resetAt: at + 750 },
      ]);
    });
  }
  test("untrusted malformed values stay unknown and durations cannot be rounded or overflow", () => {
    for (const reset of ["1.0001s", "1s junk", "-1s", "1e3s", "999999999999999999h", "1s1m", "1m1m", "31d"]) {
      expect(parsePassiveKeyLimits("openai", headers({ "x-ratelimit-limit-requests": "23", "x-ratelimit-reset-requests": reset }), at))
        .toEqual([{ dimension: "requests", observedAt: at, limit: 23 }]);
    }
    expect(parsePassiveKeyLimits("groq", headers({
      "x-ratelimit-limit-requests": "-1", "x-ratelimit-remaining-requests": "2e3",
      "x-ratelimit-limit-tokens": "1000000000001", "x-ratelimit-remaining-tokens": "NaN",
    }), at)).toEqual([]);
    expect(parsePassiveKeyLimits("openai", headers({ "x-ratelimit-remaining-requests": "3" }), at))
      .toEqual([{ dimension: "requests", observedAt: at, remaining: 3 }]);
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
  test("newer send sequences win, even when an older response arrives later", () => {
    const cache = new PassiveKeyLimitCache();
    expect(cache.record(identity, response(7), at, 2)).toBe(true);
    expect(cache.record(identity, response(2), at + 50, 1)).toBe(false);
    expect(cache.record(identity, response(1), at + 50, 2)).toBe(false);
    expect(cache.get(identity, at + 100)).toEqual([{ dimension: "requests", observedAt: at, remaining: 7, resetAt: at + 10000, stale: false }]);
  });
  test("empty newer responses fence earlier sends, including the first response", () => {
    const cache = new PassiveKeyLimitCache();
    expect(cache.record(identity, headers({}), at, 5)).toBe(false);
    expect(cache.record(identity, response(1), at, 4)).toBe(false);
    expect(cache.get(identity, at)).toEqual([]);
    expect(cache.record(identity, response(8), at, 6)).toBe(true);
    expect(cache.record(identity, headers({}), at, 9)).toBe(false);
    expect(cache.record(identity, response(1), at, 7)).toBe(false);
    expect(cache.get(identity, at)[0]?.remaining).toBe(8);
  });
  test("expired rows are stale and missing resets live only for retention", () => {
    const cache = new PassiveKeyLimitCache({ retentionMs: 20000 });
    cache.record(identity, headers({ "x-ratelimit-remaining-requests": "5", "x-ratelimit-reset-requests": "1s", "x-ratelimit-remaining-tokens": "10" }), at, 1);
    expect(cache.get(identity, at + 1000)).toEqual([
      { dimension: "requests", observedAt: at, remaining: 5, resetAt: at + 1000, stale: true },
      { dimension: "tokens", observedAt: at, remaining: 10, stale: false },
    ]);
    const fresh = new PassiveKeyLimitCache({ retentionMs: 20000 });
    fresh.record(identity, headers({ "x-ratelimit-remaining-requests": "5", "x-ratelimit-reset-requests": "1s", "x-ratelimit-remaining-tokens": "10" }), at, 1);
    expect(fresh.get(identity, at + 999)).toEqual([
      { dimension: "requests", observedAt: at, remaining: 5, resetAt: at + 1000, stale: false },
      { dimension: "tokens", observedAt: at, remaining: 10, stale: false },
    ]);
    expect(cache.get(identity, at + 19999)[0]?.stale).toBe(true);
    expect(cache.get(identity, at + 20000)).toEqual([]);
  });
  test("idle observations are removed after retention without another cache access", async () => {
    const cache = new PassiveKeyLimitCache({ retentionMs: 10 });
    cache.record(identity, headers({ "x-ratelimit-remaining-requests": "5" }), at, 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(cache.get(identity, at)).toEqual([]);
    expect(cache.record(identity, response(1), at, 1)).toBe(false);
  });
  test("isolates owner, provider and bounded models and evicts least recently used entries", () => {
    const cache = new PassiveKeyLimitCache({ maxEntries: 2 });
    const b = { ...identity, model: "model-b" }, c = { ...identity, owner: "opaque-owner-b" };
    cache.record(identity, response(1), at, 1); cache.record(b, response(2), at, 1);
    cache.get(identity, at); cache.record(c, response(3), at, 1);
    expect(cache.get(b, at)).toEqual([]);
    expect(cache.get(identity, at)[0]?.remaining).toBe(1);
    expect(cache.get({ ...identity, provider: "groq" }, at)).toEqual([]);
    expect(cache.record({ ...identity, model: "x".repeat(129) }, response(9), at, 1)).toBe(false);
    expect(cache.record({ ...identity, model: "../unsafe model" }, response(9), at, 1)).toBe(false);
  });
  test("returned values cannot mutate the retained observation", () => {
    const cache = new PassiveKeyLimitCache();
    cache.record(identity, response(5), at, 1);
    const rows = cache.get(identity, at);
    rows[0]!.remaining = 0;
    expect(cache.get(identity, at)[0]?.remaining).toBe(5);
  });
  test("invalid bounds, sequence, timestamps and empty observations cannot replace data", () => {
    expect(() => new PassiveKeyLimitCache({ maxEntries: 513 })).toThrow();
    expect(() => new PassiveKeyLimitCache({ retentionMs: 86400001 })).toThrow();
    const cache = new PassiveKeyLimitCache();
    expect(cache.record(identity, response(1), at, 1)).toBe(true);
    expect(cache.record(identity, headers({}), at, 2)).toBe(false);
    expect(cache.record(identity, response(2), at, -1)).toBe(false);
    expect(cache.record(identity, response(2), NaN, 2)).toBe(false);
    expect(cache.get(identity, at)[0]?.remaining).toBe(1);
  });
});
