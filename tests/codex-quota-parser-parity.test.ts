import { describe, expect, it } from "bun:test";
import {
  clearAccountQuota,
  parseUpstreamQuotaHeaders,
  parseUsageQuota,
  setAccountQuotaFromParsed,
} from "../src/codex/quota";
import { codexPoolQuotaEvidence } from "../src/routing/quota";

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

