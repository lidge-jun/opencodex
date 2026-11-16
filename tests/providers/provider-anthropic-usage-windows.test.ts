import { afterEach, expect, test } from "bun:test";
import { probeAnthropicUsageQuota } from "../../src/providers/claude-cli-usage";
import { rawAnthropicUsageWindows } from "../../src/providers/quota/anthropic-decision-windows";
import { hasAnthropicFamilyEnumeration, mergeAnthropicFamilyWindows, parseAnthropicFamilyHeaders } from "../../src/providers/quota/anthropic-family-headers";
import { anthropicModelPercents, anthropicModelRankPercent, anthropicModelWeeklyPercent } from "../../src/oauth/anthropic-model-quota";
import { resolveAnthropicAccountIdentity } from "../../src/oauth/anthropic-identity";
import { providerQuotaWindows } from "../../src/quota-pool/assemble";
import { pooledWindows } from "../../src/quota-pool/pooled";
import { anthropicResetGrantBlocker, parseAnthropicResetGrantStatus } from "../../src/providers/anthropic-reset-grants";
import { normalizeAnthropicQuota } from "../../src/providers/quota/account-cache";
import { earliestQuotaResetAt } from "../../src/combos/reset-window";
import type { ProviderQuota } from "../../src/providers/quota-types";
import { inactiveFableShareUsage, inactiveFableWeeklyReset, inactiveSessionUsage, maxTeamInactiveWeeklyUsage, maxTeamInactiveSessionUsage, legacyMax20xUsage, noResetGrant, ultraUsage, weeklyReset } from "../fixtures/anthropic-usage-shapes";

const originalFetch = globalThis.fetch;
const now = Date.parse("2026-10-31T14:00:00Z");
afterEach(() => { globalThis.fetch = originalFetch; });
async function parse(body: unknown) {
  globalThis.fetch = (async (_url, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    return Response.json(body);
  }) as typeof fetch;
  return (await probeAnthropicUsageQuota("synthetic-usage-bearer")).quota;
}
const scoped = (is_active: boolean, percent = 100) => ({ kind: "weekly_scoped", is_active, percent,
  resets_at: weeklyReset, scope: { model: { display_name: "Fable" } } });

test("legacy Pro/Max usage keeps its shared 5h, weekly and model windows", async () => {
  const quota = await parse(legacyMax20xUsage);
  expect(quota).toMatchObject({ fiveHourPercent: 12, weeklyPercent: 53,
    customWindows: [{ label: "Fable", scope: "model", percent: 0 }] });
  expect(rawAnthropicUsageWindows(legacyMax20xUsage, now).map(row => [row.window, row.percent]))
    .toEqual([["5h", 12], ["weekly", 53], ["fable", 0]]);
});

test("Ultra null 5h and inactive Fable publish only the weekly window for routing", async () => {
  const quota = await parse(ultraUsage);
  expect(quota?.fiveHourPercent).toBeUndefined();
  expect(quota?.weeklyPercent).toBe(53);
  expect(quota?.customWindows ?? []).toEqual([]);
  expect(quota?.displayWindows).toEqual([{ label: "Fable", scope: "model", percent: 0, resetAt: Date.parse(weeklyReset) }]);
  expect(rawAnthropicUsageWindows(ultraUsage, now).map(row => row.window)).toEqual(["weekly"]);
  expect(hasAnthropicFamilyEnumeration(quota!)).toBe(true);
  expect(providerQuotaWindows(quota!, "measured", now).map(row => row.id)).toEqual(["weekly"]);
});

test("cached display-only family rows drop expired and malformed entries", () => {
  const future = now + 3_600_000;
  const quota = normalizeAnthropicQuota({ weeklyPercent: 40, weeklyResetAt: future, updatedAt: now, displayWindows: [
    { label: "Fable", scope: "model", percent: 0, resetAt: future },
    { label: "Opus", scope: "model", percent: 12, resetAt: now - 1 },
    { label: "", scope: "model", percent: 5 },
  ] }, now);
  expect(quota?.displayWindows).toEqual([{ label: "Fable", scope: "model", percent: 0, resetAt: future }]);
});

test("R3 inactive session retains the zero session meter", async () => {
  const quota = await parse(inactiveSessionUsage);
  expect(quota?.fiveHourPercent).toBe(0);
  expect(quota?.fiveHourResetAt).toBeUndefined();
  expect(rawAnthropicUsageWindows(inactiveSessionUsage, now).map(row => row.window)).toEqual(["5h", "weekly"]);
});

