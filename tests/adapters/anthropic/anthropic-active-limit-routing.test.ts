import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential } from "../../../src/oauth/store";
import { captureAnthropicCooldownRecovery, clearAnthropicAccountPoolState, getAnthropicAccountHealthSnapshot,
  pickAlternateAnthropicAccount, recordAnthropicAccount429, settleAnthropicCooldownRecovery } from "../../../src/oauth/anthropic-routing";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import { anthropicFamilyRejected, observeAnthropicFamilyQuota } from "../../../src/oauth/anthropic-model-quota";
import { probeAnthropicQuotaWithRecovery } from "../../../src/providers/quota/anthropic-cooldown-recovery";
import { hasAnthropicFamilyEnumeration } from "../../../src/providers/quota/anthropic-family-headers";
import { anthropicModelPercents } from "../../../src/oauth/anthropic-model-quota";
import { providerQuotaWindows } from "../../../src/quota-pool/assemble";
import { probeAnthropicUsageQuota } from "../../../src/providers/claude-cli-usage";
import { ultraUsage } from "../../fixtures/anthropic-usage-shapes";

/** A weekly reset relative to now, so cached windows never expire mid-suite on a later date. */
const futureWeeklyReset = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
import { drainAndRemoveFixtureRoots } from "../../helpers/fixture-teardown";
import type { OcxConfig } from "../../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
const config = { port: 0, defaultProvider: "anthropic",
  providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" } },
  anthropicAccountPool: { enabled: true, strategy: "quota", quotaWindow: "weekly" } } as OcxConfig;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-active-limits-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
  await drainAndRemoveFixtureRoots({ roots: [{ path: home }], restoreEnvironment: () => {
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
  } });
});
async function seed() {
  for (const suffix of ["a", "b"]) await saveCredential("anthropic", {
    access: `synthetic-active-${suffix}`, refresh: `synthetic-refresh-${suffix}`,
    expires: Date.now() + 3_600_000, accountId: `synthetic-account-${suffix}`,
  });
  return getAccountSet("anthropic")!.accounts.map(row => row.id);
}
async function parse(body: unknown) {
  globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
  return (await probeAnthropicUsageQuota("synthetic-active-bearer")).quota!;
}

for (const active of [false, true]) test(`real pool selection applies active=${active} Fable only to Fable`, async () => {
  const [a, b] = await seed();
  const quota = await parse({ five_hour: null, seven_day_fable: { utilization: 100 }, limits: [
    { kind: "weekly_all", percent: 10, is_active: true, resets_at: futureWeeklyReset() },
    { kind: "weekly_scoped", percent: 100, is_active: active, resets_at: futureWeeklyReset(),
      scope: { model: { display_name: "Fable" } } },
  ] });
  setCachedProviderAccountQuotaForTests("anthropic", a!, quota);
  setCachedProviderAccountQuotaForTests("anthropic", b!, { weeklyPercent: 20, updatedAt: Date.now() });
  expect(pickAlternateAnthropicAccount(config, "outside-pool", Date.now(), null, "claude-sonnet-5-5")).toBe(a!);
  expect(pickAlternateAnthropicAccount(config, "outside-pool", Date.now(), null, "claude-fable-5")).toBe(active ? b! : a!);
});

test("null or explicitly inactive 5h does not fabricate evidence to clear an earlier 5h refusal", async () => {
  const [id] = await seed();
  const now = Date.now();
  recordAnthropicAccount429(config, id!, "3600", now, new Headers({
    "anthropic-ratelimit-unified-5h-status": "rejected",
  }));
  const claim = captureAnthropicCooldownRecovery(id!, now)!;
  expect(claim).not.toBeNull();
  for (const body of [ultraUsage, { ...ultraUsage, five_hour: null, limits: [
    ...ultraUsage.limits, { kind: "session", is_active: false, percent: 0 },
  ] }]) {
    const quota = await parse(body);
    expect(quota.fiveHourPercent).toBeUndefined();
    expect(settleAnthropicCooldownRecovery(claim, quota)).toBe("retained");
    expect(getAnthropicAccountHealthSnapshot(id!)).not.toBeNull();
  }
});


