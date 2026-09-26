import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGenericFailoverHealth, eligibleFailoverAccounts, kiroAutoSelection,
  quarantineKiroSuspendedAccount, rotateGenericOAuthAccountOnRefusal } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../../../src/oauth/store";
import { setCachedProviderAccountQuotaForTests, clearAccountQuotaCache } from "../../../src/providers/quota";
import { commitKiroAccountUsageState } from "../../../src/providers/kiro-usage";
import { kiroEvidenceIdentity } from "../../../src/providers/kiro-account-state-disk";
import type { ProviderAccount } from "../../../src/oauth/types";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-auto-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
});
afterEach(() => {
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function accounts(): Promise<ProviderAccount[]> {
  for (const id of ["reauth", "suspended", "cooldown", "exhausted", "unknown"]) {
    await saveCredential("kiro", { access: `access-${id}`, refresh: `refresh-${id}`,
      expires: Date.now() + 3600_000, accountId: id }, { addAccount: true });
  }
  return getAccountSet("kiro")!.accounts;
}

test("Kiro candidate and list projection agree on family-less exclusion states", async () => {
  const roster = await accounts();
  const byName = (name: string) => roster.find(a => a.credential.accountId === name)!;
  await markAccountNeedsReauth("kiro", byName("reauth").id, true);
  quarantineKiroSuspendedAccount(byName("suspended").id);
  const config = { providers: { kiro: { adapter: "kiro", authMode: "oauth" } } } as OcxConfig;
  rotateGenericOAuthAccountOnRefusal(config, "kiro", byName("cooldown").id,
    "rate", "120");
  const exhausted = byName("exhausted");
  const now = Date.now();
  setCachedProviderAccountQuotaForTests("kiro", exhausted.id, {
    monthlyPercent: 100, updatedAt: now, monthlyResetAt: now + 3600_000,
  });
  commitKiroAccountUsageState(`kiro\0${exhausted.id}`, { quota: { updatedAt: now },
    exhausted: true, nextResetAt: now + 3600_000 }, kiroEvidenceIdentity(exhausted));
  const expected = { reauth: "needs_reauth", suspended: "suspended", cooldown: "cooldown",
    exhausted: "quota_exhausted", unknown: undefined } as const;
  const live = getAccountSet("kiro")!.accounts;
  const eligible = eligibleFailoverAccounts("kiro", now);
  for (const account of live) {
    const name = account.credential.accountId as keyof typeof expected;
    const projected = kiroAutoSelection(account, now);
    expect(projected.autoSelectable).toBe(eligible.includes(account.id));
    expect(projected.skipReason).toBe(expected[name]);
  }
  expect(eligible).toEqual([byName("unknown").id]);
  expect(kiroAutoSelection(byName("suspended"), now + 24 * 60 * 60_000 + 1))
    .toEqual({ autoSelectable: true });
});
