import { describe, expect, it } from "bun:test";
import {
  clearAccountQuota,
  applyAccountQuotaFromUpstreamHeaders,
  getAccountQuota,
  parseUpstreamQuotaHeaders,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  updateAccountQuota,
} from "../../src/codex/quota";
import { codexPoolQuotaEvidence } from "../../src/routing/quota";

describe("retired and generic quota partial updates", () => {
  it.each([1, 1000])("legacy quota updates expire short reset units (divisor %s)", divisor => {
    clearAccountQuota();
    setAccountQuotaFromParsed("legacy-expiry", { shortPercent: 4,
      shortResetAt: (Date.now() - 60_000) / divisor, shortWindowSeconds: 18_000 });
    updateAccountQuota("legacy-expiry", 29);
    expect(getAccountQuota("legacy-expiry")).toEqual({ weeklyPercent: 29, updatedAt: expect.any(Number) });
  });

  it("drops WHAM Spark windows while ordinary headers still update standard quota", () => {
    clearAccountQuota();
    const refreshed = parseUsageQuota({
      rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604_800 } },
      additional_rate_limits: [{
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: { primary_window: { used_percent: 30, reset_at: 2_000_000_000, limit_window_seconds: 604_800 } },
      }],
    });
    setAccountQuotaFromParsed("spark-partial", refreshed);
    applyAccountQuotaFromUpstreamHeaders("spark-partial", new Headers({
      "x-codex-primary-used-percent": "21",
      "x-codex-primary-window-minutes": "10080",
    }));
    expect(getAccountQuota("spark-partial")?.weeklyPercent).toBe(21);
    expect(refreshed).toEqual({ weeklyPercent: 20 });
    expect(getAccountQuota("spark-partial")?.customWindows).toBeUndefined();
  });

  it("replaces custom windows when supplied, including an explicit empty list", () => {
    clearAccountQuota();
    setAccountQuotaFromParsed("spark-replace", {
      customWindows: [{ label: "Custom weekly", percent: 30 }],
    });
    const replacement = [{ label: "Custom weekly", percent: 0, resetAt: 2_000_000_000 }];
    setAccountQuotaFromParsed("spark-replace", { customWindows: replacement });
    expect(getAccountQuota("spark-replace")?.customWindows).toEqual(replacement);
    setAccountQuotaFromParsed("spark-replace", { weeklyPercent: 21, customWindows: [] });
    expect(getAccountQuota("spark-replace")?.customWindows).toEqual([]);
  });

  it("does not carry custom windows across an account cache clear", () => {
    clearAccountQuota();
    setAccountQuotaFromParsed("spark-clear", {
      customWindows: [{ label: "Custom weekly", percent: 30 }],
    });
    clearAccountQuota("spark-clear");
    setAccountQuotaFromParsed("spark-clear", { weeklyPercent: 21 });
    expect(getAccountQuota("spark-clear")?.customWindows).toBeUndefined();
  });
});

