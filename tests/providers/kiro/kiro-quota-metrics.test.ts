import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, replaceProviderAccountSet, saveCredential } from "../../../src/oauth/store";
import { oauthAccountLogLabel } from "../../../src/codex/account-label";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import { cachedKiroQuotaMetricRows } from "../../../src/providers/kiro-quota-metrics";
import { sanitizeKiroQuota } from "../../../src/providers/kiro-account-state-disk";
import { createRequestMetricsOwner } from "../../../src/server/request-metrics";
import { BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS, removeTreeAfterBackgroundWork } from "../../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const realFetch = globalThis.fetch;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-metric-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  clearAccountQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  await removeTreeAfterBackgroundWork(home);
}, BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS);

async function account(id: string) {
  await saveCredential("kiro", { access: `access-${id}`, refresh: `refresh-${id}`,
    expires: Date.now() + 3600_000, accountId: id }, { addAccount: true });
  return getAccountSet("kiro")!.accounts.find(a => a.credential.accountId === id)!;
}
function seed(id: string, updatedAt: number, resetAt?: number) {
  setCachedProviderAccountQuotaForTests("kiro", id, { monthlyPercent: 25,
    kiroCreditsUsed: 2.5, kiroCreditsLimit: 10, updatedAt,
    ...(resetAt !== undefined ? { monthlyResetAt: resetAt } : {}) });
}

test("fresh cached credits yield four opaque gauges without probing", async () => {
  const now = Date.now();
  const a = await account("person@example.com");
  seed(a.id, now, now + 60_000);
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("scrape probed upstream"); }) as typeof fetch;
  const output = createRequestMetricsOwner(1, () => cachedKiroQuotaMetricRows(now)).snapshot();
  expect(calls).toBe(0);
  const rows = cachedKiroQuotaMetricRows(now);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.secondsToReset).toBe(60);
  expect(rows[0]!.account).toMatch(/^o[0-9a-f]{6}$/);
  for (const name of ["used_credits", "limit_credits", "used_percent", "seconds_to_reset"]) {
    expect(output).toContain(`# TYPE opencodex_kiro_quota_${name} gauge`);
    expect(output).toContain(`opencodex_kiro_quota_${name}{account="${rows[0]!.account}"}`);
  }
  expect(output).not.toContain("person@example.com");
  expect(output).not.toContain(a.id);
});

test("future, stale, reset-passed, and identity-mismatched rows are omitted", async () => {
  const now = Date.now();
  const a = await account("future");
  seed(a.id, now + 1_000);
  expect(cachedKiroQuotaMetricRows(now)).toEqual([]);
  seed(a.id, now - 31 * 60_000);
  expect(cachedKiroQuotaMetricRows(now)).toEqual([]);
  seed(a.id, now, now - 1);
  expect(cachedKiroQuotaMetricRows(now)).toEqual([]);
  seed(a.id, now);
  const { accountQuotaCache, accountCacheKey } = await import("../../../src/providers/quota/account-cache");
  accountQuotaCache.get(accountCacheKey("kiro", a.id))!.identity = "old-login";
  expect(cachedKiroQuotaMetricRows(now)).toEqual([]);
});

test("stale leading accounts do not hide 32 later valid distinct gauges", async () => {
  const now = Date.now();
  const accounts = Array.from({ length: 35 }, (_, i) => {
    const identity = String(i).padStart(3, "0");
    return { id: createHash("sha256").update(identity).digest("hex").slice(0, 32),
      credential: { access: `access-${identity}`, refresh: `refresh-${identity}`, expires: now + 3_600_000, accountId: identity },
      addedAt: now, loginId: randomUUID() };
  }).sort((a, b) => a.id.localeCompare(b.id));
  // Exercise the real store once; this regression covers projection order, not repeated logins.
  await replaceProviderAccountSet("kiro", { activeAccountId: accounts[34]!.id, accounts });
  const stored = getAccountSet("kiro")!.accounts;
  expect(stored.map(row => row.id)).toEqual(accounts.map(row => row.id));
  expect(new Set(stored.map(row => row.credential.accountId)).size).toBe(35);
  for (let i = 0; i < stored.length; i++) seed(stored[i]!.id, i < 3 ? now - 31 * 60_000 : now);
  const rows = cachedKiroQuotaMetricRows(now);
  expect(rows).toHaveLength(32);
  expect(new Set(rows.map(row => row.account)).size).toBe(32);
  expect(rows.map(row => row.account)).toEqual(stored.slice(3).map(row => oauthAccountLogLabel(row.id, "kiro")));
});

test("duplicate or malformed labels never produce a second Prometheus series", () => {
  const output = createRequestMetricsOwner(1, () => [
    { account: "oabcdef", used: 1, limit: 10, percent: 10 },
    { account: "oabcdef", used: 2, limit: 10, percent: 20 },
    { account: "person@example.com", used: 3, limit: 10, percent: 30 },
  ]).snapshot();
  expect(output.match(/^opencodex_kiro_quota_used_credits\{account=/gm)).toHaveLength(1);
  expect(output).not.toContain("person@example.com");
});

test("disk sanitizer preserves valid precise plan credits only", () => {
  expect(sanitizeKiroQuota({ monthlyPercent: 25, kiroCreditsUsed: 2.5,
    kiroCreditsLimit: 10, updatedAt: 1 })).toMatchObject({
    kiroCreditsUsed: 2.5, kiroCreditsLimit: 10,
  });
  const invalid = sanitizeKiroQuota({ monthlyPercent: 25, kiroCreditsUsed: -2,
    kiroCreditsLimit: Infinity, updatedAt: 1 });
  expect(invalid.kiroCreditsUsed).toBeUndefined();
  expect(invalid.kiroCreditsLimit).toBeUndefined();
});

test("a metrics scrape never hydrates the disk snapshot; routing does", async () => {
  const { writeFileSync } = await import("node:fs");
  const { getConfigDir } = await import("../../../src/config");
  const { kiroEvidenceIdentity } = await import("../../../src/providers/kiro-account-state-disk");
  const { kiroAccountEvidence } = await import("../../../src/providers/kiro-usage");
  const a = await account("disk");
  const now = Date.now();
  clearAccountQuotaCache();
  writeFileSync(join(getConfigDir(), "provider-account-quota-cache.json"), JSON.stringify({
    version: 1,
    rows: { [`kiro\u0000${a.id}`]: { monthlyPercent: 40, kiroCreditsUsed: 4, kiroCreditsLimit: 10,
      updatedAt: now - 1_000, identity: kiroEvidenceIdentity(a) } },
  }));
  expect(cachedKiroQuotaMetricRows(now)).toEqual([]);
  expect(kiroAccountEvidence(a, now).quotaPercent).toBe(40);
  expect(cachedKiroQuotaMetricRows(now)).toHaveLength(1);
});

