import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential } from "../src/oauth/store";
import {
  clearAccountQuotaCache,
  getCachedProviderAccountQuota,
  hasPassiveAccountQuota,
  readPassiveProviderAccountQuotas,
  recordPassiveAccountQuota,
  resetProviderQuotaReconcileStateForTests,
  setCachedProviderAccountQuotaForTests,
  supportsPerAccountQuota,
} from "../src/providers/quota";
import { hasHeadroomEvidence, rankAccountsByHeadroom } from "../src/oauth/account-quota-rank";
import { captureConfigGeneration } from "../src/lib/state-store-sweeper";
import type { ProviderQuota } from "../src/providers/quota-types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

const FIRST = { accountId: "muse-first", email: "first@example.com" };
const SECOND = { accountId: "muse-second", email: "second@example.com" };

function quotaAt(fiveHour: number, updatedAt = Date.now()): ProviderQuota {
  return { fiveHourPercent: fiveHour, weeklyPercent: 10, updatedAt };
}

/**
 * Seed logged-in accounts and return the STORE-ASSIGNED ids.
 *
 * The store derives its slot id by hashing the credential identity
 * (`store.ts:newAccountId`), so the `accountId` handed to `saveCredential` is not the
 * key the cache is filed under. A test that assumed otherwise would pass against a
 * cache that never matched a real account.
 */
async function seedAccounts(...accounts: Array<{ accountId: string; email: string }>): Promise<string[]> {
  for (const account of accounts) {
    await saveCredential("meta-muse", {
      access: `key-${account.accountId}`,
      refresh: `key-${account.accountId}`,
      expires: Number.MAX_SAFE_INTEGER,
      ...account,
    });
  }
  return (getAccountSet("meta-muse")?.accounts ?? []).map(account => account.id);
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-muse-quota-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearAccountQuotaCache();
  // The generation-fence test below reconciles with an empty live-key set, which raises
  // lastReconciledGeneration process-wide. Without this reset every later write in the
  // file would be discarded as stale -- a failure of the harness, not of the code.
  resetProviderQuotaReconcileStateForTests();
});

afterEach(() => {
  clearAccountQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(opencodexHome);
});

describe("passive Muse quota cache", () => {
  /*
   * supportsPerAccountQuota gates fetchAccountQuota, whose fallback sends any
   * non-Kiro/non-Antigravity bearer to Anthropic's usage endpoint. The passive path must
   * never flip it -- this is the exfiltration guard the meta-muse OAuth unit installed.
   */
  test("is passive without entering the probe allowlist", () => {
    expect(hasPassiveAccountQuota("meta-muse")).toBe(true);
    expect(supportsPerAccountQuota("meta-muse")).toBe(false);
  });

  test("ignores providers that are not passive", () => {
    expect(hasPassiveAccountQuota("anthropic")).toBe(false);
    recordPassiveAccountQuota("anthropic", FIRST.accountId, quotaAt(5), captureConfigGeneration());
    expect(getCachedProviderAccountQuota("anthropic", FIRST.accountId)).toBeNull();
  });

  test("writes under the account that served the turn", () => {
    recordPassiveAccountQuota("meta-muse", SECOND.accountId, quotaAt(42), captureConfigGeneration());
    expect(getCachedProviderAccountQuota("meta-muse", SECOND.accountId)?.fiveHourPercent).toBe(42);
    expect(getCachedProviderAccountQuota("meta-muse", FIRST.accountId)).toBeNull();
  });

  test("ignores a write with no account id", () => {
    recordPassiveAccountQuota("meta-muse", "", quotaAt(42), captureConfigGeneration());
    expect(readPassiveProviderAccountQuotas("meta-muse")).toEqual([]);
  });

  test("discards a write whose config generation has been superseded", () => {
    // Generation 0 predates any reconciliation; a stale writer must not commit.
    const { reconcileStateGeneration } = require("../src/lib/state-store-sweeper");
    reconcileStateGeneration({ generation: 0, oauthAccountKeys: new Set<string>(), providerNames: new Set<string>() });
    recordPassiveAccountQuota("meta-muse", FIRST.accountId, quotaAt(42), -1);
    expect(getCachedProviderAccountQuota("meta-muse", FIRST.accountId)).toBeNull();
  });

  test("omits accounts with no observation rather than reporting a failed probe", async () => {
    const [firstId] = await seedAccounts(FIRST, SECOND);
    clearAccountQuotaCache();
    recordPassiveAccountQuota("meta-muse", firstId!, quotaAt(7), captureConfigGeneration());
    const rows = readPassiveProviderAccountQuotas("meta-muse");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(firstId!);
    expect(rows[0]!.quota?.fiveHourPercent).toBe(7);
    expect(rows[0]).not.toHaveProperty("unavailable");
  });

  test("returns nothing for a provider that is not passive", () => {
    setCachedProviderAccountQuotaForTests("anthropic", FIRST.accountId, quotaAt(1));
    expect(readPassiveProviderAccountQuotas("anthropic")).toEqual([]);
  });

  /*
   * persistAccountQuotaCache serializes the WHOLE in-memory map. A passive write that
   * landed before anything hydrated would persist its single row and erase every other
   * provider's saved row, with diskHydrated then blocking recovery.
   */
  /*
   * persistAccountQuotaCache serializes the WHOLE in-memory map. A passive write that
   * landed before anything hydrated would persist its single row and erase every other
   * provider's saved row, with diskHydrated then blocking recovery.
   *
   * The disk file is written directly here rather than through the debounced scheduler:
   * clearAccountQuotaCache cancels any pending write, so a scheduled one cannot be
   * relied on to have landed across the restart this test simulates.
   */
  test("hydrates before persisting so an observation cannot erase other providers' rows", async () => {
    const [firstId] = await seedAccounts(FIRST);
    writeDiskRows({ [`anthropic\u0000other-acct`]: quotaAt(55) });

    // Restart with an empty map, then observe BEFORE anything reads the cache.
    clearAccountQuotaCache();
    recordPassiveAccountQuota("meta-muse", firstId!, quotaAt(3), captureConfigGeneration());
    // The foreign row is in memory, which is only possible if the write hydrated first.
    expect(getCachedProviderAccountQuota("anthropic", "other-acct")?.fiveHourPercent).toBe(55);

    await Bun.sleep(PERSIST_SETTLE_MS);
    const persisted = readPersistedAccountQuotas();
    expect(persisted.get(`anthropic\u0000other-acct`)?.fiveHourPercent).toBe(55);
    expect(persisted.get(`meta-muse\u0000${firstId!}`)?.fiveHourPercent).toBe(3);
  });

  test("an observation survives a restart", async () => {
    const [firstId] = await seedAccounts(FIRST);
    clearAccountQuotaCache();
    recordPassiveAccountQuota("meta-muse", firstId!, quotaAt(19), captureConfigGeneration());
    await Bun.sleep(PERSIST_SETTLE_MS);
    expect(readPersistedAccountQuotas().get(`meta-muse\u0000${firstId!}`)?.fiveHourPercent).toBe(19);

    // Simulate a restart: the in-memory map is gone, the file is not.
    clearAccountQuotaCache();
    const rows = readPassiveProviderAccountQuotas("meta-muse");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quota?.fiveHourPercent).toBe(19);
  });
});

