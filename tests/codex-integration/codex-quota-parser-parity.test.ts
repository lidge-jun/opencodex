import { describe, expect, it } from "bun:test";
import {
  clearAccountQuota,
  applyAccountQuotaFromUpstreamHeaders,
  getAccountQuota,
  parseUpstreamQuotaHeaders,
  parseUsageQuota,
  setAccountQuotaFromParsed,
} from "../../src/codex/quota";
import { codexPoolQuotaEvidence } from "../../src/routing/quota";

describe("Spark quota survives partial header updates", () => {
  it("keeps the WHAM Spark window when an ordinary response updates standard quota", () => {
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
    expect(getAccountQuota("spark-partial")?.customWindows).toEqual(refreshed?.customWindows);
  });

  it("replaces custom windows when supplied, including an explicit empty list", () => {
    clearAccountQuota();
    setAccountQuotaFromParsed("spark-replace", {
      customWindows: [{ label: "GPT-5.3-Codex-Spark Weekly", percent: 30 }],
    });
    const replacement = [{ label: "GPT-5.3-Codex-Spark Weekly", percent: 0, resetAt: 2_000_000_000 }];
    setAccountQuotaFromParsed("spark-replace", { customWindows: replacement });
    expect(getAccountQuota("spark-replace")?.customWindows).toEqual(replacement);
    setAccountQuotaFromParsed("spark-replace", { weeklyPercent: 21, customWindows: [] });
    expect(getAccountQuota("spark-replace")?.customWindows).toEqual([]);
  });

  it("does not carry custom windows across an account cache clear", () => {
    clearAccountQuota();
    setAccountQuotaFromParsed("spark-clear", {
      customWindows: [{ label: "GPT-5.3-Codex-Spark Weekly", percent: 30 }],
    });
    clearAccountQuota("spark-clear");
    setAccountQuotaFromParsed("spark-clear", { weeklyPercent: 21 });
    expect(getAccountQuota("spark-clear")?.customWindows).toBeUndefined();
  });
});

/**
 * #4122 — a Spark response's 5h primary window is the MODEL's limit, not the account's.
 *
 * The header path has the routed model at every call site; without it, a Spark 5h primary was
 * filed as the account-level short tuple, so one pool account showed a 5h bar its
 * identically-limited peers did not have, and account-policy readers (main-account hard lock,
 * five-hour auto-refresh) consumed a model-specific window. The weekly reading still arrives as
 * the secondary window on the same response.
 */
describe("Spark-model header responses attribute the 5h window to the model limit", () => {
  const SPARK_HEADERS = {
    "x-codex-primary-used-percent": "4",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1788974652",
    "x-codex-secondary-used-percent": "21",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1789436116",
  } as const;

  it("files a Spark response's 5h primary under custom windows, not the account short slot", () => {
    clearAccountQuota();
    applyAccountQuotaFromUpstreamHeaders("spark-attr", new Headers(SPARK_HEADERS), undefined, undefined, {
      modelId: "gpt-5.3-codex-spark",
    });
    const quota = getAccountQuota("spark-attr");
    expect(quota?.shortPercent).toBeUndefined();
    expect(quota?.shortResetAt).toBeUndefined();
    expect(quota?.shortWindowSeconds).toBeUndefined();
    expect(quota?.weeklyPercent).toBe(21);
    expect(quota?.customWindows).toEqual([{ label: "GPT-5.3-Codex-Spark 5h", percent: 4, resetAt: 1788974652 }]);
  });

  it("replaces the Spark 5h entry by label and keeps the WHAM-recorded Spark weekly entry", () => {
    clearAccountQuota();
    setAccountQuotaFromParsed("spark-merge", {
      customWindows: [
        { label: "GPT-5.3-Codex-Spark 5h", percent: 2, resetAt: 1788970000 },
        { label: "GPT-5.3-Codex-Spark Weekly", percent: 1, resetAt: 1789560000 },
      ],
    });
    applyAccountQuotaFromUpstreamHeaders("spark-merge", new Headers(SPARK_HEADERS), undefined, undefined, {
      modelId: "gpt-5.3-codex-spark",
    });
    expect(getAccountQuota("spark-merge")?.customWindows).toEqual([
      { label: "GPT-5.3-Codex-Spark 5h", percent: 4, resetAt: 1788974652 },
      { label: "GPT-5.3-Codex-Spark Weekly", percent: 1, resetAt: 1789560000 },
    ]);
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
 * whole objects, because the WHAM payload also carries provenance and Spark windows the header
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
