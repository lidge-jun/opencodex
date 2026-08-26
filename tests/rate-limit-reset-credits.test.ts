import { describe, it, expect } from "bun:test";
import {
  applyAccountQuotaFromUpstreamHeaders,
  parseUsageQuota,
  setAccountQuotaFromParsed,
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
          secondary_window: { used_percent: 20, reset_at: 1700100000 },
        },
        rate_limit_reset_credits: { available_count: 2 },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBe(2);
    });

    it("returns undefined resetCredits when field is absent", () => {
      const data: WhamUsageResponse = {
        rate_limit: {
          secondary_window: { used_percent: 30, reset_at: 1700000000 },
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
          secondary_window: { used_percent: 10 },
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
          secondary_window: { used_percent: 80, reset_at: 1700000000 },
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
          secondary_window: { used_percent: 34, reset_at: 1700100000 },
        },
        rate_limit_reset_credits: { available_count: 1 },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBe(1);
      expect(quota!.weeklyPercent).toBe(34);
    });

    it("maps Go and Free tertiary_window usage to 30d quota", () => {
      for (const plan_type of ["go", "free"]) {
        const quota = parseUsageQuota({
          plan_type,
          rate_limit: {
            secondary_window: { used_percent: 99, reset_at: 1700100000 },
            tertiary_window: { used_percent: 27, reset_at: 1700200000 },
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

  describe("parseUsageQuota window duration classification (issue #315)", () => {
    it("keeps a 7d primary window weekly", () => {
      const quota = parseUsageQuota({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 60, reset_at: 1787000000, limit_window_seconds: 604800 },
        },
      });
      expect(quota).toEqual({ weeklyPercent: 60, weeklyResetAt: 1787000000 });
    });

    it("classifies a ~30.4d primary window as monthly (reporter repro)", () => {
      const quota = parseUsageQuota({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 6, reset_at: 1787336442, limit_window_seconds: 2628000 },
          secondary_window: null,
          tertiary_window: null,
        },
        rate_limit_reset_credits: { available_count: 0 },
      });
      expect(quota).toEqual({ monthlyPercent: 6, monthlyResetAt: 1787336442, resetCredits: 0, monthlyIsPrimaryWindow: true });
      expect(quota!.weeklyPercent).toBeUndefined();
    });

    it("keeps secondary as the weekly source next to a monthly primary", () => {
      const quota = parseUsageQuota({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 39, reset_at: 1787401330, limit_window_seconds: 2628000 },
          secondary_window: { used_percent: 20, reset_at: 1787000000 },
        },
      });
      expect(quota).toEqual({
        monthlyPercent: 39,
        monthlyResetAt: 1787401330,
        monthlyIsPrimaryWindow: true,
        weeklyPercent: 20,
        weeklyResetAt: 1787000000,
      });
    });

    it("prefers a usable monthly primary over tertiary, same-source coupled", () => {
      const quota = parseUsageQuota({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 39, reset_at: 1787401330, limit_window_seconds: 2628000 },
          tertiary_window: { used_percent: 50, reset_at: 1788000000 },
        },
      });
      expect(quota).toEqual({ monthlyPercent: 39, monthlyResetAt: 1787401330, monthlyIsPrimaryWindow: true });
    });

    it("falls back to tertiary wholesale when a monthly primary has no percent", () => {
      const quota = parseUsageQuota({
        plan_type: "team",
        rate_limit: {
          primary_window: { reset_at: 1787401330, limit_window_seconds: 2628000 },
          tertiary_window: { used_percent: 50, reset_at: 1788000000 },
        },
      });
      // percent and reset must both come from tertiary — no cross-window pairing
      expect(quota).toEqual({ monthlyPercent: 50, monthlyResetAt: 1788000000 });
    });

    it("lets an explicit monthly primary win on go plans (upstream 4e0d6735 semantics)", () => {
      const quota = parseUsageQuota({
        plan_type: "go",
        rate_limit: {
          primary_window: { used_percent: 30, reset_at: 1787401330, limit_window_seconds: 2628000 },
          tertiary_window: { used_percent: 50, reset_at: 1788000000 },
        },
      });
      // No provenance flag on the Go/Free branch: the monthly window governs those plans
      // regardless of which window produced the reading, so recovery never consults it.
      expect(quota).toEqual({ monthlyPercent: 30, monthlyResetAt: 1787401330 });
    });

    it("keeps legacy tertiary monthly next to a duration-less weekly primary", () => {
      const quota = parseUsageQuota({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 10, reset_at: 1787000000 },
          tertiary_window: { used_percent: 50, reset_at: 1788000000 },
        },
      });
      expect(quota).toEqual({
        weeklyPercent: 10,
        weeklyResetAt: 1787000000,
        monthlyPercent: 50,
        monthlyResetAt: 1788000000,
      });
    });

    it("keeps duration-less primary weekly (backward compatibility)", () => {
      const quota = parseUsageQuota({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 10, reset_at: 1787000000 },
        },
      });
      expect(quota).toEqual({ weeklyPercent: 10, weeklyResetAt: 1787000000 });
    });
  });

  describe("CodexAuth reset credit UI", () => {
    it("normalizes Go and Free quota displays to 30d only", async () => {
      const { normalizeQuotaForPlan } = await import("../gui/src/codex-quota-utils");
      const quota = {
        weeklyPercent: 98,
        monthlyPercent: 12,
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

    /**
     * The five-hour window reaches the GUI under TWO names (#2616).
     *
     * `QuotaBars` reads `fiveHour*`, which is what the per-account provider probe reports. The
     * Codex pool declares the same window as `short*` (auth-api.ts, and `account-api.ts` says
     * outright that "the two surfaces name the same idea differently and both reach this DTO").
     * A Codex account card therefore had a five-hour quota upstream and rendered no five-hour
     * row at all.
     *
     * The canonical name wins when both are present: `short*` is an alias to fall back to, not
     * an override, or a pool snapshot could quietly replace a probe reading.
     */
    it("renders the Codex pool's short window as the five-hour window (#2616)", async () => {
      const { normalizeQuotaForPlan } = await import("../gui/src/codex-quota-utils");

      expect(normalizeQuotaForPlan({ shortPercent: 71, shortResetAt: 555, updatedAt: 1 }, "pro"))
        .toMatchObject({ fiveHourPercent: 71, fiveHourResetAt: 555 });

      // Canonical values win; the alias does not overwrite a probe reading.
      expect(normalizeQuotaForPlan(
        { fiveHourPercent: 10, fiveHourResetAt: 111, shortPercent: 71, shortResetAt: 555, updatedAt: 1 },
        "pro",
      )).toMatchObject({ fiveHourPercent: 10, fiveHourResetAt: 111 });

      // A quota carrying neither alias is still returned by identity, so the common path adds
      // no allocation and no behavior change.
      const untouched = { weeklyPercent: 5, updatedAt: 2 };
      expect(normalizeQuotaForPlan(untouched, "pro")).toBe(untouched);

      // A 30-day plan still strips non-monthly windows, alias or not — #1791's burst-window
      // carve-out lives on the server DTO, not in this GUI normalizer.
      expect(normalizeQuotaForPlan(
        { shortPercent: 71, shortResetAt: 555, monthlyPercent: 12, updatedAt: 3 },
        "go",
      )).toEqual({ monthlyPercent: 12, updatedAt: 3 });
    });

    it("does not exclude team or workspace plans from ticket badges", async () => {
      const [pool, helpers] = await Promise.all([
        Bun.file("gui/src/components/CodexAccountPool.tsx").text(),
        Bun.file("gui/src/components/codex-account-pool-helpers.tsx").text(),
      ]);
      const source = `${pool}\n${helpers}`;
      expect(source).not.toContain("isWorkspaceAccount");
      expect(source).not.toContain("Not available for workspace accounts");
      expect(helpers).toContain("if (credits === undefined) return null;");
      expect(helpers).toContain("className={`badge ${hasCredits ? \"badge-amber\" : \"badge-muted\"} badge-clickable`}");
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
      const source = await Bun.file("gui/src/components/codex-account-pool-cards.tsx").text();
      expect(source).toContain("className=\"card-badges\"");
      expect(source).toContain("<CodexTicketBadge t={t} account={a} onClick={() => onOpenReset(a)} />");
      // Next-session still renders BESIDE the ticket; health projection also suppresses
      // it for projected reauth/cooldown (not only the legacy needsReauth flag).
      expect(source).toContain("{isNext(a) && !showReauth && !inCooldown && (");
      expect(source).toContain("{t(accountModeState === \"direct\" ? \"codexAuth.poolPrepared\" : \"codexAuth.nextSession\")}");
      const styles = await Bun.file("gui/src/styles.css").text();
      expect(styles).toContain(".card-badges { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }");
      expect(styles).toContain(".card-badges .badge { flex-shrink: 0; }");
    });
  });

  describe("updateAccountQuota resetCredits", () => {
    it("stores resetCredits when provided", () => {
      clearAccountQuota();
      updateAccountQuota("test-1", 50, undefined, undefined, undefined, 3);
      const q = getAccountQuota("test-1");
      expect(q).not.toBeNull();
      expect(q!.resetCredits).toBe(3);
    });

    it("preserves resetCredits when not provided in subsequent update", () => {
      clearAccountQuota();
      updateAccountQuota("test-2", 50, undefined, undefined, undefined, 2);
      updateAccountQuota("test-2", 60);
      const q = getAccountQuota("test-2");
      expect(q).not.toBeNull();
      expect(q!.resetCredits).toBe(2);
      expect(q!.weeklyPercent).toBe(60);
    });

    it("overwrites resetCredits when explicitly provided", () => {
      clearAccountQuota();
      updateAccountQuota("test-3", 50, undefined, undefined, undefined, 5);
      updateAccountQuota("test-3", 50, undefined, undefined, undefined, 1);
      const q = getAccountQuota("test-3");
      expect(q!.resetCredits).toBe(1);
    });
  });

  describe("quota snapshot replacement (issue #382)", () => {
    it("clears stale weekly when a monthly-only WHAM snapshot is applied", () => {
      clearAccountQuota();
      updateAccountQuota("monthly-A", 100, 1787401330);
      const quota = parseUsageQuota({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 100, reset_at: 1787401330, limit_window_seconds: 2628000 },
          secondary_window: null,
        },
      });
      expect(quota).toEqual({ monthlyPercent: 100, monthlyResetAt: 1787401330, monthlyIsPrimaryWindow: true });
      setAccountQuotaFromParsed("monthly-A", quota!);
      expect(getAccountQuota("monthly-A")).toEqual({
        monthlyPercent: 100,
        monthlyResetAt: 1787401330,
        monthlyIsPrimaryWindow: true,
        updatedAt: expect.any(Number),
      });
    });

    it("classifies a ~30d primary header as monthly and clears stale weekly", () => {
      clearAccountQuota();
      updateAccountQuota("monthly-A", 100, 1787401330);
      const headers = new Headers({
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "43800",
        "x-codex-primary-reset-at": "1787401330",
      });
      applyAccountQuotaFromUpstreamHeaders("monthly-A", headers);
      expect(getAccountQuota("monthly-A")).toEqual({
        monthlyPercent: 100,
        monthlyResetAt: 1787401330,
        monthlyIsPrimaryWindow: true,
        updatedAt: expect.any(Number),
      });
    });

    it("keeps weekly primary headers weekly", () => {
      clearAccountQuota();
      const headers = new Headers({
        "x-codex-primary-used-percent": "80",
        "x-codex-primary-window-minutes": "10080",
        "x-codex-primary-reset-at": "1787000000",
      });
      applyAccountQuotaFromUpstreamHeaders("weekly-A", headers);
      expect(getAccountQuota("weekly-A")).toEqual({
        weeklyPercent: 80,
        weeklyResetAt: 1787000000,
        updatedAt: expect.any(Number),
      });
    });
    it("preserves resetCredits when applying header quota snapshots", () => {
      clearAccountQuota();
      updateAccountQuota("credits-A", 10, 111, 20, 222, 3);
      const headers = new Headers({
        "x-codex-primary-used-percent": "80",
        "x-codex-primary-window-minutes": "10080",
        "x-codex-primary-reset-at": "1787000000",
      });
      applyAccountQuotaFromUpstreamHeaders("credits-A", headers);
      expect(getAccountQuota("credits-A")).toEqual({
        weeklyPercent: 80,
        weeklyResetAt: 1787000000,
        monthlyPercent: 20,
        monthlyResetAt: 222,
        resetCredits: 3,
        updatedAt: expect.any(Number),
      });
    });

    it("keeps tertiary from overriding explicit monthly primary headers", () => {
      clearAccountQuota();
      const headers = new Headers({
        "x-codex-primary-used-percent": "39",
        "x-codex-primary-window-minutes": "43800",
        "x-codex-primary-reset-at": "1787401330",
        "x-codex-tertiary-used-percent": "50",
        "x-codex-tertiary-reset-at": "1788000000",
      });
      applyAccountQuotaFromUpstreamHeaders("team-tertiary", headers);
      expect(getAccountQuota("team-tertiary")).toEqual({
        monthlyPercent: 39,
        monthlyResetAt: 1787401330,
        monthlyIsPrimaryWindow: true,
        updatedAt: expect.any(Number),
      });
    });

    it("preserves usage on credits-only WHAM refreshes", () => {
      clearAccountQuota();
      updateAccountQuota("credits-only", 10, 111, 20, 222, 1);
      const quota = parseUsageQuota({ rate_limit_reset_credits: { available_count: 2 } });
      setAccountQuotaFromParsed("credits-only", quota!);
      expect(getAccountQuota("credits-only")).toEqual({
        weeklyPercent: 10,
        weeklyResetAt: 111,
        monthlyPercent: 20,
        monthlyResetAt: 222,
        resetCredits: 2,
        updatedAt: expect.any(Number),
      });
    });

    it("preserves monthly quota when weekly-only headers arrive", () => {
      clearAccountQuota();
      updateAccountQuota("weekly-only", 10, 111, 50, 222);
      const headers = new Headers({
        "x-codex-primary-used-percent": "80",
        "x-codex-primary-window-minutes": "10080",
        "x-codex-primary-reset-at": "1787000000",
      });
      applyAccountQuotaFromUpstreamHeaders("weekly-only", headers);
      expect(getAccountQuota("weekly-only")).toEqual({
        weeklyPercent: 80,
        weeklyResetAt: 1787000000,
        monthlyPercent: 50,
        monthlyResetAt: 222,
        updatedAt: expect.any(Number),
      });
    });

    it("maps monthly primary plus secondary weekly headers together", () => {
      clearAccountQuota();
      const headers = new Headers({
        "x-codex-primary-used-percent": "39",
        "x-codex-primary-window-minutes": "43800",
        "x-codex-primary-reset-at": "1787401330",
        "x-codex-secondary-used-percent": "20",
        "x-codex-secondary-reset-at": "1787000000",
      });
      applyAccountQuotaFromUpstreamHeaders("team-A", headers);
      expect(getAccountQuota("team-A")).toEqual({
        monthlyPercent: 39,
        monthlyResetAt: 1787401330,
        monthlyIsPrimaryWindow: true,
        weeklyPercent: 20,
        weeklyResetAt: 1787000000,
        updatedAt: expect.any(Number),
      });
    });
  });

  /**
   * Codex removed the 5-hour window and restored it for Plus and Team (Pro stays weekly-only).
   * The header parser classified every non-monthly primary as weekly, so a 5h reading landed in
   * weeklyPercent, the real weekly value was discarded, and the account stayed "exhausted" long
   * after the burst window reset.
   */
  describe("header window duration classification (5h restoration)", () => {
    it("files a 5h primary as the burst window and the 7-day secondary as weekly", () => {
      clearAccountQuota();
      const headers = new Headers({
        "x-codex-primary-used-percent": "97",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1787401330",
        "x-codex-secondary-used-percent": "12",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": "1788000000",
      });
      applyAccountQuotaFromUpstreamHeaders("burst-A", headers);
      expect(getAccountQuota("burst-A")).toEqual({
        shortPercent: 97,
        shortResetAt: 1787401330,
        shortWindowSeconds: 18000,
        weeklyPercent: 12,
        weeklyResetAt: 1788000000,
        updatedAt: expect.any(Number),
      });
    });

    it("an exhausted burst window does not poison the weekly reading", () => {
      // The damaging half of the bug: weeklyPercent=100 survives the 5h reset and keeps the
      // account out of the pool until an unrelated WHAM refresh overwrites it.
      clearAccountQuota();
      applyAccountQuotaFromUpstreamHeaders("burst-B", new Headers({
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "300",
        "x-codex-secondary-used-percent": "8",
        "x-codex-secondary-window-minutes": "10080",
      }));
      const quota = getAccountQuota("burst-B");
      expect(quota?.shortPercent).toBe(100);
      expect(quota?.weeklyPercent).toBe(8);
    });

    it("a sub-day window at 1439 minutes is short; 1440 minutes is not", () => {
      // Strict `<` against the 24h discriminator, matching isExplicitShortWindow exactly.
      clearAccountQuota();
      applyAccountQuotaFromUpstreamHeaders("edge-below", new Headers({
        "x-codex-primary-used-percent": "60",
        "x-codex-primary-window-minutes": "1439",
      }));
      expect(getAccountQuota("edge-below")?.shortPercent).toBe(60);
      expect(getAccountQuota("edge-below")?.weeklyPercent).toBeUndefined();

      clearAccountQuota();
      applyAccountQuotaFromUpstreamHeaders("edge-at", new Headers({
        "x-codex-primary-used-percent": "60",
        "x-codex-primary-window-minutes": "1440",
      }));
      expect(getAccountQuota("edge-at")?.weeklyPercent).toBe(60);
      expect(getAccountQuota("edge-at")?.shortPercent).toBeUndefined();
    });

    it("a primary with no declared duration stays weekly", () => {
      // Duration classification is opt-in on a DECLARED duration. Legacy payloads omit the
      // header, and guessing there would reclassify every account that predates the field.
      clearAccountQuota();
      applyAccountQuotaFromUpstreamHeaders("legacy-A", new Headers({
        "x-codex-primary-used-percent": "80",
        "x-codex-primary-reset-at": "1787000000",
      }));
      expect(getAccountQuota("legacy-A")).toEqual({
        weeklyPercent: 80,
        weeklyResetAt: 1787000000,
        updatedAt: expect.any(Number),
      });
    });

    it("the reset instant travels with its own window", () => {
      clearAccountQuota();
      applyAccountQuotaFromUpstreamHeaders("reset-A", new Headers({
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1787401330",
      }));
      const quota = getAccountQuota("reset-A");
      expect(quota?.shortResetAt).toBe(1787401330);
      // The primary reset belongs to the burst window; it must not be reported as the weekly one.
      expect(quota?.weeklyResetAt).toBeUndefined();
    });
  });

});
