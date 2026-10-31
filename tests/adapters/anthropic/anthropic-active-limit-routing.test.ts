import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential } from "../../../src/oauth/store";
import { captureAnthropicCooldownRecovery, clearAnthropicAccountPoolState, getAnthropicAccountHealthSnapshot,
  pickAlternateAnthropicAccount, recordAnthropicAccount429, settleAnthropicCooldownRecovery } from "../../../src/oauth/anthropic-routing";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import { probeAnthropicUsageQuota } from "../../../src/providers/claude-cli-usage";
import { ultraUsage, weeklyReset } from "../../fixtures/anthropic-usage-shapes";
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
    { kind: "weekly_all", percent: 10, is_active: true, resets_at: weeklyReset },
    { kind: "weekly_scoped", percent: 100, is_active: active, resets_at: weeklyReset,
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
  for (const body of [ultraUsage, { ...ultraUsage, five_hour: { utilization: 0 }, limits: [
    ...ultraUsage.limits, { kind: "session", is_active: false, percent: 0 },
  ] }]) {
    const quota = await parse(body);
    expect(quota.fiveHourPercent).toBeUndefined();
    expect(settleAnthropicCooldownRecovery(claim, quota)).toBe("retained");
    expect(getAnthropicAccountHealthSnapshot(id!)).not.toBeNull();
  }
});