test("limits weekly_all works with missing five_hour and no legacy seven_day", async () => {
  const quota = await parse({ limits: ultraUsage.limits });
  expect(quota?.weeklyPercent).toBe(53);
  expect(quota?.weeklyResetAt).toBe(Date.parse(weeklyReset));
});

test("authoritative shared and scoped limits override conflicting legacy duplicates once", async () => {
  const body = { ...legacyMax20xUsage,
    limits: [{ kind: "session", percent: 14, is_active: true },
      { kind: "weekly_all", percent: 27, is_active: true }, scoped(true, 81)] };
  const quota = await parse(body);
  expect(quota).toMatchObject({ fiveHourPercent: 14, weeklyPercent: 27,
    customWindows: [{ label: "Fable", scope: "model", percent: 81 }] });
  expect(rawAnthropicUsageWindows(body, now).map(row => [row.window, row.percent]))
    .toEqual([["5h", 14], ["weekly", 27], ["fable", 81]]);
});

for (const active of [false, true]) test(`Fable is model-bound and gates only while active=${active}`, async () => {
  const body = { seven_day: { utilization: 10 }, seven_day_fable: { utilization: 100 }, limits: [scoped(active)] };
  const quota = await parse(body);
  expect(anthropicModelPercents(quota, "claude-sonnet-5-5")).toEqual([10]);
  expect(anthropicModelPercents(quota, "claude-opus-5-5")).toEqual([10]);
  expect(anthropicModelPercents(quota, "claude-fable-5").some(percent => percent >= 100)).toBe(active);
  expect(quota?.displayWindows?.map(window => [window.label, window.percent]) ?? []).toEqual(active ? [] : [["Fable", 100]]);
  const windows = providerQuotaWindows(quota!, "measured", now);
  expect(windows.some(row => row.exhausted && row.scopeModel === undefined)).toBe(false);
  expect(windows.find(row => row.id === "family:fable")?.scopeModel).toBe(active ? "family:fable" : undefined);
  const pooled = pooledWindows([{ eligible: true, weight: 1, windows }], now);
  expect(pooled.some(row => row.exhausted && row.scopeModel === undefined)).toBe(false);
});

test("unknown limit kinds/families do not discard shared usage or claim complete family enumeration", async () => {
  const quota = await parse({ ...ultraUsage, limits: [...ultraUsage.limits,
    { kind: "future_weekly", percent: 100 },
    { ...scoped(true), scope: { model: { display_name: "Future model" } } }] });
  expect(quota?.weeklyPercent).toBe(53);
  expect(quota?.customWindows ?? []).toEqual([]);
  expect(hasAnthropicFamilyEnumeration(quota!)).toBe(false);
});

for (const flag of [false, "unknown"]) test(`R4 shared weekly flag ${flag} uses authoritative data`, async () => {
  const body = { seven_day: { utilization: 100 }, limits: [{ kind: "weekly_all", is_active: flag, percent: 0 }] };
  const quota = await parse(body);
  expect(quota?.weeklyPercent).toBe(0);
  expect(rawAnthropicUsageWindows(body, now).map(row => row.percent)).toEqual([0]);
  expect(hasAnthropicFamilyEnumeration(quota!)).toBe(flag === false);
});

