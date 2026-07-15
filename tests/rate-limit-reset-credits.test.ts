import { describe, it, expect } from "bun:test";
import {
  parseUsageQuota,
  updateAccountQuota,
  getAccountQuota,
  clearAccountQuota,
  type WhamUsageResponse,
} from "../src/codex/quota";

describe("rate-limit reset credits", () => {
  describe("parseUsageQuota", () => {
    it("extracts resetCredits from response", () => {
      const data: WhamUsageResponse = {
        rate_limit: {
          primary_window: { used_percent: 50, reset_at: 1700000000 },
          secondary_window: { used_percent: 20, reset_at: 1700100000 },
        },
        rate_limit_reset_credits: { available_count: 2 },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBe(2);
      expect(quota!.fiveHourPercent).toBe(50);
    });

    it("returns undefined resetCredits when field is absent", () => {
      const data: WhamUsageResponse = {
        rate_limit: {
          primary_window: { used_percent: 30, reset_at: 1700000000 },
        },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBeUndefined();
    });

    it("handles credits-only response (no rate_limit)", () => {
      const data: WhamUsageResponse = {
        rate_limit_reset_credits: { available_count: 1 },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBe(1);
      expect(quota!.weeklyPercent).toBeUndefined();
    });

    it("returns null when neither rate_limit nor credits exist", () => {
      const data: WhamUsageResponse = {};
      expect(parseUsageQuota(data)).toBeNull();
    });

    it("handles null rate_limit_reset_credits", () => {
      const data: WhamUsageResponse = {
        rate_limit: {
          primary_window: { used_percent: 10 },
        },
        rate_limit_reset_credits: null,
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBeUndefined();
    });

    it("handles zero available_count", () => {
      const data: WhamUsageResponse = {
        rate_limit: {
          primary_window: { used_percent: 80, reset_at: 1700000000 },
        },
        rate_limit_reset_credits: { available_count: 0 },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBe(0);
    });

    it("keeps reset credits for team plans", () => {
      const data: WhamUsageResponse = {
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 12, reset_at: 1700000000 },
          secondary_window: { used_percent: 34, reset_at: 1700100000 },
        },
        rate_limit_reset_credits: { available_count: 1 },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBe(1);
      expect(quota!.fiveHourPercent).toBe(12);
      expect(quota!.weeklyPercent).toBe(34);
    });

    it("maps Go and Free primary_window usage to 30d quota", () => {
      for (const plan_type of ["go", "free"]) {
        const quota = parseUsageQuota({
          plan_type,
          rate_limit: {
            primary_window: { used_percent: 27, reset_at: 1700200000 },
            secondary_window: { used_percent: 99, reset_at: 1700100000 },
          },
          rate_limit_reset_credits: { available_count: 1 },
        });

        expect(quota).toEqual({
          monthlyPercent: 27,
          monthlyResetAt: 1700200000,
          resetCredits: 1,
        });
      }
    });
  });

  describe("CodexAuth reset credit UI", () => {
    it("normalizes Go and Free quota displays to 30d only", async () => {
      const { normalizeQuotaForPlan } = await import("../gui/src/codex-quota-utils");
      const quota = {
        fiveHourPercent: 99,
        weeklyPercent: 98,
        monthlyPercent: 12,
        fiveHourResetAt: 111,
        weeklyResetAt: 222,
        monthlyResetAt: 333,
        resetCredits: 2,
        updatedAt: 444,
      };

      expect(normalizeQuotaForPlan(quota, "go")).toEqual({
        monthlyPercent: 12,
        monthlyResetAt: 333,
        resetCredits: 2,
        updatedAt: 444,
      });
      expect(normalizeQuotaForPlan(quota, " free ")).toEqual({
        monthlyPercent: 12,
        monthlyResetAt: 333,
        resetCredits: 2,
        updatedAt: 444,
      });
      expect(normalizeQuotaForPlan(quota, "pro")).toBe(quota);
    });

    it("does not exclude team or workspace plans from ticket badges", async () => {
      const source = await Bun.file("gui/src/pages/CodexAuth.tsx").text();
      expect(source).not.toContain("isWorkspaceAccount");
      expect(source).not.toContain("Not available for workspace accounts");
      expect(source).toContain("if (credits === undefined) return null;");
      expect(source).toContain("className={`badge ${hasCredits ? \"badge-amber\" : \"badge-muted\"} badge-clickable`}");
    });

    it("keeps clickable ticket badges from overriding visual badge colors", async () => {
      const styles = await Bun.file("gui/src/styles.css").text();
      const match = styles.match(/\.badge-clickable\s*\{([^}]*)\}/);
      expect(match).not.toBeNull();
      expect(match![1]).not.toContain("background:");
      expect(match![1]).not.toContain("border: none");
      expect(styles).toContain("border: 1px solid transparent");
    });

    it("renders reset tickets beside next-session badges instead of replacing them", async () => {
      const source = await Bun.file("gui/src/pages/CodexAuth.tsx").text();
      expect(source).toContain("className=\"card-badges\"");
      expect(source).toContain("<TicketBadge t={t} account={a} onClick={() => openResetPopup(a)} />");
      expect(source).toContain("{isNext(a.id) && !a.needsReauth && <span className=\"badge badge-primary\">{t(\"codexAuth.nextSession\")}</span>}");
      const styles = await Bun.file("gui/src/styles.css").text();
      expect(styles).toContain(".card-badges { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }");
      expect(styles).toContain(".card-badges .badge { flex-shrink: 0; }");
    });
  });

  describe("updateAccountQuota resetCredits", () => {
    it("stores resetCredits when provided", () => {
      clearAccountQuota();
      updateAccountQuota("test-1", 50, 30, undefined, undefined, undefined, undefined, 3);
      const q = getAccountQuota("test-1");
      expect(q).not.toBeNull();
      expect(q!.resetCredits).toBe(3);
    });

    it("preserves resetCredits when not provided in subsequent update", () => {
      clearAccountQuota();
      updateAccountQuota("test-2", 50, 30, undefined, undefined, undefined, undefined, 2);
      updateAccountQuota("test-2", 60, 40);
      const q = getAccountQuota("test-2");
      expect(q).not.toBeNull();
      expect(q!.resetCredits).toBe(2);
      expect(q!.weeklyPercent).toBe(60);
    });

    it("overwrites resetCredits when explicitly provided", () => {
      clearAccountQuota();
      updateAccountQuota("test-3", 50, 30, undefined, undefined, undefined, undefined, 5);
      updateAccountQuota("test-3", 50, 30, undefined, undefined, undefined, undefined, 1);
      const q = getAccountQuota("test-3");
      expect(q!.resetCredits).toBe(1);
    });
  });
});
