import { describe, expect, test } from "bun:test";
import { parseZcodeQuota, parseZcodeQuotaSnapshot, readZcodeQuota, type QuotaContext, type ZcodeQuotaSnapshot } from "../../src/adapters/zcode/quota";
import { getCachedProviderQuota, replaceCachedProviderQuotas } from "../../src/providers/quota-routing-cache";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

const now = 1_789_112_000_000;
const window = (unit = 3, number = 5) => ({ type: "CREDIT_LIMIT", unit, number, usage: 1000, remaining: 750, percentage: 25, nextResetTime: now + 3600000 });
const snapshot = (limits: unknown[]) => ({ generatedAt: now, limits });
const provider = { adapter: "zcode", baseUrl: "https://zcode.z.ai", authMode: "local" as const };
const context = (identity = "account-a"): QuotaContext => ({ identity, runtimeRoot: "/official", config: "/isolated/config.json", managed: true, sourceProvider: "builtin:zai-coding-plan" });

describe("ZCode native subscription quota", () => {
  test("maps real remaining credits and resets into the shared OpenAI quota contract", () => {
    expect(parseZcodeQuota(snapshot([window(), { ...window(6, 1), remaining: 100 }]), now)).toEqual({
      updatedAt: now, fiveHourPercent: 25, fiveHourResetAt: now + 3600000,
      weeklyPercent: 90, weeklyResetAt: now + 3600000,
    });
    expect(parseZcodeQuota(snapshot([{ ...window(), remaining: 997.5, percentage: 1 }]), now)?.fiveHourPercent).toBeCloseTo(0.25);
  });
  test("zero balance is exhausted; missing, impossible or stale data never becomes full balance", () => {
    expect(parseZcodeQuota(snapshot([{ ...window(), remaining: 0 }]), now)?.fiveHourPercent).toBe(100);
    for (const limits of [[], [null], [{ ...window(), remaining: -1 }], [{ ...window(), usage: 0 }], [{ ...window(), remaining: 1001 }], [{ ...window(), remaining: NaN }], [window(), window()]]) {
      expect(parseZcodeQuota(snapshot(limits), now)).toBeNull();
    }
    expect(parseZcodeQuota(snapshot([window()]), now + 31 * 60_000)).toBeNull();
    expect(parseZcodeQuota({ generatedAt: now + 120_000, limits: [window()] }, now)).toBeNull();
  });
  test("does not guess unnamed windows or invent missing weekly limits", () => {
    expect(parseZcodeQuota(snapshot([{ ...window(), unit: 7 }, { type: "TIME_LIMIT", remaining: 100 }]), now)).toBeNull();
    expect(parseZcodeQuotaSnapshot(snapshot([{ ...window(), unit: 7 }, { type: "TIME_LIMIT", remaining: 100 }]), now)).toEqual({ kind: "empty" });
    expect(parseZcodeQuotaSnapshot(snapshot([null]), now)).toBeNull();
    expect(parseZcodeQuotaSnapshot(snapshot([
      ...Array.from({ length: 20 }, () => ({ type: "TIME_LIMIT" })), window(),
    ]), now)).toMatchObject({ kind: "quota", quota: { fiveHourPercent: 25 } });
    expect(parseZcodeQuotaSnapshot({ generatedAt: now - 31 * 60_000, limits: [] }, now)).toBeNull();
    expect(parseZcodeQuota(snapshot([window()]), now)?.weeklyPercent).toBeUndefined();
    expect(parseZcodeQuota(snapshot([{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40 }]), now)?.weeklyPercent).toBe(40);
  });
  test("coalesces native reads and discards snapshots after account change", async () => {
    let calls = 0; let identity = "account-a";
    let finish!: (value: ZcodeQuotaSnapshot | null) => void;
    const deps = { context: () => context(identity), probe: async () => { calls++; return new Promise<ZcodeQuotaSnapshot | null>(resolve => { finish = resolve; }); } };
    const first = readZcodeQuota(provider, deps); const second = readZcodeQuota(provider, deps);
    expect(calls).toBe(1);
    identity = "account-b";
    finish(parseZcodeQuotaSnapshot(snapshot([window()]), now));
    expect(await first).toBeNull(); expect(await second).toBeNull();
  });
  test("unavailable runtime has no direct API fallback", async () => {
    expect(await readZcodeQuota(provider, { context: () => { throw new Error("not configured"); } })).toBeNull();
    const bootstrap = readFileSync(repoPath("src/adapters/zcode/quota-bootstrap.cjs"), "utf8");
    expect(bootstrap).toContain("getEntitlementSnapshot");
    expect(bootstrap).not.toMatch(/\bfetch\s*\(|https\.request|useCodingPlanReset|session\/send/);
  });
  test("preserves unavailable and authoritative-empty probe states separately", async () => {
    expect(await readZcodeQuota(provider, { context: () => context(), probe: async () => null })).toBeNull();
    expect(await readZcodeQuota(provider, { context: () => context(), probe: async () => ({ kind: "empty" }) })).toEqual({
      identity: "account-a", kind: "empty",
    });
  });
  test("display snapshots do not change automatic routing policy", () => {
    replaceCachedProviderQuotas([{ provider: "zcode", label: "ZCode", source: "zcode-desktop", updatedAt: now, quota: { updatedAt: now, fiveHourPercent: 100 } }]);
    expect(getCachedProviderQuota("zcode", now)).toBeNull();
  });
});

test("concurrent saved accounts receive only their own quota snapshots", async () => {
  const a = { ...provider, zcodeAccountId: "account-a" }, b = { ...provider, zcodeAccountId: "account-b" };
  let calls = 0;
  const deps = { context: (p: { zcodeAccountId?: string }) => context(p.zcodeAccountId!), probe: async (c: QuotaContext) => {
    calls++; await new Promise(r => setTimeout(r, 5));
    return { kind: "quota" as const, quota: { updatedAt: now, fiveHourPercent: c.identity === "account-a" ? 10 : 90 } };
  } };
  const [first, repeated, second] = await Promise.all([readZcodeQuota(a, deps), readZcodeQuota(a, deps), readZcodeQuota(b, deps)]);
  expect(calls).toBe(2);
  expect(first).toEqual(repeated);
  expect(first).toMatchObject({ identity: "account-a", kind: "quota", quota: { fiveHourPercent: 10 } });
  expect(second).toMatchObject({ identity: "account-b", kind: "quota", quota: { fiveHourPercent: 90 } });
});
