import { describe, expect, test } from "bun:test";
import {
  barWidth,
  buildQuotaRows,
  formatResetFuture,
  isCustomQuotaWindowIncomplete,
  isQuotaExhausted,
  isQuotaWarn,
  maxQuotaUtilisation,
  quotaBarTone,
} from "../../gui/src/components/QuotaBars";
import { quotaAutoRefreshAvailability, type AccountQuota } from "../../gui/src/codex-quota-utils";
import type { TFn } from "../../gui/src/i18n";

/** Key-echoing translator: rows carry their key so ordering is assertable. */
const t: TFn = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key) as TFn;

function quota(overrides: Partial<AccountQuota>): AccountQuota {
  return { updatedAt: 0, ...overrides };
}

describe("buildQuotaRows (WP070)", () => {
  test("five-hour-only and weekly-only render single rows", () => {
    expect(buildQuotaRows(quota({ fiveHourPercent: 12 }), null, t).map(r => r.limitLabel))
      .toEqual(["quota.fiveHourLimit"]);
    expect(buildQuotaRows(quota({ weeklyPercent: 30 }), null, t).map(r => r.limitLabel))
      .toEqual(["quota.weeklyLimit"]);
  });

  test("dual and mixed windows order by RAW identity: 5h, weekly, cursor pools, monthly", () => {
    const rows = buildQuotaRows(quota({
      monthlyPercent: 70,
      weeklyPercent: 40,
      fiveHourPercent: 10,
      customWindows: [
        { label: "API usage", percent: 55 },
        { label: "First-party models", percent: 25 },
      ],
    }), null, t);
    expect(rows.map(r => r.limitLabel)).toEqual([
      "quota.fiveHourLimit",
      "quota.weeklyLimit",
      "quota.cursorFirstParty",
      "quota.cursorApiUsage",
      "quota.monthlyLimit",
    ]);
  });

  test("anthropic's raw 5h custom window ranks first even against standard weekly", () => {
    const rows = buildQuotaRows(quota({
      weeklyPercent: 40,
      customWindows: [{ label: "5h", percent: 10 }],
    }), null, t);
    expect(rows.map(r => r.label)).toEqual(["5h", "codexAuth.weekly"]);
  });

  test("unknown custom labels keep their raw text and sort last", () => {
    const rows = buildQuotaRows(quota({
      monthlyPercent: 5,
      customWindows: [{ label: "Gem", percent: 1 }],
    }), null, t);
    expect(rows.map(r => r.label)).toEqual(["codexAuth.monthly", "Gem"]);
  });

  test("Kimi total subscription credits use the localized quota label", () => {
    const rows = buildQuotaRows(quota({
      customWindows: [{ label: "Total subscription credits", percent: 1 }],
    }), null, t);
    expect(rows.map(r => r.label)).toEqual(["quota.totalSubscriptionCredits"]);
  });

  test("direct creditsUsd renders Total subscription credits with resetAt", () => {
    const reported = quota({
      creditsUsd: { used: 89.96, limit: 90, remaining: 0.04, percent: 99.96, expiresAt: 1790430938000 },
    });
    expect(buildQuotaRows(reported, null, t)).toEqual([{
      customLabel: "Total subscription credits",
      label: "quota.totalSubscriptionCredits",
      limitLabel: "quota.totalSubscriptionCredits",
      percent: 99.96,
      resetAt: 1790430938000,
    }]);
    expect(maxQuotaUtilisation(reported)).toBe(99.96);
  });

  test("zero direct credit usage remains a row without an invented expiry", () => {
    const reported = quota({
      creditsUsd: { used: 0, limit: 100, remaining: 100, percent: 0 },
    });
    const rows = buildQuotaRows(reported, null, t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.customLabel).toBe("Total subscription credits");
    expect(rows[0]?.percent).toBe(0);
    expect(rows[0]?.resetAt).toBeUndefined();
    expect(maxQuotaUtilisation(reported)).toBe(0);
  });

  test("subscription credits rank after monthly and before other custom windows", () => {
    const rows = buildQuotaRows(quota({
      fiveHourPercent: 10,
      weeklyPercent: 40,
      monthlyPercent: 70,
      customWindows: [
        { label: "Gem", percent: 1 },
        { label: "API usage", percent: 55 },
        { label: "First-party models", percent: 25 },
      ],
      creditsUsd: { used: 80, limit: 100, remaining: 20, percent: 80 },
    }), null, t);
    expect(rows.map(r => r.limitLabel)).toEqual([
      "quota.fiveHourLimit",
      "quota.weeklyLimit",
      "quota.cursorFirstParty",
      "quota.cursorApiUsage",
      "quota.monthlyLimit",
      "quota.totalSubscriptionCredits",
      "Gem",
    ]);
  });

  test.each(["Total subscription credits", "  TOTAL SUBSCRIPTION CREDITS  "])(
    "direct creditsUsd does not duplicate the canonical custom window: %s",
    label => {
      const customOnly = quota({ customWindows: [{ label, percent: 25, resetAt: 1790430938000 }] });
      const withDirect = quota({
        ...customOnly,
        creditsUsd: { used: 99, limit: 100, remaining: 1, percent: 99, expiresAt: 1790517338000 },
      });
      for (const reported of [customOnly, withDirect]) {
        expect(buildQuotaRows(reported, null, t)).toEqual([{
          customLabel: "Total subscription credits",
          label: "quota.totalSubscriptionCredits",
          limitLabel: "quota.totalSubscriptionCredits",
          percent: 25,
          resetAt: 1790430938000,
        }]);
      }
    },
  );

  test("unrelated credit windows keep their raw identity and do not suppress direct credits", () => {
    const reported = quota({
      customWindows: [
        { label: "API credits", percent: 20 },
        { label: "  Gem  ", percent: 10 },
      ],
      creditsUsd: { used: 50, limit: 100, remaining: 50, percent: 50 },
    });
    const rows = buildQuotaRows(reported, null, t);
    expect(rows.map(r => r.label)).toEqual(["quota.totalSubscriptionCredits", "API credits", "  Gem  "]);
    expect(rows.map(r => r.customLabel)).toEqual(["Total subscription credits", "API credits", "  Gem  "]);
    expect(maxQuotaUtilisation(reported)).toBe(50);
  });

  test.each(["go", "free"])("30-day plan %s retains direct credits after normalization", plan => {
    const rows = buildQuotaRows(quota({
      shortPercent: 10,
      shortWindowSeconds: 5 * 60 * 60,
      weeklyPercent: 30,
      monthlyPercent: 60,
      customWindows: [{ label: "Total subscription credits", percent: 99 }],
      creditsUsd: { used: 80, limit: 100, remaining: 20, percent: 80 },
    }), plan, t);
    expect(rows.map(r => r.limitLabel)).toEqual(["quota.monthlyLimit", "quota.totalSubscriptionCredits"]);
    expect(rows.map(r => r.percent)).toEqual([60, 80]);
  });

  test("null and empty quotas produce no rows; 30-day plans strip to monthly", () => {
    expect(buildQuotaRows(null, null, t)).toEqual([]);
    expect(buildQuotaRows(quota({}), null, t)).toEqual([]);
    const reported = quota({
      shortPercent: 10,
      shortResetAt: 1,
      shortWindowSeconds: 5 * 60 * 60,
      monthlyPercent: 60,
    });
    expect(quotaAutoRefreshAvailability(reported).fiveHourAvailable).toBe(true);
    const rows = buildQuotaRows(reported, "go", t);
    expect(rows.map(r => r.limitLabel)).toEqual(["quota.monthlyLimit"]);
  });
});