test("R1 inactive weekly retains both shared projections", async () => {
  const quota = await parse(maxTeamInactiveWeeklyUsage);
  expect(quota).toMatchObject({ fiveHourPercent: 0, weeklyPercent: 55, weeklyResetAt: Date.parse(weeklyReset) });
  expect(rawAnthropicUsageWindows(maxTeamInactiveWeeklyUsage, now).map(row => row.window)).toEqual(["5h", "weekly"]);
  expect(providerQuotaWindows(quota!, "measured", now).map(row => row.id)).toEqual(["5h", "weekly"]);
});
test("R2 inactive session retains its measured usage", async () => {
  const quota = await parse(maxTeamInactiveSessionUsage);
  expect(quota).toMatchObject({ fiveHourPercent: 40, fiveHourResetAt: Date.parse(weeklyReset), weeklyPercent: 56 });
});
test("R5 Ultra null five_hour and missing session flag has no 5h meter", async () => {
  const quota = await parse({ five_hour: null, limits: [{ kind: "session", percent: 7 }] });
  expect(quota?.fiveHourPercent).toBeUndefined();
});
for (const legacy of [undefined, { utilization: 99 }]) test(`R6 malformed inactive shared row clears enumeration legacy=${!!legacy}`, async () => {
  const quota = await parse({ seven_day: legacy, limits: [{ kind: "session", is_active: true, percent: 1 }, { kind: "weekly_all", is_active: false, percent: "x" }] });
  expect(quota?.weeklyPercent).toBeUndefined();
  expect(hasAnthropicFamilyEnumeration(quota!)).toBe(false);
});
test("G0 Ultra explicit active session establishes a 5h meter", async () => {
  expect((await parse({ five_hour: null, limits: [{ kind: "session", is_active: true, percent: 7 }] }))?.fiveHourPercent).toBe(7);
});
for (const flag of [false, "unknown"]) test(`G1 Ultra null session flag ${flag} has no meter`, async () => {
  expect((await parse({ five_hour: null, limits: [{ kind: "session", is_active: flag, percent: 7 }] }))?.fiveHourPercent).toBeUndefined();
});
for (const percent of [undefined, "x"]) test(`G2 malformed active shared ${percent} suppresses legacy`, async () => {
  const body = { five_hour: { utilization: 1 }, seven_day: { utilization: 100 }, limits: [{ kind: "weekly_all", is_active: true, percent }] };
  const quota = await parse(body);
  expect(quota?.weeklyPercent).toBeUndefined();
  expect(rawAnthropicUsageWindows(body, now).map(row => row.window)).toEqual(["5h"]);
  expect(hasAnthropicFamilyEnumeration(quota!)).toBe(false);
});
for (const malformedFirst of [true, false]) test(`G3 duplicate shared first malformed=${malformedFirst}`, async () => {
  const valid = { kind: "weekly_all", is_active: true, percent: 42 };
  const malformed = { kind: "weekly_all", is_active: true, percent: "x" };
  const body = { five_hour: { utilization: 1 }, seven_day: { utilization: 100 }, limits: malformedFirst ? [malformed, valid] : [valid, malformed] };
  const quota = await parse(body);
  expect(quota?.weeklyPercent).toBe(malformedFirst ? undefined : 42);
  expect(rawAnthropicUsageWindows(body, now).filter(row => row.window === "weekly").map(row => row.percent)).toEqual(malformedFirst ? [] : [42]);
  expect(hasAnthropicFamilyEnumeration(quota!)).toBe(false);
});

test("raw decision windows retain invalid reset evidence instead of display normalization", () => {
  const rows = rawAnthropicUsageWindows({ limits: [{ kind: "weekly_all", percent: 53.125,
    is_active: true, resets_at: "invalid" }] }, now);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.percent).toBe(53.125);
  expect(Number.isNaN(rows[0]?.resetAt)).toBe(true);
});

for (const [tier, plan] of [["default_claude_ultra", "ultra"], ["claude_ultra", "ultra"],
  ["Ultra", "ultra"], ["claude_max_20x", "max_20x"], ["default_claude_max_20x", "max_20x"],
  ["default_claude_max_5x", "max_5x"], ["default_claude_future_tier", "default_claude_future_tier"]]) {
  test(`profile accepts display tier ${tier} without assigning entitlements`, async () => {
    globalThis.fetch = (async () => Response.json({ account: { uuid: "synthetic-account" },
      organization: { rate_limit_tier: tier } })) as typeof fetch;
    expect((await resolveAnthropicAccountIdentity("synthetic-profile-bearer"))?.plan).toBe(plan);
  });
}

test("no-grant and future ineligibility reasons remain displayable and refuse spending", () => {
  for (const reason of ["no_grant", "future_reason"]) {
    const status = parseAnthropicResetGrantStatus({ ...noResetGrant, ineligible_reason: reason });
    expect(status?.ineligibleReason).toBe(reason === "no_grant" ? reason : "unknown");
    expect(anthropicResetGrantBlocker(status!, "synthetic-grant")).toBe("ineligible");
  }
});

for (const tier of ["claude_pro", "default_claude_max_5x"]) {
  test(`${tier} retains its real five-hour and weekly meters`, async () => {
    const body = { five_hour: { utilization: 16 }, seven_day: { utilization: 37 }, limits: [
      { kind: "session", percent: 18, is_active: true }, { kind: "weekly_all", percent: 39, is_active: true },
    ] };
    const quota = await parse(body);
    expect(quota).toMatchObject({ fiveHourPercent: 18, weeklyPercent: 39 });
    expect(rawAnthropicUsageWindows(body, now).map(row => row.window)).toEqual(["5h", "weekly"]);
    expect(providerQuotaWindows(quota!, "measured", now).map(row => row.id)).toEqual(["5h", "weekly"]);
  });
}
for (const [status, failure] of [[401, "access_denied"], [429, "rate_limited"]] as const) {
  test(`HTTP ${status} is a closed failure diagnosis and exposes no upstream text`, async () => {
    globalThis.fetch = (async () => Response.json({ error: { message: "synthetic-private-detail" } }, { status })) as typeof fetch;
    expect(await probeAnthropicUsageQuota("synthetic-usage-bearer")).toEqual({ quota: null, failure });
  });
}

