import { describe, expect, test } from "bun:test";
import { buildQuotaSummary, formatQuotaPercent, quotaSeverity } from "../src/quota-summary";
import { freshQuotaReportsFromResponse } from "../src/provider-workspace/report";

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
});
