import { describe, expect, test } from "bun:test";
import { buildQuotaSummary, formatQuotaPercent, quotaSeverity } from "../src/quota-summary";
import { accountQuotaFromReport, freshQuotaReportsFromResponse } from "../src/provider-workspace/report";

const now = Date.UTC(2026, 8, 23, 3);
const name = (provider: string) => provider;

describe("quota summary", () => {
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