// Live /api/oauth/usage shape (2026-11-10): weekly_scoped_shares indexes the raw limits array.
const fableShareBody = (fable: number, weekly: number, shares: unknown, extraFirst: unknown[] = []) => ({
  limits: [...extraFirst, { kind: "session", percent: 3, is_active: true }, { kind: "weekly_all", percent: weekly, is_active: true },
    { kind: "weekly_scoped", percent: fable, is_active: true, resets_at: weeklyReset, scope: { model: { id: null, display_name: "Fable" }, surface: null } }],
  weekly_scoped_shares: shares,
});

test("Fable carries its weekly allowance and ranks on the weekly scale", async () => {
  const tight = await parse(fableShareBody(60, 10, [{ limit_index: 2, used_percent_of_weekly: 30, allowance_percent_of_weekly: 50 }]));
  expect(tight?.customWindows).toEqual([{ label: "Fable", scope: "model", percent: 60, resetAt: Date.parse(weeklyReset), weeklyAllowancePercent: 50 }]);
  // 60% of a half-week allowance leaves 20 weekly points: rank at 80, while exhaustion stays at the raw 100.
  expect(anthropicModelRankPercent(tight, "claude-fable-5-2")).toBe(80);
  expect(anthropicModelWeeklyPercent(tight, "claude-fable-5-2")).toBe(60);
  const roomy = await parse(fableShareBody(0, 70, [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }]));
  const rank = (quota: typeof tight) => Math.max(quota!.weeklyPercent!, anthropicModelRankPercent(quota, "claude-fable-5-2")!);
  // Real Fable headroom: tight min(20, 90) = 20, roomy min(50, 30) = 30, so roomy must rank first.
  expect(rank(roomy)).toBeLessThan(rank(tight));
  expect(anthropicModelRankPercent(roomy, "claude-sonnet-5-5")).toBeUndefined();
  expect(anthropicModelPercents(tight, "claude-fable-5-2").some(percent => percent >= 100)).toBe(false);
  const spent = await parse(fableShareBody(100, 40, [{ limit_index: 2, allowance_percent_of_weekly: 50 }]));
  expect(anthropicModelRankPercent(spent, "claude-fable-5-2")).toBe(100);
});

test("weekly share follows the raw limits index, including skipped leading rows", async () => {
  const quota = await parse(fableShareBody(20, 10, [{ limit_index: 3, allowance_percent_of_weekly: 50 }], [{ kind: "future_kind", percent: 1 }]));
  expect(quota?.customWindows?.[0]?.weeklyAllowancePercent).toBe(50);
});

for (const [name, shares] of [
  ["a shared row", [{ limit_index: 1, allowance_percent_of_weekly: 50 }]],
  ["an out-of-range index", [{ limit_index: 9, allowance_percent_of_weekly: 50 }]],
  ["a fractional index", [{ limit_index: 2.5, allowance_percent_of_weekly: 50 }]],
  ["a zero allowance", [{ limit_index: 2, allowance_percent_of_weekly: 0 }]],
  ["an allowance above the week", [{ limit_index: 2, allowance_percent_of_weekly: 150 }]],
  ["a malformed allowance", [{ limit_index: 2, allowance_percent_of_weekly: "x" }]],
  ["conflicting shares", [{ limit_index: 2, allowance_percent_of_weekly: 50 }, { limit_index: 2, allowance_percent_of_weekly: 40 }]],
  ["a non-array", { limit_index: 2, allowance_percent_of_weekly: 50 }],
] as const) test(`weekly share ignores ${name}`, async () => {
  const quota = await parse(fableShareBody(60, 10, shares));
  expect(quota?.customWindows?.[0]).toEqual({ label: "Fable", scope: "model", percent: 60, resetAt: Date.parse(weeklyReset) });
  expect(anthropicModelRankPercent(quota, "claude-fable-5-2")).toBe(60);
});

test("an inactive Fable row stays unpublished even with a share", async () => {
  const body = { ...ultraUsage, weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }] };
  expect((await parse(body))?.customWindows ?? []).toEqual([]);
});

test("a passive Fable header reading keeps the probed weekly allowance", () => {
  const headers = new Headers({ "anthropic-ratelimit-unified-7d_oi-utilization": "0.3" });
  const merged = mergeAnthropicFamilyWindows([{ label: "Fable", scope: "model", percent: 10, weeklyAllowancePercent: 50 }],
    parseAnthropicFamilyHeaders(headers, now));
  expect(merged).toEqual([{ label: "Fable", scope: "model", percent: 30, passiveObservedAt: now, weeklyAllowancePercent: 50 }]);
});