describe("retired Spark response headers cannot supply account quota", () => {
  const SPARK_HEADERS = {
    "x-codex-primary-used-percent": "4",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1788974652",
    "x-codex-secondary-used-percent": "21",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1789436116",
  } as const;

  it.each(["gpt-5.3-codex-spark", "main/gpt-5.3-codex-spark", "openai/gpt-5.3-codex-spark"])(
    "ignores every standard header on retired model %s", modelId => {
    clearAccountQuota();
    applyAccountQuotaFromUpstreamHeaders("spark-attr", new Headers(SPARK_HEADERS), undefined, undefined, { modelId });
    const quota = getAccountQuota("spark-attr");
    expect(quota?.shortPercent).toBeUndefined();
    expect(quota?.shortResetAt).toBeUndefined();
    expect(quota?.shortWindowSeconds).toBeUndefined();
    expect(quota).toBeNull();
  });

  it("preserves ordinary quota when retired headers follow mixed legacy evidence", () => {
    clearAccountQuota();
    setAccountQuotaFromParsed("spark-merge", {
      weeklyPercent: 9,
      customWindows: [
        { label: "GPT-5.3-Codex-Spark 5h", percent: 2, resetAt: 1788970000 },
        { label: "GPT-5.3-Codex-Spark Weekly", percent: 1, resetAt: 1789560000 },
      ],
    });
    applyAccountQuotaFromUpstreamHeaders("spark-merge", new Headers(SPARK_HEADERS), undefined, undefined, {
      modelId: "gpt-5.3-codex-spark",
    });
    expect(getAccountQuota("spark-merge")?.customWindows).toBeUndefined();
    expect(getAccountQuota("spark-merge")?.weeklyPercent).toBe(9);
  });

  it("ignores retired family headers while preserving mixed ordinary headers", () => {
    const headers = new Headers({
      "x-codex-bengalfox-primary-used-percent": "100",
      "x-codex-bengalfox-primary-window-minutes": "300",
      "x-codex-bengalfox-primary-reset-at": "2000000000",
    });
    expect(parseUpstreamQuotaHeaders(headers)).toBeNull();
    headers.set("x-codex-primary-used-percent", "17");
    headers.set("x-codex-primary-window-minutes", "10080");
    expect(parseUpstreamQuotaHeaders(headers)).toEqual({ weeklyPercent: 17 });
    // The tombstone is exact; unrelated future/native and vendor names keep generic parsing.
    expect(parseUpstreamQuotaHeaders(headers, { modelId: "muse-spark-1.3" })).toEqual({ weeklyPercent: 17 });
  });

  it("still writes the account-level short slot for a genuine 5h primary on a non-Spark model", () => {
    clearAccountQuota();
    applyAccountQuotaFromUpstreamHeaders("genuine-5h", new Headers({
      "x-codex-primary-used-percent": "97",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-used-percent": "12",
      "x-codex-secondary-window-minutes": "10080",
    }), undefined, undefined, { modelId: "gpt-5.6-sol" });
    const quota = getAccountQuota("genuine-5h");
    expect(quota?.shortPercent).toBe(97);
    expect(quota?.shortWindowSeconds).toBe(18_000);
    expect(quota?.weeklyPercent).toBe(12);
    expect(quota?.customWindows).toBeUndefined();
  });

  it("legacy callers without a routed model keep the previous account-level behavior", () => {
    clearAccountQuota();
    applyAccountQuotaFromUpstreamHeaders("legacy-5h", new Headers({
      "x-codex-primary-used-percent": "97",
      "x-codex-primary-window-minutes": "300",
    }));
    expect(getAccountQuota("legacy-5h")?.shortPercent).toBe(97);
    expect(getAccountQuota("legacy-5h")?.shortWindowSeconds).toBe(18_000);
  });

  it("a retired-model header refresh is inert and cannot fabricate custom windows", () => {
    // #4122 stopped new Spark writes into short*. Retirement goes further: the retired model is
    // refused at the parser, so its response cannot write, drop or relabel anything. The elapsed
    // short tuple below is left for the next genuine refresh to expire, covered by the
    // weekly-only case that follows.
    clearAccountQuota();
    setAccountQuotaFromParsed("spark-stale", {
      weeklyPercent: 29,
      weeklyResetAt: 1789436116,
      shortPercent: 4,
      shortObservedAt: 1788956674678,
      shortResetAt: 1788974652,
      shortWindowSeconds: 18_000,
    });
    const before = getAccountQuota("spark-stale");
    applyAccountQuotaFromUpstreamHeaders("spark-stale", new Headers(SPARK_HEADERS), undefined, undefined, {
      modelId: "gpt-5.3-codex-spark",
    });
    const quota = getAccountQuota("spark-stale");
    // Nothing moves, including `updatedAt`: a retired refresh must not renew the disk TTL either.
    expect(quota).toEqual(before);
    expect(quota?.weeklyPercent).toBe(29);
    expect(quota?.customWindows).toBeUndefined();
  });

  it("drops an elapsed account-level short tuple on a WHAM weekly refresh carrying retired limits", () => {
    // Live path for the 2026-09-12 Pro row: WHAM reports weekly primary + Spark additional
    // limits and never rewrites shortObservedAt, so merge must drop the elapsed carry.
    clearAccountQuota();
    setAccountQuotaFromParsed("wham-stale", {
      weeklyPercent: 29,
      shortPercent: 4,
      shortObservedAt: 1788956674678,
      shortResetAt: 1788974652,
      shortWindowSeconds: 18_000,
    });
    const refreshed = parseUsageQuota({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 29, limit_window_seconds: 604_800, reset_at: 1789436116 } },
      additional_rate_limits: [{
        metered_feature: "codex_bengalfox",
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: {
          primary_window: { used_percent: 0, reset_at: 1789200311, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 2, reset_at: 1789561452, limit_window_seconds: 604_800 },
        },
      }],
    });
    setAccountQuotaFromParsed("wham-stale", refreshed);
    const quota = getAccountQuota("wham-stale");
    expect(quota?.shortPercent).toBeUndefined();
    expect(quota?.shortResetAt).toBeUndefined();
    expect(quota?.shortObservedAt).toBeUndefined();
    expect(quota?.shortWindowSeconds).toBeUndefined();
    expect(quota?.weeklyPercent).toBe(29);
    expect(quota?.customWindows).toBeUndefined();
  });

  it("drops an elapsed account-level short tuple on a weekly-only refresh", () => {
    clearAccountQuota();
    const elapsedSec = Math.floor(Date.now() / 1000) - 60;
    setAccountQuotaFromParsed("pro-stale", {
      weeklyPercent: 29,
      shortPercent: 4,
      shortObservedAt: Date.now() - 3 * 60 * 60_000,
      shortResetAt: elapsedSec,
      shortWindowSeconds: 18_000,
    });
    applyAccountQuotaFromUpstreamHeaders("pro-stale", new Headers({
      "x-codex-primary-used-percent": "31",
      "x-codex-primary-window-minutes": "10080",
    }));
    const quota = getAccountQuota("pro-stale");
    expect(quota?.shortPercent).toBeUndefined();
    expect(quota?.shortResetAt).toBeUndefined();
    expect(quota?.shortWindowSeconds).toBeUndefined();
    expect(quota?.weeklyPercent).toBe(31);
  });

  it("keeps a still-open account-level short window across a weekly-only refresh", () => {
    clearAccountQuota();
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    setAccountQuotaFromParsed("plus-live", {
      weeklyPercent: 4,
      shortPercent: 0,
      shortObservedAt: Date.now(),
      shortResetAt: futureSec,
      shortWindowSeconds: 18_000,
    });
    applyAccountQuotaFromUpstreamHeaders("plus-live", new Headers({
      "x-codex-primary-used-percent": "5",
      "x-codex-primary-window-minutes": "10080",
    }));
    const quota = getAccountQuota("plus-live");
    expect(quota?.shortPercent).toBe(0);
    expect(quota?.shortResetAt).toBe(futureSec);
    expect(quota?.shortWindowSeconds).toBe(18_000);
    expect(quota?.weeklyPercent).toBe(5);
  });

  it("still stores an explicit incoming short tuple even when its reset is already elapsed", () => {
    clearAccountQuota();
    const elapsedSec = Math.floor(Date.now() / 1000) - 60;
    setAccountQuotaFromParsed("incoming-elapsed", {
      shortPercent: 100,
      shortResetAt: elapsedSec,
      shortWindowSeconds: 18_000,
    });
    const quota = getAccountQuota("incoming-elapsed");
    expect(quota?.shortPercent).toBe(100);
    expect(quota?.shortResetAt).toBe(elapsedSec);
    expect(quota?.shortWindowSeconds).toBe(18_000);
  });

  it("drops an elapsed short tuple on a credits-only update", () => {
    clearAccountQuota();
    const elapsedSec = Math.floor(Date.now() / 1000) - 60;
    setAccountQuotaFromParsed("credits-stale", {
      weeklyPercent: 29,
      shortPercent: 4,
      shortObservedAt: Date.now() - 3 * 60 * 60_000,
      shortResetAt: elapsedSec,
      shortWindowSeconds: 18_000,
    });
    setAccountQuotaFromParsed("credits-stale", { resetCredits: 2 });
    const quota = getAccountQuota("credits-stale");
    expect(quota?.shortPercent).toBeUndefined();
    expect(quota?.shortResetAt).toBeUndefined();
    expect(quota?.shortWindowSeconds).toBeUndefined();
    expect(quota?.weeklyPercent).toBe(29);
    expect(quota?.resetCredits).toBe(2);
  });
});

