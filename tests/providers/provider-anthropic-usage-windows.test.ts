import { afterEach, expect, test } from "bun:test";
import { probeAnthropicUsageQuota } from "../../src/providers/claude-cli-usage";
import { rawAnthropicUsageWindows } from "../../src/providers/quota/anthropic-decision-windows";
import { hasAnthropicFamilyEnumeration } from "../../src/providers/quota/anthropic-family-headers";
import { anthropicModelPercents } from "../../src/oauth/anthropic-model-quota";
import { resolveAnthropicAccountIdentity } from "../../src/oauth/anthropic-identity";
import { providerQuotaWindows } from "../../src/quota-pool/assemble";
import { pooledWindows } from "../../src/quota-pool/pooled";
import { anthropicResetGrantBlocker, parseAnthropicResetGrantStatus } from "../../src/providers/anthropic-reset-grants";
import { inactiveSessionUsage, maxTeamInactiveWeeklyUsage, maxTeamInactiveSessionUsage, legacyMax20xUsage, noResetGrant, ultraUsage, weeklyReset } from "../fixtures/anthropic-usage-shapes";

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

test("Ultra null 5h and inactive Fable publish only the weekly window", async () => {
  const quota = await parse(ultraUsage);
  expect(quota?.fiveHourPercent).toBeUndefined();
  expect(quota?.weeklyPercent).toBe(53);
  expect(quota?.customWindows ?? []).toEqual([]);
  expect(rawAnthropicUsageWindows(ultraUsage, now).map(row => row.window)).toEqual(["weekly"]);
  expect(hasAnthropicFamilyEnumeration(quota!)).toBe(true);
  expect(providerQuotaWindows(quota!, "measured", now).map(row => row.id)).toEqual(["weekly"]);
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