test("a usage probe without a share drops the previous weekly allowance", () => {
  const merged = mergeAnthropicFamilyWindows([{ label: "Fable", scope: "model", percent: 10, weeklyAllowancePercent: 50 }],
    [{ label: "Fable", scope: "model", percent: 20 }]);
  expect(merged).toEqual([{ label: "Fable", scope: "model", percent: 20 }]);
});

test("an inactive Fable row with no legacy key is displayed with its percent, reset and weekly share", async () => {
  const quota = await parse(inactiveFableShareUsage);
  // The inactive session still shows because legacy five_hour is not null (#8088 is unchanged).
  expect(quota).toMatchObject({ fiveHourPercent: 35, weeklyPercent: 91, weeklyResetAt: Date.parse(inactiveFableWeeklyReset) });
  expect(quota?.customWindows ?? []).toEqual([]);
  // The bar is Fable's own 4%, never the weekly-scale used_percent_of_weekly (2).
  expect(quota?.displayWindows).toEqual([{ label: "Fable", scope: "model", percent: 4,
    resetAt: Date.parse(inactiveFableWeeklyReset), weeklyAllowancePercent: 50 }]);
  expect(hasAnthropicFamilyEnumeration(quota!)).toBe(true);
});

test("display-only rows never reach routing, exhaustion or reset ordering", async () => {
  const quota = (await parse(inactiveFableShareUsage))!;
  const routedOnly: ProviderQuota = { ...quota };
  delete routedOnly.displayWindows;
  const louder: ProviderQuota = { ...quota, displayWindows: [{ label: "Fable", scope: "model", percent: 100,
    resetAt: now + 60_000, weeklyAllowancePercent: 50 }] };
  const decisions = (variant: ProviderQuota) => ({
    pool: providerQuotaWindows(variant, "measured", now),
    pooled: pooledWindows([{ eligible: true, weight: 1, windows: providerQuotaWindows(variant, "measured", now) }], now),
    reset: earliestQuotaResetAt(variant, now),
    families: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"].map(model => [
      anthropicModelPercents(variant, model), anthropicModelWeeklyPercent(variant, model), anthropicModelRankPercent(variant, model)]),
  });
  expect(decisions(quota)).toEqual(decisions(routedOnly));
  expect(decisions(louder)).toEqual(decisions(routedOnly));
  // The binding weekly_all row (91%, critical) still drives routing; Fable's 4% does not.
  expect(providerQuotaWindows(quota, "measured", now).map(row => [row.id, row.usedPercent])).toEqual([["5h", 35], ["weekly", 91]]);
  expect(anthropicModelPercents(quota, "claude-fable-5-2")).not.toContain(4);
  expect(rawAnthropicUsageWindows(inactiveFableShareUsage, now).some(row => row.window === "fable")).toBe(false);
});

test("plans that report no Fable row get no Fable bar", async () => {
  for (const body of [maxTeamInactiveWeeklyUsage, maxTeamInactiveSessionUsage]) {
    const quota = await parse(body);
    expect(quota?.displayWindows).toBeUndefined();
    expect(quota?.customWindows ?? []).toEqual([]);
  }
});
test("cached quota windows drop a weekly share outside (0, 100] and keep the row", () => {
  const future = now + 3_600_000;
  const quota = normalizeAnthropicQuota({ weeklyPercent: 40, weeklyResetAt: future, updatedAt: now,
    customWindows: [{ label: "Opus", scope: "model", percent: 10, resetAt: future, weeklyAllowancePercent: 0 }],
    displayWindows: [
      { label: "Fable", scope: "model", percent: 4, resetAt: future, weeklyAllowancePercent: 1e9 },
      { label: "Sonnet", scope: "model", percent: 5, resetAt: future, weeklyAllowancePercent: "<b>" as never },
    ] }, now);
  expect(quota?.customWindows).toEqual([{ label: "Opus", scope: "model", percent: 10, resetAt: future }]);
  expect(quota?.displayWindows).toEqual([
    { label: "Fable", scope: "model", percent: 4, resetAt: future },
    { label: "Sonnet", scope: "model", percent: 5, resetAt: future },
  ]);
  const valid = { label: "Fable", scope: "model" as const, percent: 4, resetAt: future, weeklyAllowancePercent: 50 };
  expect(normalizeAnthropicQuota({ weeklyPercent: 40, weeklyResetAt: future, updatedAt: now, displayWindows: [valid] }, now)?.displayWindows)
    .toEqual([valid]);
});