test("RR1 inactive exhausted weekly excludes all models", async () => {
  const [a, b] = await seed();
  const quota = await parse({ limits: [{ kind: "weekly_all", percent: 100, is_active: false, resets_at: futureWeeklyReset() }] });
  for (const model of ["claude-sonnet-5-5", "claude-fable-5"]) expect(anthropicModelPercents(quota, model)).toContain(100);
  expect(providerQuotaWindows(quota, "measured", Date.now()).find(row => row.id === "weekly")?.exhausted).toBe(true);
  setCachedProviderAccountQuotaForTests("anthropic", a!, quota);
  setCachedProviderAccountQuotaForTests("anthropic", b!, { weeklyPercent: 20, updatedAt: Date.now() });
  for (const model of ["claude-sonnet-5-5", "claude-fable-5"]) expect(pickAlternateAnthropicAccount(config, "outside-pool", Date.now(), null, model)).toBe(b!);
});

test("RR2 inactive weekly headroom settles pending weekly cooldown", async () => {
  const [id] = await seed();
  const now = Date.now();
  recordAnthropicAccount429(config, id!, "3600", now, new Headers({ "anthropic-ratelimit-unified-7d-status": "rejected" }));
  const claim = captureAnthropicCooldownRecovery(id!, now)!;
  const quota = await parse({ limits: [{ kind: "weekly_all", is_active: false, percent: 55, resets_at: new Date(now + 3600000).toISOString() }] });
  expect(settleAnthropicCooldownRecovery(claim, quota)).toBe("cleared");
});

test("G5 malformed shared data neither clears cooldown nor revives stale exhaustion", async () => {
  const [id] = await seed();
  const now = Date.now();
  recordAnthropicAccount429(config, id!, "3600", now, new Headers({ "anthropic-ratelimit-unified-7d-status": "rejected" }));
  const claim = captureAnthropicCooldownRecovery(id!, now)!;
  for (const stale of [0, 100]) {
    const quota = await parse({ five_hour: { utilization: 1 }, seven_day: { utilization: stale }, limits: [{ kind: "weekly_all", is_active: true, percent: "x" }] });
    expect(anthropicModelPercents(quota, "claude-fable-5")).toEqual([1]);
    expect(settleAnthropicCooldownRecovery(claim, quota)).toBe("retained");
  }
});

async function familyRecovery(body: unknown, expectedEnumeration: boolean, retained: boolean) {
  const [id] = await seed();
  const credentials = getAccountSet("anthropic")!.accounts.find(row => row.id === id)!.credential;
  observeAnthropicFamilyQuota(id!, [{ label: "Fable", scope: "model", percent: 100, rejected: true }], Date.now());
  expect(anthropicFamilyRejected(id!, "claude-fable-5")).toBe(true);
  const quota = await parse(body);
  expect(hasAnthropicFamilyEnumeration(quota)).toBe(expectedEnumeration);
  const result = await probeAnthropicQuotaWithRecovery(id!, credentials.access, async () => quota, () => true);
  expect(result).not.toBeNull();
  expect(anthropicFamilyRejected(id!, "claude-fable-5")).toBe(retained);
}
const inactiveFable = { kind: "weekly_scoped", is_active: false, percent: 0, scope: { model: { display_name: "Fable" } } };
test("R7 malformed inactive Ultra session retains passive Fable refusal", async () => {
  await familyRecovery({ five_hour: null, seven_day: { utilization: 1 }, limits: [{ kind: "session", is_active: false, percent: "x" }, inactiveFable] }, false, true);
});
for (const duplicate of [false, true]) test(`G6 incomplete shared enumeration retains family refusal duplicate=${duplicate}`, async () => {
  const rows = duplicate ? [{ kind: "weekly_all", is_active: true, percent: 1 }, { kind: "weekly_all", is_active: true, percent: 2 }]
    : [{ kind: "weekly_all", is_active: true, percent: "x" }];
  await familyRecovery({ five_hour: { utilization: 1 }, limits: [...rows, inactiveFable] }, false, true);
});
test("G6 complete enumeration retires passive Fable refusal", async () => {
  await familyRecovery({ limits: [{ kind: "weekly_all", is_active: true, percent: 1 }, inactiveFable] }, true, false);
});