/**
 * The two quota parsers, pinned against each other.
 *
 * Codex reports the same account state twice: as response headers on every request, and as a
 * WHAM usage payload on refresh. `parseUsageQuota` classified windows by DURATION from the
 * start; `parseUpstreamQuotaHeaders` only knew "explicitly monthly, or else weekly". While
 * Codex had no 5-hour window that difference was invisible. When the window came back for Plus
 * and Team, the header path started filing a 5h reading as the weekly one, discarding the real
 * weekly value and leaving the account exhausted long after the burst reset.
 *
 * This is the assertion that would have caught it: the parsers must agree about WHICH WINDOW a
 * number belongs to, whichever wire it arrived on. It compares window assignment rather than
 * whole objects, because the WHAM payload also carries provenance the header
 * wire does not.
 */
describe("quota parser parity: headers and WHAM agree on window assignment", () => {
  const cases = [
    { name: "Plus/Team 5h burst + 7-day weekly", minutes: 300, seconds: 18_000, primary: 97, secondary: 12 },
    { name: "Pro weekly-only", minutes: 10_080, seconds: 604_800, primary: 80, secondary: undefined },
    { name: "monthly plan with a weekly secondary", minutes: 43_800, seconds: 2_628_000, primary: 100, secondary: 22 },
    { name: "sub-hour burst", minutes: 15, seconds: 900, primary: 40, secondary: 5 },
  ] as const;

  /** Which field each percent landed in — the only thing both wires can be compared on. */
  function assignment(quota: Record<string, unknown> | null): Record<string, unknown> {
    return {
      shortPercent: quota?.shortPercent,
      weeklyPercent: quota?.weeklyPercent,
      monthlyPercent: quota?.monthlyPercent,
    };
  }

  for (const testCase of cases) {
    it(`agrees on ${testCase.name}`, () => {
      const headers = new Headers({
        "x-codex-primary-used-percent": String(testCase.primary),
        "x-codex-primary-window-minutes": String(testCase.minutes),
        ...(testCase.secondary !== undefined
          ? {
              "x-codex-secondary-used-percent": String(testCase.secondary),
              "x-codex-secondary-window-minutes": "10080",
            }
          : {}),
      });
      const wham = parseUsageQuota({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: testCase.primary, limit_window_seconds: testCase.seconds },
          ...(testCase.secondary !== undefined
            ? { secondary_window: { used_percent: testCase.secondary, limit_window_seconds: 604_800 } }
            : {}),
        },
      });

      expect(assignment(parseUpstreamQuotaHeaders(headers) as Record<string, unknown>))
        .toEqual(assignment(wham as Record<string, unknown>));
    });
  }

  it("the burst duration survives the header round trip in seconds", () => {
    // The header wire speaks minutes and the stored field is seconds; a unit slip here would be
    // silent, since both numbers are plausible durations.
    const quota = parseUpstreamQuotaHeaders(new Headers({
      "x-codex-primary-used-percent": "50",
      "x-codex-primary-window-minutes": "300",
    }));
    expect(quota?.shortWindowSeconds).toBe(18_000);
  });
});