describe("maxQuotaUtilisation", () => {
  test("mixed, absent, and custom values", () => {
    expect(maxQuotaUtilisation(null)).toBe(-1);
    expect(maxQuotaUtilisation(quota({}))).toBe(-1);
    expect(maxQuotaUtilisation(quota({ weeklyPercent: 30, monthlyPercent: 80 }))).toBe(80);
    expect(maxQuotaUtilisation(quota({
      fiveHourPercent: 10,
      customWindows: [{ label: "x", percent: 95 }],
    }))).toBe(95);
    expect(maxQuotaUtilisation(quota({
      fiveHourPercent: 0,
      weeklyPercent: 0,
      creditsUsd: { used: 90, limit: 90, remaining: 0, percent: 100 },
    }))).toBe(100);
  });

  test.each(["Total subscription credits", " total subscription credits "])(
    "subscription-credit urgency follows the visible custom window: %s",
    label => {
      expect(maxQuotaUtilisation(quota({
        customWindows: [{ label, percent: 25 }],
        creditsUsd: { used: 99, limit: 100, remaining: 1, percent: 99 },
      }))).toBe(25);
    },
  );
});

describe("isCustomQuotaWindowIncomplete", () => {
  test("canonical subscription rows retain raw-label coverage metadata", () => {
    const rows = buildQuotaRows(quota({
      customWindows: [{ label: "  TOTAL SUBSCRIPTION CREDITS  ", percent: 25 }],
    }), null, t);
    expect(rows[0]?.customLabel).toBe("Total subscription credits");
    expect(isCustomQuotaWindowIncomplete(
      rows[0]?.customLabel,
      new Set(["API credits", "  TOTAL SUBSCRIPTION CREDITS  "]),
    )).toBe(true);
    expect(isCustomQuotaWindowIncomplete(
      " total subscription credits ",
      new Set(["Total subscription credits"]),
    )).toBe(true);
  });

  test("absent and unrelated coverage does not mark a subscription row incomplete", () => {
    expect(isCustomQuotaWindowIncomplete(undefined, new Set(["Total subscription credits"]))).toBe(false);
    expect(isCustomQuotaWindowIncomplete("Total subscription credits")).toBe(false);
    expect(isCustomQuotaWindowIncomplete("Total subscription credits", new Set())).toBe(false);
    expect(isCustomQuotaWindowIncomplete("Total subscription credits", new Set(["API credits"]))).toBe(false);
  });

  test("unknown window coverage preserves exact raw-label matching", () => {
    expect(isCustomQuotaWindowIncomplete("  Gem  ", new Set(["  Gem  "]))).toBe(true);
    expect(isCustomQuotaWindowIncomplete("  Gem  ", new Set(["Gem"]))).toBe(false);
    expect(isCustomQuotaWindowIncomplete("Gem", new Set(["gem"]))).toBe(false);
  });
});

