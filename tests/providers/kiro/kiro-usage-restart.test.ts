import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential } from "../../../src/oauth/store";
import { resolveKiroRequestProfile } from "../../../src/oauth/kiro";
import { clearAccountQuotaCache, fetchProviderAccountQuotas, getCachedProviderAccountQuota,
  setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import { fetchKiroUsageSnapshot, kiroUsageContextForAccount } from "../../../src/providers/kiro-usage";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const realFetch = globalThis.fetch;
let home: string;
const arn = "arn:aws:codewhisperer:eu-west-1:123456789012:profile/TEST";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-usage-restart-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccountQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function payload(status = "DISABLED", used = 100) {
  return { usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: used, usageLimit: 100 }],
    overageConfiguration: { overageStatus: status }, nextDateReset: Math.floor(Date.now() / 1000) + 3600 };
}

describe("Kiro usage restart", () => {
  test("probe and runtime use the same request-profile resolver", async () => {
    await saveCredential("kiro", { access: "a", refresh: "r", expires: Date.now() + 3600_000,
      accountId: "builder", kiro: { clientId: "client", clientSecret: "secret", apiRegion: "eu-west-1" } });
    const builder = getAccountSet("kiro")!.accounts[0]!;
    const builderCtx = await kiroUsageContextForAccount(builder.id);
    expect(builderCtx.profileArn).toBe(resolveKiroRequestProfile({
      profileArn: builder.credential.kiro?.profileArn, authType: "aws_sso_oidc",
    }).profileArn);
    expect(builderCtx.builderIdFallback).toBe(true);
    await saveCredential("kiro", { access: "b", refresh: "r2", expires: Date.now() + 3600_000,
      accountId: "enterprise", kiro: { profileArn: arn, apiRegion: "us-east-1" } });
    const enterprise = getAccountSet("kiro")!.accounts.find(row => row.credential.accountId === "enterprise")!;
    const enterpriseCtx = await kiroUsageContextForAccount(enterprise.id);
    expect(enterpriseCtx.profileArn).toBe(resolveKiroRequestProfile({ profileArn: arn }).profileArn);
    expect(enterpriseCtx.builderIdFallback).toBeUndefined();
  });

  test("non-OIDC missing ARN makes no usage request and keeps same-login last good bar", async () => {
    await saveCredential("kiro", { access: "a", refresh: "r", expires: Date.now() + 3600_000,
      accountId: "enterprise", kiro: { apiRegion: "eu-west-1" } });
    const id = getAccountSet("kiro")!.activeAccountId;
    setCachedProviderAccountQuotaForTests("kiro", id, { monthlyPercent: 42, updatedAt: Date.now() });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify(payload()), { status: 200 }); }) as typeof fetch;
    const before = calls;
    const result = (await fetchProviderAccountQuotas("kiro", true))[0]!;
    expect(calls).toBe(before);
    expect(result.unavailable).toBe(true);
    expect(getCachedProviderAccountQuota("kiro", id)?.monthlyPercent).toBe(42);
  });

  test("unknown overage status cannot exhaust an account", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(payload("FUTURE", 100)), { status: 200 })) as typeof fetch;
    const snapshot = await fetchKiroUsageSnapshot({ accountId: "a", access: "token", profileArn: arn });
    expect(snapshot?.quota.monthlyPercent).toBe(100);
    expect(snapshot?.exhausted).toBe(false);
  });

  test("unrecognised usage body stays unknown", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ usageBreakdownList: [{ resourceType: "FUTURE" }] }),
      { status: 200 })) as typeof fetch;
    expect(await fetchKiroUsageSnapshot({ accountId: "a", access: "token", profileArn: arn })).toBeNull();
  });
});
