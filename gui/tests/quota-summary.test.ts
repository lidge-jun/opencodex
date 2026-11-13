import { describe, expect, test } from "bun:test";
import { buildQuotaSummary, formatQuotaPercent, quotaSeverity } from "../src/quota-summary";
import { accountQuotaFromReport, freshQuotaReportsFromResponse } from "../src/provider-workspace/report";
import { parseWorkBuddyCredits } from "../../src/providers/workbuddy-credit-balance";

const now = Date.UTC(2026, 8, 23, 3);
const name = (provider: string) => provider;

describe("quota summary", () => {
  test("unknown Mistral budgets are listed without a fabricated percentage", () => {
    const reports = freshQuotaReportsFromResponse([{ provider: "mistral", updatedAt: now, quota: {
      updatedAt: now, unknownBudgetWindows: [{ label: "API budget (EDU)" }, { label: "Vibe budget (EDU)" }],
    } }], now);
    const row = buildQuotaSummary(reports, name)[0];
    expect(row?.headline.percent).toBeUndefined();
    expect(row?.windows.map(window => window.label)).toEqual(["API budget (EDU)", "Vibe budget (EDU)"]);
  });
  test("severity thresholds are 70% warn and 90% critical", () => {
    expect(quotaSeverity(undefined)).toBe("normal");
    expect(quotaSeverity(69.9)).toBe("normal");
    expect(quotaSeverity(70)).toBe("warn");
    expect(quotaSeverity(89.9)).toBe("warn");
    expect(quotaSeverity(90)).toBe("critical");
  });

  test("displayed percent never crosses a severity threshold the color has not reached", () => {
    expect([formatQuotaPercent(69.6), quotaSeverity(69.6)]).toEqual(["69%", "normal"]);
    expect([formatQuotaPercent(89.6), quotaSeverity(89.6)]).toEqual(["89%", "warn"]);
    expect([formatQuotaPercent(90), quotaSeverity(90)]).toEqual(["90%", "critical"]);
    expect(formatQuotaPercent(undefined)).toBe("-");
  });

  test("headline prefers weekly, then monthly, then 5h, then provider windows", () => {
    const reports = freshQuotaReportsFromResponse([
      { provider: "openai", label: "OpenAI", updatedAt: now, quota: { fiveHourPercent: 95, weeklyPercent: 31, weeklyResetAt: now + 3_600_000, updatedAt: now } },
      { provider: "claude", label: "Claude", updatedAt: now, quota: { fiveHourPercent: 12, monthlyPercent: 72, updatedAt: now } },
      { provider: "xai", updatedAt: now, quota: { fiveHourPercent: 40, updatedAt: now } },
      { provider: "gemini", label: "Google", updatedAt: now, quota: { customWindows: [{ label: "Daily", percent: 8 }], updatedAt: now } },
    ], now);
    const rows = buildQuotaSummary(reports, name);
    expect(rows.map(row => [row.label, row.headline.id, row.headline.percent, row.severity])).toEqual([
      ["OpenAI", "quota.weeklyLimit", 31, "normal"],
      ["Claude", "quota.monthlyLimit", 72, "warn"],
      ["xai", "quota.fiveHourLimit", 40, "normal"],
      ["Google", "Daily", 8, "normal"],
    ]);
    // Details keep every window, including the hotter 5h window hidden behind the weekly headline.
    expect(rows[0]!.windows.find(window => window.id === "quota.fiveHourLimit")?.severity).toBe("critical");
    expect(rows[0]!.windows.find(window => window.id === "quota.weeklyLimit")?.resetAt).toBe(now + 3_600_000);
  });

  test("providers without a measured window or with a stale probe are hidden", () => {
    const reports = freshQuotaReportsFromResponse([
      { provider: "empty", updatedAt: now, quota: {} },
      { provider: "stale", updatedAt: now - 60 * 60_000, quota: { weeklyPercent: 50, updatedAt: now } },
      { provider: "credits", updatedAt: now, quota: { creditsUsd: { used: 91, limit: 100, remaining: 9, percent: 91 }, updatedAt: now } },
    ], now);
    const rows = buildQuotaSummary(reports, name);
    expect(rows.map(row => [row.provider, row.headline.id, row.severity])).toEqual([
      ["credits", "quotaSummary.credits", "critical"],
    ]);
  });

  test("WorkBuddy shows unavailable credits neutrally, including frozen balance, without a reset", () => {
    const balance = (total: number, used: number, remaining: number, frozen = 0) => ({
      total, used, remaining, frozen, groups: [],
      expiring: { amount: 10, at: now + 3_600_000 },
    });
    const reports = freshQuotaReportsFromResponse([
      { provider: "workbuddy-ai", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(100, 75, 25) } },
      { provider: "frozen", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(100, 0, 0, 100) } },
      { provider: "fractional", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(9, 8.1, 9 - 8.1) } },
      { provider: "below", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(100, 89.4, 10.6) } },
      { provider: "close-below", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(100, 89.99999999999, 10.00000000001) } },
      { provider: "zero-total", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(0, 0, 0) } },
      { provider: "malformed", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: { total: 100, used: 0 } } },
    ], now);
    const rows = buildQuotaSummary(reports, name);
    expect(rows.map(row => [row.provider, row.headline.labelKey, row.headline.percent, row.severity])).toEqual([
      ["workbuddy-ai", "quotaSummary.creditsUnavailable", 75, "normal"],
      ["frozen", "quotaSummary.creditsUnavailable", 100, "normal"],
      ["fractional", "quotaSummary.creditsUnavailable", expect.any(Number), "normal"],
      ["below", "quotaSummary.creditsUnavailable", expect.any(Number), "normal"],
      ["close-below", "quotaSummary.creditsUnavailable", expect.any(Number), "normal"],
    ]);
    expect(formatQuotaPercent(rows[2]!.headline.percent)).toBe("90%");
    expect(formatQuotaPercent(rows[3]!.headline.percent)).toBe("89%");
    expect(formatQuotaPercent(rows[4]!.headline.percent)).toBe("90%");
    expect(rows[0]!.headline.resetAt).toBeUndefined();
  });

  test("summed decimal WorkBuddy packages display their exact integer percentage", () => {
    const workbuddyCredits = parseWorkBuddyCredits({ Packages: Array.from({ length: 54 }, () => ({
      CycleTotalCapacity: 0.91, CycleUsedCapacity: 0.819, CycleRemainCapacity: 0.091,
    })) });
    expect(workbuddyCredits).toBeDefined();
    const reports = freshQuotaReportsFromResponse([
      { provider: "workbuddy-ai", updatedAt: now, quota: { updatedAt: now, workbuddyCredits } },
    ], now);
    const [row] = buildQuotaSummary(reports, name);
    expect(formatQuotaPercent(row!.headline.percent)).toBe("90%");
  });

  test("summed WorkBuddy packages retain decimal half-percent and below-half distinctions", () => {
    const balance = (remaining: number) => parseWorkBuddyCredits({ Packages: Array.from({ length: 5 }, () => ({
      CycleTotalCapacity: 1, CycleUsedCapacity: 0, CycleRemainCapacity: remaining,
    })) });
    const reports = freshQuotaReportsFromResponse([
      { provider: "tie", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(0.935) } },
      { provider: "below", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(0.93500000001) } },
    ], now);
    expect(buildQuotaSummary(reports, name).map(row => formatQuotaPercent(row.headline.percent))).toEqual(["7%", "6%"]);
  });

  test("WorkBuddy rounds an exact half percent up and a smaller share down", () => {
    const balance = (total: number, remaining: number) => ({ total, used: 0, remaining, frozen: 0, groups: [] });
    const reports = freshQuotaReportsFromResponse([
      { provider: "tie", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(100, 93.5) } },
      { provider: "below", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(100, 93.50000000001) } },
      { provider: "decimal-tie", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(3, 2.955) } },
      { provider: "decimal-below", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(3, 2.9550000000001) } },
      { provider: "tiny", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(1e-300, 5e-301) } },
    ], now);
    expect(buildQuotaSummary(reports, name).map(row => formatQuotaPercent(row.headline.percent)))
      .toEqual(["7%", "6%", "2%", "1%", "50%"]);
  });

  test("contradictory WorkBuddy balances are omitted without hiding valid quota windows", () => {
    const balance = (remaining: number) => ({ total: 100, used: 2, remaining, frozen: 0, groups: [] });
    const reports = freshQuotaReportsFromResponse([
      { provider: "invalid", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(110) } },
      { provider: "mixed", updatedAt: now, quota: { updatedAt: now, weeklyPercent: 25, workbuddyCredits: balance(110) } },
      { provider: "roundoff", updatedAt: now, quota: { updatedAt: now, workbuddyCredits: balance(100 + 1e-12) } },
    ], now);
    const rows = buildQuotaSummary(reports, name);
    expect(rows.map(row => [row.provider, row.headline.percent])).toEqual([["mixed", 25], ["roundoff", 0]]);
    expect(rows[0]!.windows.map(window => window.labelKey)).toEqual(["quota.weeklyLimit"]);
  });

  test("critical credits override a noncritical headline, but not a critical one", () => {
    const credits = (percent: number) => ({ used: percent, limit: 100, remaining: 100 - percent, percent });
    const reports = freshQuotaReportsFromResponse([
      { provider: "exhausted", updatedAt: now, quota: { weeklyPercent: 7, creditsUsd: credits(100), updatedAt: now } },
      { provider: "threshold", updatedAt: now, quota: { weeklyPercent: 70, creditsUsd: credits(90), updatedAt: now } },
      { provider: "both", updatedAt: now, quota: { weeklyPercent: 95, creditsUsd: credits(100), updatedAt: now } },
      { provider: "normal", updatedAt: now, quota: { weeklyPercent: 7, creditsUsd: credits(50), updatedAt: now } },
    ], now);
    expect(buildQuotaSummary(reports, name).map(row => [row.provider, row.headline.labelKey, row.headline.percent, row.severity])).toEqual([
      ["exhausted", "quotaSummary.credits", 100, "critical"],
      ["threshold", "quotaSummary.credits", 90, "critical"],
      ["both", "quota.weeklyLimit", 95, "critical"],
      ["normal", "quota.weeklyLimit", 7, "normal"],
    ]);
  });

  test("a custom window named like credits remains distinct, with or without actual credits", () => {
    const customWindows = [{ label: "quotaSummary.credits", percent: 95 }];
    const reports = freshQuotaReportsFromResponse([
      { provider: "custom-only", updatedAt: now, quota: { weeklyPercent: 7, customWindows, updatedAt: now } },
      { provider: "with-credits", updatedAt: now, quota: { weeklyPercent: 7, customWindows, creditsUsd: { used: 90, limit: 100, remaining: 10, percent: 90 }, updatedAt: now } },
      { provider: "custom-fallback", updatedAt: now, quota: { customWindows, creditsUsd: { used: 90, limit: 100, remaining: 10, percent: 90 }, updatedAt: now } },
    ], now);
    const [customOnly, withCredits, customFallback] = buildQuotaSummary(reports, name);
    expect([customOnly!.headline.labelKey, customOnly!.headline.percent]).toEqual(["quota.weeklyLimit", 7]);
    expect([withCredits!.headline.labelKey, withCredits!.headline.percent]).toEqual(["quotaSummary.credits", 90]);
    expect([customFallback!.headline.label, customFallback!.headline.percent]).toEqual(["quotaSummary.credits", 95]);
    for (const row of [customOnly!, withCredits!, customFallback!]) {
      expect(new Set(row.windows.map(window => window.id)).size).toBe(row.windows.length);
    }
  });

  test("provider labels that match fixed ids do not take fixed-window precedence", () => {
    const creditsUsd = { used: 100, limit: 100, remaining: 0, percent: 100 };
    const reports = freshQuotaReportsFromResponse([
      { provider: "weekly", updatedAt: now, quota: { monthlyPercent: 7, customWindows: [{ label: "quota.weeklyLimit", percent: 95 }], creditsUsd } },
      { provider: "monthly", updatedAt: now, quota: { fiveHourPercent: 7, customWindows: [{ label: "quota.monthlyLimit", percent: 95 }], creditsUsd } },
      { provider: "five-hour", updatedAt: now, quota: { customWindows: [{ label: "Daily", percent: 7 }, { label: "quota.fiveHourLimit", percent: 95 }], creditsUsd } },
      { provider: "custom-only", updatedAt: now, quota: { customWindows: [{ label: "Daily", percent: 7 }, { label: "quota.weeklyLimit", percent: 95 }] } },
    ], now);
    const rows = buildQuotaSummary(reports, name);
    expect(rows.map(row => [row.provider, row.headline.labelKey, row.headline.label, row.headline.percent])).toEqual([
      ["weekly", "quotaSummary.credits", undefined, 100],
      ["monthly", "quotaSummary.credits", undefined, 100],
      ["five-hour", "quotaSummary.credits", undefined, 100],
      ["custom-only", undefined, "Daily", 7],
    ]);
  });

  test("colliding and suffixed provider labels stay distinct from actual windows and credits", () => {
    const customWindows = [
      { label: "quota.weeklyLimit", percent: 95 },
      { label: "quota.weeklyLimit#1", percent: 96 },
      { label: "quota.weeklyLimit", percent: 97 },
      { label: "quotaSummary.credits", percent: 98 },
      { label: "quotaSummary.credits#1", percent: 99 },
    ];
    const reports = freshQuotaReportsFromResponse([
      { provider: "real-credits", updatedAt: now, quota: { weeklyPercent: 7, customWindows, creditsUsd: { used: 100, limit: 100, remaining: 0, percent: 100 } } },
      { provider: "unlimited", updatedAt: now, quota: { monthlyPercent: 7, customWindows, creditsUsd: { used: 100, limit: 100, remaining: 0, percent: 100, unlimited: true } } },
      { provider: "malformed", updatedAt: now, quota: { monthlyPercent: 7, customWindows, creditsUsd: { percent: NaN } } },
    ], now);
    expect(accountQuotaFromReport(reports.unlimited)?.creditsUsd).toEqual({ used: 100, limit: 100, remaining: 0, percent: 100, unlimited: true });
    const rows = buildQuotaSummary(reports, name);
    expect(rows.map(row => [row.provider, row.headline.labelKey, row.headline.percent])).toEqual([
      ["real-credits", "quotaSummary.credits", 100],
      ["unlimited", "quota.monthlyLimit", 7],
      ["malformed", "quota.monthlyLimit", 7],
    ]);
    for (const row of rows) {
      expect(new Set(row.windows.map(window => window.id)).size).toBe(row.windows.length);
      expect(row.windows.filter(window => window.label !== undefined).map(window => window.label)).toEqual(customWindows.map(window => window.label));
    }
    expect(rows[0]!.windows.filter(window => window.labelKey === "quotaSummary.credits")).toHaveLength(1);
    expect(rows[1]!.windows.some(window => window.labelKey === "quotaSummary.credits")).toBe(false);
    expect(rows[2]!.windows.some(window => window.labelKey === "quotaSummary.credits")).toBe(false);
  });
});
