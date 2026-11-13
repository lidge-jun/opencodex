import { describe, expect, test } from "bun:test";
import {
  buildQuotaTable, formatCountdown, planDisplayName, SLOW_PROBE_MS, type QuotaTableAccount,
} from "../../gui/src/provider-workspace/account-quota-table";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const HOUR = 3_600_000;

function antigravity(id: string, overrides: Partial<QuotaTableAccount> = {}, windows: Array<[string, number, number?]> = []): QuotaTableAccount {
  return {
    id, label: id, plan: "g1-pro-tier", active: false, paused: false,
    quota: { customWindows: windows.map(([label, percent, resetHours]) => ({ label, percent, ...(resetHours !== undefined ? { resetAt: NOW + resetHours * HOUR } : {}) })) },
    ...overrides,
  };
}

describe("account quota table", () => {
  test("Antigravity windows land in Gemini, Claude & GPT and Argon pools as remaining percent", () => {
    const table = buildQuotaTable([
      antigravity("a", {}, [["Gem", 10, 2], ["Gem (Weekly)", 40, 50], ["Cla", 75, 3], ["Cla (Weekly)", 20, 100], ["Argon", 5, 1]]),
      antigravity("b", {}, [["Gem", 0, 4], ["Cla", 30, 1]]),
    ], NOW);
    expect(table.pools.map(pool => pool.key)).toEqual(["gemini", "claudeGpt", "argon"]);
    const a = table.rows[0]!;
    expect(a.cells.gemini).toEqual({ fiveHour: { remaining: 90, resetAt: NOW + 2 * HOUR }, weekly: { remaining: 60, resetAt: NOW + 50 * HOUR } });
    expect(a.cells.claudeGpt?.fiveHour?.remaining).toBe(25);
    expect(table.rows[1]!.cells.argon).toBeUndefined();
  });

  test("model-attributed rows never become a pool", () => {
    const table = buildQuotaTable([antigravity("a", {}, [["gemini-3-pro · free", 50, 1]])], NOW);
    expect(table.pools).toEqual([]);
  });

  test("Codex and Anthropic five-hour and weekly fields form the scarce subscription pool", () => {
    const table = buildQuotaTable([{
      id: "c", label: "c", plan: "plus", active: true, paused: false,
      quota: { fiveHourPercent: 64, fiveHourResetAt: (NOW + HOUR) / 1000, weeklyPercent: 12, weeklyResetAt: NOW + 72 * HOUR },
    }], NOW);
    expect(table.pools.map(pool => [pool.key, pool.scarce])).toEqual([["subscription", true]]);
    expect(table.rows[0]!.cells.subscription).toEqual({
      fiveHour: { remaining: 36, resetAt: NOW + HOUR },
      weekly: { remaining: 88, resetAt: NOW + 72 * HOUR },
    });
  });

  test("the scarce pool's next account resets soonest among usable accounts with headroom; Gemini gets no marker", () => {
    const table = buildQuotaTable([
      antigravity("late", {}, [["Gem", 0, 1], ["Cla (Weekly)", 10, 90]]),
      antigravity("soon", {}, [["Gem", 0, 1], ["Cla (Weekly)", 10, 20]]),
      antigravity("empty", {}, [["Cla (Weekly)", 100, 5]]),
      antigravity("paused", { paused: true }, [["Cla (Weekly)", 0, 2]]),
      antigravity("limited", { health: { status: "cooldown", reason: "rate_limit" } }, [["Cla (Weekly)", 0, 3]]),
    ], NOW);
    expect(table.rows.filter(row => row.next.length > 0).map(row => [row.account.id, row.next])).toEqual([["soon", ["claudeGpt"]]]);
  });

  test("flags: paused, sign-in, cooldown, failed probe, slow probe, unread quota, healthy", () => {
    const flags = buildQuotaTable([
      antigravity("p", { paused: true, needsReauth: true }),
      antigravity("r", { needsReauth: true }),
      antigravity("q", { health: { status: "cooldown", reason: "quota" } }),
      antigravity("x", { probe: { status: "rate_limited", latencyMs: 300 } }),
      antigravity("s", { probe: { status: "ok", latencyMs: SLOW_PROBE_MS + 1 } }),
      antigravity("u", { quotaUnavailable: true }),
      antigravity("h", { probe: { status: "ok", latencyMs: 900 } }),
    ], NOW).rows.map(row => [row.account.id, row.flag, row.probeStatus]);
    expect(flags).toEqual([
      ["p", "paused", undefined], ["r", "reauth", undefined], ["q", "quotaLimited", undefined],
      ["x", "probeFailed", "rate_limited"], ["s", "slow", undefined], ["u", "stale", undefined], ["h", "ok", undefined],
    ]);
  });

  test("plan names come from the upstream tier field; missing tier stays unknown", () => {
    expect(planDisplayName("g1-pro-tier")).toBe("Pro");
    expect(planDisplayName("free-tier")).toBe("Free");
    expect(planDisplayName("g1-ultra-tier")).toBe("g1-ultra-tier");
    expect(planDisplayName("max_5x", "Max 5x")).toBe("Max 5x");
    expect(planDisplayName(null)).toBeNull();
    expect(planDisplayName("  ")).toBeNull();
  });

  test("a reset already in the past shows no countdown", () => {
    const table = buildQuotaTable([antigravity("a", {}, [["Cla", 10, -1]])], NOW);
    expect(table.rows[0]!.cells.claudeGpt?.fiveHour).toEqual({ remaining: 90 });
  });

  test("countdown text", () => {
    expect(formatCountdown(NOW + 30_000, NOW)).toBe("<1m");
    expect(formatCountdown(NOW + 45 * 60_000, NOW)).toBe("45m");
    expect(formatCountdown(NOW + 3 * HOUR + 12 * 60_000, NOW)).toBe("3h 12m");
    expect(formatCountdown(NOW + 53 * HOUR, NOW)).toBe("2d 5h");
  });
});
