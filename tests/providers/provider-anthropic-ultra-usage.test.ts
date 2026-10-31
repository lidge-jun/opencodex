import { afterEach, expect, test } from "bun:test";
import fixture from "../fixtures/anthropic-ultra-usage.json";
import { probeAnthropicUsageQuota } from "../../src/providers/claude-cli-usage";
import { rawAnthropicUsageWindows } from "../../src/providers/quota/anthropic-decision-windows";
import { hasAnthropicFamilyEnumeration } from "../../src/providers/quota/anthropic-family-headers";
import { resolveAnthropicAccountIdentity } from "../../src/oauth/anthropic-identity";
import { anthropicModelPercents } from "../../src/oauth/anthropic-model-quota";
import { providerQuotaWindows } from "../../src/quota-pool/assemble";
import { detectQuotaReset } from "../../src/quota/reset-detector";
import { parseAnthropicResetGrantStatus } from "../../src/providers/anthropic-reset-grants";

// Key/type layout follows GET observations; all values are synthetic. Null five_hour
// and the Ultra alias follow the operator's browser observation, not an account dump.
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
async function probe(body: unknown) {
  globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
  return probeAnthropicUsageQuota("synthetic-access");
}
const observedAt = Date.parse("2030-01-01T00:00:00Z");

test("Ultra null five_hour succeeds with limits-first weekly and no inactive family", async () => {
  const result = await probe(fixture);
  expect(result.failure).toBeUndefined();
  expect(result.quota).toMatchObject({ weeklyPercent: 37, weeklyResetAt: Date.parse("2030-01-09T00:00:00Z") });
  expect(result.quota!.fiveHourPercent).toBeUndefined();
  expect(result.quota!.customWindows ?? []).toEqual([]);
  expect(hasAnthropicFamilyEnumeration(result.quota!)).toBe(true);
  expect(rawAnthropicUsageWindows(fixture, observedAt)).toEqual([
    { window: "weekly", percent: 37, resetAt: Date.parse("2030-01-09T00:00:00Z"), observedAt },
  ]);
});

test("limits-only usage succeeds and unknown entries cannot poison known windows", async () => {
  const body = { five_hour: null, limits: [...fixture.limits, null, { kind: "future_window", percent: 100 }] };
  const result = await probe(body);
  expect(result.failure).toBeUndefined();
  expect(result.quota?.weeklyPercent).toBe(37);
  expect(result.quota?.customWindows ?? []).toEqual([]);
});

test("only explicitly active scoped limits block their recognized model family", async () => {
  const active = structuredClone(fixture);
  active.limits[1]!.is_active = true;
  const { quota } = await probe(active);
  expect(quota!.customWindows).toEqual([{ label: "Fable", scope: "model", percent: 100, resetAt: Date.parse("2030-01-09T00:00:00Z") }]);
  expect(anthropicModelPercents(quota, "claude-fable-5")).toEqual([37, 100]);
  expect(anthropicModelPercents(quota, "claude-opus-5-5")).toEqual([37]);
  expect(rawAnthropicUsageWindows(active, observedAt).map(row => row.window)).toEqual(["weekly", "fable"]);
  for (const is_active of [false, undefined, null, "true"]) {
    const result = await probe({ limits: [{ ...active.limits[1], is_active }], seven_day: { utilization: 10 } });
    expect(result.quota!.customWindows ?? []).toEqual([]);
  }
});

test("legacy payloads still work; unusable modern shared counters fall back", async () => {
  const legacy = { five_hour: { utilization: 12 }, seven_day: { utilization: 24 }, seven_day_opus: { utilization: 36 } };
  const { quota } = await probe(legacy);
  expect(quota).toMatchObject({ fiveHourPercent: 12, weeklyPercent: 24, customWindows: [{ label: "Opus", scope: "model", percent: 36 }] });
  expect(rawAnthropicUsageWindows(legacy, observedAt).map(row => row.percent)).toEqual([12, 24, 36]);
  const result = await probe({ ...legacy, limits: [{ kind: "weekly_all", percent: "unusable" }] });
  expect(result.quota?.weeklyPercent).toBe(24);
});

test("session limits take precedence, but explicit null session stays absent", async () => {
  const body = { five_hour: { utilization: 98 }, limits: [{ kind: "session", percent: 18 }] };
  expect((await probe(body)).quota?.fiveHourPercent).toBe(18);
  expect(rawAnthropicUsageWindows(body, observedAt)[0]?.percent).toBe(18);
  const noSession = { ...body, five_hour: null, seven_day: { utilization: 12 } };
  expect((await probe(noSession)).quota?.fiveHourPercent).toBeUndefined();
  expect(rawAnthropicUsageWindows(noSession, observedAt).map(row => row.window)).toEqual(["weekly"]);
});

test("raw decisions preserve invalid reset and unclamped utilization without duplicate legacy rows", async () => {
  const body = { seven_day: { utilization: 1 }, limits: [{ kind: "weekly_all", percent: 101, resets_at: "invalid" }] };
  const rows = rawAnthropicUsageWindows(body, observedAt);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.percent).toBe(101);
  expect(Number.isNaN(rows[0]?.resetAt)).toBe(true);
  expect((await probe(body)).quota?.weeklyPercent).toBe(100);
});

test("weekly-only quota projects no synthetic 5h window or reset; grants tolerate additive fields", async () => {
  const { quota } = await probe(fixture);
  const windows = providerQuotaWindows(quota!, "measured", Date.now());
  expect(windows.map(row => row.id)).toEqual(["weekly"]);
  expect(windows[0]?.usedPercent).toBe(37);
  expect(detectQuotaReset({ scope: "anthropic", accountTag: "synthetic", previous: { window: "5h", percent: 90 },
    next: { window: "5h", percent: quota!.fiveHourPercent }, now: observedAt })).toBeNull();
  expect(parseAnthropicResetGrantStatus(fixture.cedar_ember)).toMatchObject({ eligible: false, grants: [] });
});

for (const tier of ["ultra", "claude_ultra", "claude_max_20x", "default_claude_max_20x", "max_20x"]) {
  test(`profile plan ${tier} shares max_20x without changing identity proof`, async () => {
    globalThis.fetch = (async () => Response.json({ account: { uuid: "synthetic-account" }, organization: { rate_limit_tier: tier } })) as typeof fetch;
    expect(await resolveAnthropicAccountIdentity("synthetic-access")).toMatchObject({ accountUuid: "synthetic-account", plan: "max_20x" });
  });
}

test("empty/malformed responses stay unavailable and HTTP 429 stays rate_limited", async () => {
  for (const body of [{}, { five_hour: null }, { limits: [{ kind: "weekly_all", percent: {} }] }, null]) {
    expect(await probe(body)).toEqual({ quota: null, failure: "response_unusable" });
  }
  globalThis.fetch = (async () => Response.json({ error: { message: "synthetic-private-detail" } }, { status: 429 })) as typeof fetch;
  expect(await probeAnthropicUsageQuota("synthetic-access")).toEqual({ quota: null, failure: "rate_limited" });
});
