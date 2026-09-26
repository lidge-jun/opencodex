import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, mergeAccountCredential, removeAccount, saveAccountCredential,
  saveCredential, saveCredentialWithReceipt, setActiveAccount } from "../../../src/oauth/store";
import type { ProviderAccount } from "../../../src/oauth/types";
import { isAccountQuotaExhausted, rankAccountsByHeadroom } from "../../../src/oauth/account-quota-rank";
import { preferredInitialAccount } from "../../../src/oauth/generic-account-failover";
import { cancelPendingAccountQuotaPersist, readPersistedAccountQuotas,
  readPersistedKiroVerdicts } from "../../../src/providers/account-quota-disk";
import { kiroEvidenceIdentity } from "../../../src/providers/kiro-account-state-disk";
import { kiroAccountEvidence, getKiroAccountExhaustion } from "../../../src/providers/kiro-usage";
import { clearAccountQuotaCache, fetchProviderAccountQuotas, getCachedProviderAccountQuota } from "../../../src/providers/quota";
import { accountCacheKey, accountQuotaCache, persistAccountQuotaCache,
  reconcileProviderAccountQuotaRows, resetProviderQuotaReconcileStateForTests } from "../../../src/providers/quota/account-cache";
import { ACCOUNT_QUOTA_TTL_MS } from "../../../src/providers/quota-wire";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const priorHome = process.env.OPENCODEX_HOME;
const realFetch = globalThis.fetch;
const file = "provider-account-quota-cache.json";
const arn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/TEST";
const config = { providers: { kiro: { adapter: "kiro", authMode: "oauth" } },
  oauthAccountFailover: { enabled: true } } as unknown as OcxConfig;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-state-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  cancelPendingAccountQuotaPersist();
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(home);
});