/**
 * The regression the parser fix would otherwise have introduced.
 *
 * `codexAccountQuotaEvidence` scored headroom from weekly and monthly only. That was survivable
 * while the broken parser wrote 5h readings into `weeklyPercent` — routing saw the burst by
 * accident. Correcting the parser without this fold would take a 5h-exhausted account from 3%
 * headroom to 88% and route straight into a 429.
 */
describe("routing headroom accounts for the burst window", () => {
  it("a 5h-exhausted account keeps low headroom despite a healthy weekly", () => {
    clearAccountQuota();
    setAccountQuotaFromParsed("burst-acct", { shortPercent: 97, weeklyPercent: 12 });
    const evidence = codexPoolQuotaEvidence([{ accountId: "burst-acct", plan: "plus" }]);
    expect(evidence.known).toBe(true);
    expect(evidence.headroom).toBeLessThanOrEqual(0.05);
  });

  it("a fully exhausted burst window reports exhausted", () => {
    clearAccountQuota();
    setAccountQuotaFromParsed("burst-dead", { shortPercent: 100, weeklyPercent: 8 });
    const evidence = codexPoolQuotaEvidence([{ accountId: "burst-dead", plan: "plus" }]);
    expect(evidence.exhausted).toBe(true);
  });

  it("a healthy burst window does not suppress a real weekly limit", () => {
    // The fold must not invert: the maximum still governs, so a near-full weekly still bites.
    clearAccountQuota();
    setAccountQuotaFromParsed("weekly-bound", { shortPercent: 3, weeklyPercent: 96 });
    const evidence = codexPoolQuotaEvidence([{ accountId: "weekly-bound", plan: "plus" }]);
    expect(evidence.headroom).toBeLessThanOrEqual(0.05);
  });
});