describe("barWidth", () => {
  test("zero stays invisible; tiny usage clamps to the 4% visibility floor", () => {
    expect(barWidth(0)).toBe(0);
    expect(barWidth(-5)).toBe(0);
    expect(barWidth(1)).toBe(4);
    expect(barWidth(3.4)).toBe(4);
    expect(barWidth(50)).toBe(50);
    expect(barWidth(120)).toBe(100);
  });
});

describe("warn and exhaustion tones", () => {
  test("99.5 is the exhaustion boundary", () => {
    expect(isQuotaExhausted(99.4)).toBe(false);
    expect(isQuotaExhausted(99.5)).toBe(true);
    expect(isQuotaExhausted(100)).toBe(true);
  });

  test("threshold 0 disables warn entirely", () => {
    expect(isQuotaWarn(100, 0)).toBe(false);
    expect(isQuotaWarn(80, 80)).toBe(true);
    expect(isQuotaWarn(79.9, 80)).toBe(false);
  });

  test("bar tone: warn or exhausted flips to bar-warn; threshold 0 still flips at exhaustion", () => {
    expect(quotaBarTone(50, 80)).toBe("bar-green");
    expect(quotaBarTone(85, 80)).toBe("bar-warn");
    expect(quotaBarTone(99.5, 0)).toBe("bar-warn");
    expect(quotaBarTone(99.4, 0)).toBe("bar-green");
  });
});

describe("formatResetFuture", () => {
  // Fixed reference: 2026-07-17 12:00 local time.
  const NOW = new Date(2026, 6, 17, 12, 0, 0).getTime();

  test("branches: minutes, hours, today, tomorrow, date, date+year, past, invalid", () => {
    expect(formatResetFuture(NOW + 30 * 60_000, t, "en", NOW)).toBe("quota.resetsRelativeMinutes:30");
    expect(formatResetFuture(NOW + 3 * 3_600_000, t, "en", NOW)).toBe("quota.resetsRelativeHours:3");
    // Same calendar day but past the 12h relative window → today copy.
    const lateToday = new Date(2026, 6, 17, 23, 59).getTime();
    expect(formatResetFuture(lateToday, t, "en", NOW)).toContain("quota.resetsToday");
    const tomorrow = new Date(2026, 6, 18, 9, 0).getTime();
    expect(formatResetFuture(tomorrow, t, "en", NOW)).toContain("quota.resetsTomorrow");
    const nextWeek = new Date(2026, 6, 24, 9, 0).getTime();
    expect(formatResetFuture(nextWeek, t, "en", NOW)).toContain("quota.resetsAt");
    const nextYear = new Date(2027, 0, 2, 9, 0).getTime();
    const withYear = formatResetFuture(nextYear, t, "en", NOW);
    expect(withYear).toContain("quota.resetsAt");
    expect(withYear).toContain("2027");
    // Past dates fall back to the absolute form; invalid input is empty.
    expect(formatResetFuture(NOW - 86_400_000, t, "en", NOW)).toContain("quota.resetsAt");
    expect(formatResetFuture(undefined, t, "en", NOW)).toBe("");
    expect(formatResetFuture(Number.NaN, t, "en", NOW)).toBe("");
    expect(formatResetFuture(Number.MAX_VALUE, t, "en", NOW)).toBe("");
  });

  test("seconds-epoch inputs are normalized to milliseconds", () => {
    const secs = Math.floor((NOW + 30 * 60_000) / 1000);
    expect(formatResetFuture(secs, t, "en", NOW)).toBe("quota.resetsRelativeMinutes:30");
  });
});