async function login(label: string, profileArn = arn): Promise<ProviderAccount> {
  await saveCredential("kiro", { access: `access-${label}`, refresh: `refresh-${label}`,
    expires: Date.now() + 3600_000, accountId: label, kiro: { profileArn } }, { addAccount: true });
  return getAccountSet("kiro")!.accounts.find(row => row.credential.accountId === label)!;
}
function key(account: ProviderAccount) { return accountCacheKey("kiro", account.id); }
function writeEvidence(account: ProviderAccount, percent = 100, exhausted = true,
  updatedAt = Date.now(), observedAt = updatedAt, resetAt = Date.now() + 3600_000) {
  const identity = kiroEvidenceIdentity(account);
  writeFileSync(join(home, file), JSON.stringify({ version: 1,
    rows: { [key(account)]: { monthlyPercent: percent, monthlyResetAt: resetAt, updatedAt, identity } },
    kiroVerdicts: { [key(account)]: { exhausted, resetAt, observedAt, identity } },
  }));
}
async function flush() { await Bun.sleep(350); }
function restart() { clearAccountQuotaCache(); }
function roster() { return new Map(getAccountSet("kiro")!.accounts.map(row => [row.id, row])); }
function response(status = "DISABLED", used = 100) {
  return new Response(JSON.stringify({ usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: used,
    usageLimit: 100 }], overageConfiguration: { overageStatus: status },
    nextDateReset: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
}

describe("Kiro account evidence on disk", () => {
  test("first routing request hydrates exhausted evidence without probing", async () => {
    const active = await login("active");
    const alternate = await login("alternate");
    await setActiveAccount("kiro", active.id);
    writeEvidence(active, 100, true);
    restart();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return response(); }) as typeof fetch;
    expect(preferredInitialAccount(config, "kiro")).toBe(alternate.id);
    expect(calls).toBe(0);
  });

  test("hydrated 100 percent row expires for routing at TTL without a probe", async () => {
    const active = await login("active");
    const alternate = await login("alternate");
    const now = Date.now();
    writeEvidence(active, 100, true, now - ACCOUNT_QUOTA_TTL_MS + 2000,
      now - ACCOUNT_QUOTA_TTL_MS + 2000, now + 3600_000);
    restart();
    expect(isAccountQuotaExhausted("kiro", active.id, undefined, active)).toBe(true);
    expect(rankAccountsByHeadroom("kiro", [active.id, alternate.id], undefined, roster()))
      .toEqual([alternate.id, active.id]);
    await Bun.sleep(2050);
    expect(isAccountQuotaExhausted("kiro", active.id, undefined, active)).toBe(false);
    expect(rankAccountsByHeadroom("kiro", [active.id, alternate.id], undefined, roster()))
      .toEqual([active.id, alternate.id]);
  });

  test("fresh 100% quota without a verdict ranks last but is not excluded", async () => {
    const active = await login("active");
    const alternate = await login("alternate");
    const now = Date.now();
    writeEvidence(active, 100, true, now, now - ACCOUNT_QUOTA_TTL_MS - 1);
    restart();
    expect(kiroAccountEvidence(active).quotaPercent).toBe(100);
    expect(kiroAccountEvidence(active).exhausted).toBeUndefined();
    expect(isAccountQuotaExhausted("kiro", active.id, undefined, active)).toBe(false);
    expect(rankAccountsByHeadroom("kiro", [active.id, alternate.id], undefined, roster()))
      .toEqual([alternate.id, active.id]);
  });

  test("Kiro fill-first threshold reads the roster account evidence", async () => {
    const active = await login("active");
    const alternate = await login("alternate");
    await setActiveAccount("kiro", active.id);
    writeEvidence(active, 90, false);
    restart();
    const fillFirst = { pool: { kernel: true }, providers: { kiro: { adapter: "kiro",
      authMode: "oauth", oauthAccountFailover: { enabled: true, strategy: "fill-first",
        autoSwitchThreshold: 80 } } } } as unknown as OcxConfig;
    expect(preferredInitialAccount(fillFirst, "kiro")).toBe(alternate.id);
  });

  test("two different logins into one identity-less slot invalidate evidence across restart", async () => {
    const first = await saveCredentialWithReceipt("kiro", { access: "first", refresh: "one",
      expires: Date.now() + 3600_000 });
    const account = getAccountSet("kiro")!.accounts[0]!;
    const firstIdentity = kiroEvidenceIdentity(account);
    writeEvidence(account);
    restart();
    const second = await saveCredentialWithReceipt("kiro", { access: "second", refresh: "two",
      expires: Date.now() + 3600_000 });
    const replaced = getAccountSet("kiro")!.accounts[0]!;
    expect(second!.accountId).toBe(first!.accountId);
    expect(replaced.loginId).not.toBe(account.loginId);
    expect(kiroEvidenceIdentity(replaced)).not.toBe(firstIdentity);
    restart();
    expect(kiroAccountEvidence(replaced)).toEqual({});
  });

  test("token refresh retains evidence identity", async () => {
    const account = await login("active");
    const identity = kiroEvidenceIdentity(account);
    await saveAccountCredential("kiro", account.id, { ...account.credential, access: "new", refresh: "new-r" });
    expect(kiroEvidenceIdentity(getAccountSet("kiro")!.accounts[0]!)).toBe(identity);
    await mergeAccountCredential("kiro", account.id, { ...account.credential, access: "newer", expires: Date.now() + 4000_000 });
    expect(kiroEvidenceIdentity(getAccountSet("kiro")!.accounts[0]!)).toBe(identity);
  });

  test("quota and verdict clocks expire independently", async () => {
    const account = await login("active");
    const now = Date.now();
    writeEvidence(account, 75, true, now - ACCOUNT_QUOTA_TTL_MS - 1, now);
    restart();
    expect(kiroAccountEvidence(account)).toMatchObject({ exhausted: true });
    expect(kiroAccountEvidence(account).quotaPercent).toBeUndefined();
    writeEvidence(account, 75, true, now, now - ACCOUNT_QUOTA_TTL_MS - 1);
    restart();
    expect(kiroAccountEvidence(account).quotaPercent).toBe(75);
    expect(kiroAccountEvidence(account).exhausted).toBeUndefined();
  });

  test("overage-enabled verdict survives restart without exclusion", async () => {
    const account = await login("active");
    writeEvidence(account, 100, false);
    restart();
    expect(kiroAccountEvidence(account).exhausted).toBe(false);
    expect(isAccountQuotaExhausted("kiro", account.id, undefined, account)).toBe(false);
  });

  test("failed refresh preserves overage verdict before and after restart", async () => {
    const account = await login("active");
    globalThis.fetch = (async () => response("ENABLED", 120)) as typeof fetch;
    expect((await fetchProviderAccountQuotas("kiro", true))[0]!.quota?.monthlyPercent).toBe(100);
    const original = getKiroAccountExhaustion(key(account), account);
    const updatedAt = getCachedProviderAccountQuota("kiro", account.id)!.updatedAt;
    expect(original?.exhausted).toBe(false);
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    const nullResult = (await fetchProviderAccountQuotas("kiro", true))[0]!;
    expect(nullResult.unavailable).toBe(true);
    expect(nullResult.quota?.updatedAt).toBe(updatedAt);
    expect(getKiroAccountExhaustion(key(account), account)).toEqual(original);
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    const thrown = (await fetchProviderAccountQuotas("kiro", true))[0]!;
    expect(thrown.unavailable).toBe(true);
    expect(thrown.quota?.updatedAt).toBe(updatedAt);
    expect(isAccountQuotaExhausted("kiro", account.id, undefined, account)).toBe(false);
    await flush();
    restart();
    expect(kiroAccountEvidence(account).exhausted).toBe(false);
    expect(getCachedProviderAccountQuota("kiro", account.id)?.updatedAt).toBe(updatedAt);
    restart();
    const failedFirst = (await fetchProviderAccountQuotas("kiro", true))[0]!;
    expect(failedFirst.unavailable).toBe(true);
    expect(kiroAccountEvidence(account).exhausted).toBe(false);
    expect(kiroAccountEvidence(account, Date.now() + ACCOUNT_QUOTA_TTL_MS).exhausted).toBeUndefined();
  });

  test("in-flight old credential cannot commit after slot upgrade", async () => {
    const first = await saveCredentialWithReceipt("kiro", { access: "old", refresh: "old-refresh",
      expires: Date.now() + 3600_000, kiro: { profileArn: arn } });
    const account = getAccountSet("kiro")!.accounts[0]!;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; started(); await held; return response(); }) as typeof fetch;
    const old = fetchProviderAccountQuotas("kiro", true);
    await entered;
    const second = await saveCredentialWithReceipt("kiro", { access: "new", refresh: "new-refresh",
      expires: Date.now() + 3600_000, kiro: { profileArn: arn } });
    expect(second!.accountId).toBe(first!.accountId);
    release();
    await old;
    expect(accountQuotaCache.get(key(account))?.identity).not.toBe(kiroEvidenceIdentity(account));
    expect(getKiroAccountExhaustion(key(account), getAccountSet("kiro")!.accounts[0]!)).toBeNull();
    await fetchProviderAccountQuotas("kiro", true);
    expect(calls).toBe(2);
    await flush();
    expect(readPersistedAccountQuotas().get(key(account))).toMatchObject({ identity: kiroEvidenceIdentity(getAccountSet("kiro")!.accounts[0]!) });
  });

  test("corrupt identity or verdict is unknown", async () => {
    const account = await login("active");
    for (const mutate of [
      (doc: any) => { delete doc.rows[key(account)].identity; delete doc.kiroVerdicts[key(account)].identity; },
      (doc: any) => { doc.rows[key(account)].identity = "bad"; doc.kiroVerdicts[key(account)].identity = "bad"; },
      (doc: any) => { doc.kiroVerdicts[key(account)].exhausted = "true"; delete doc.rows[key(account)]; },
      (doc: any) => { doc.rows[key(account)].updatedAt = Date.now() + 60_000;
        doc.kiroVerdicts[key(account)].observedAt = Date.now() + 60_000; },
      (doc: any) => { doc.rows[key(account)].monthlyResetAt = 1e20;
        doc.kiroVerdicts[key(account)].resetAt = 1e20; },
      (doc: any) => { doc.version = 2; },
    ]) {
      writeEvidence(account);
      const doc = JSON.parse(readFileSync(join(home, file), "utf8"));
      mutate(doc);
      writeFileSync(join(home, file), JSON.stringify(doc));
      restart();
      expect(kiroAccountEvidence(account).exhausted).toBeUndefined();
    }
    writeFileSync(join(home, file), "{broken");
    restart();
    expect(kiroAccountEvidence(account)).toEqual({});
  });

  test("account removal deletes quota and verdict from disk", async () => {
    const account = await login("active");
    writeEvidence(account);
    restart();
    expect(kiroAccountEvidence(account).exhausted).toBe(true);
    await removeAccount("kiro", account.id);
    clearAccountQuotaCache("kiro");
    await flush();
    expect(readPersistedAccountQuotas().has(key(account))).toBe(false);
    expect(readPersistedKiroVerdicts().has(key(account))).toBe(false);
  });

  test("another provider write preserves valid Kiro evidence", async () => {
    const account = await login("active");
    writeEvidence(account);
    const tainted = JSON.parse(readFileSync(join(home, file), "utf8"));
    tainted.rows[key(account)].upstreamMessage = "private-upstream-message";
    writeFileSync(join(home, file), JSON.stringify(tainted));
    restart();
    expect(kiroAccountEvidence(account).exhausted).toBe(true);
    accountQuotaCache.set("cursor\0other", { ts: Date.now(), quota: { monthlyPercent: 30, updatedAt: Date.now() } });
    persistAccountQuotaCache();
    await flush();
    expect(readPersistedAccountQuotas().has(key(account))).toBe(true);
    expect(readPersistedKiroVerdicts().has(key(account))).toBe(true);
    expect(readFileSync(join(home, file), "utf8")).not.toContain("private-upstream-message");
  });

  test("first post-restart reconciliation keeps unrelated disk rows", async () => {
    const account = await login("active");
    writeEvidence(account);
    const doc = JSON.parse(readFileSync(join(home, file), "utf8"));
    doc.rows["cursor\0other"] = { monthlyPercent: 20, updatedAt: Date.now() };
    writeFileSync(join(home, file), JSON.stringify(doc));
    restart();
    reconcileProviderAccountQuotaRows({ generation: 1,
      oauthAccountKeys: new Set([key(account), "cursor\0other"]),
      providerNames: new Set(["kiro", "cursor"]) } as never);
    accountQuotaCache.set("cursor\0new", { ts: Date.now(), quota: { monthlyPercent: 50, updatedAt: Date.now() } });
    persistAccountQuotaCache();
    await flush();
    expect(readPersistedAccountQuotas().has("cursor\0other")).toBe(true);
    expect(readPersistedKiroVerdicts().has(key(account))).toBe(true);
  });

  test("first Kiro routing hydration keeps non-Kiro disk age behavior", async () => {
    const account = await login("active");
    writeEvidence(account);
    const doc = JSON.parse(readFileSync(join(home, file), "utf8"));
    doc.rows["cursor\0other"] = { monthlyPercent: 20, updatedAt: Date.now() - 2 * 3600_000 };
    writeFileSync(join(home, file), JSON.stringify(doc));
    restart();
    expect(kiroAccountEvidence(account).exhausted).toBe(true);
    expect(getCachedProviderAccountQuota("cursor", "other")?.monthlyPercent).toBe(20);
    doc.rows["cursor\0other"].updatedAt = Date.now() - 7 * 3600_000;
    writeFileSync(join(home, file), JSON.stringify(doc));
    restart();
    kiroAccountEvidence(account);
    expect(getCachedProviderAccountQuota("cursor", "other")).toBeNull();
  });

  test("a future-dated non-Kiro row still loads", () => {
    writeFileSync(join(home, file), JSON.stringify({ version: 1,
      rows: { "cursor\0future": { monthlyPercent: 10, updatedAt: Date.now() + 60_000 } } }));
    expect(readPersistedAccountQuotas().has("cursor\0future")).toBe(true);
  });
});