describe("passive quota and routing headroom", () => {
  const ids = [FIRST.accountId, SECOND.accountId];

  test("a fresh observation for every account is usable evidence", () => {
    setCachedProviderAccountQuotaForTests("meta-muse", FIRST.accountId, quotaAt(10));
    setCachedProviderAccountQuotaForTests("meta-muse", SECOND.accountId, quotaAt(90));
    expect(hasHeadroomEvidence("meta-muse", ids)).toBe(true);
    expect(rankAccountsByHeadroom("meta-muse", ids)[0]).toBe(FIRST.accountId);
  });

  /*
   * A probe fills the whole roster at once; an observation arrives one account at a time.
   * RANK_UNKNOWN sorts AFTER RANK_HEALTHY, so accepting partial evidence would redirect
   * the first attempt away from an unmeasured account and toward the one known to be
   * spent -- the exact inversion ranking exists to prevent.
   */
  test("a partial roster is not evidence and does not reorder", () => {
    setCachedProviderAccountQuotaForTests("meta-muse", FIRST.accountId, quotaAt(100));
    expect(hasHeadroomEvidence("meta-muse", ids)).toBe(false);
    expect(rankAccountsByHeadroom("meta-muse", ids)).toEqual(ids);
  });

  test("an observation older than the routing bound is not evidence", () => {
    const stale = Date.now() - 2 * 60 * 60_000;
    setCachedProviderAccountQuotaForTests("meta-muse", FIRST.accountId, quotaAt(10, stale));
    setCachedProviderAccountQuotaForTests("meta-muse", SECOND.accountId, quotaAt(90, stale));
    expect(hasHeadroomEvidence("meta-muse", ids)).toBe(false);
    expect(rankAccountsByHeadroom("meta-muse", ids)).toEqual(ids);
  });

  test("the staleness bound applies only to passive providers", () => {
    const stale = Date.now() - 2 * 60 * 60_000;
    setCachedProviderAccountQuotaForTests("anthropic", FIRST.accountId, quotaAt(10, stale));
    expect(hasHeadroomEvidence("anthropic", [FIRST.accountId])).toBe(true);
  });
});
import { readPersistedAccountQuotas } from "../src/providers/account-quota-disk";

/** PERSIST_DEBOUNCE_MS is 250ms in account-quota-disk.ts; wait past it. */
const PERSIST_SETTLE_MS = 400;

/** Write the on-disk snapshot directly, bypassing the debounce. */
function writeDiskRows(rows: Record<string, ProviderQuota>): void {
  writeFileSync(join(opencodexHome, "provider-account-quota-cache.json"), `${JSON.stringify({ version: 1, rows })}\n`);
}
