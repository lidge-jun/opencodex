import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  affinitySizeForTests,
  getSessionAffinity,
} from "../src/routing/account-pool";
import {
  ANTIGRAVITY_STICK_WAIT_MAX_MS,
  antigravity429StickWaitMs,
  bindAntigravitySessionAffinity,
  clearAntigravityAccountCooldown,
  clearAntigravityAccountPoolState,
  clearAntigravityRoutingHealthForTests,
  isAntigravityRateLimitStickWait,
  recordAntigravityCooldown,
  resolveAntigravityAccountForSession,
  rotateAntigravityAccountOn429,
} from "../src/oauth/antigravity-routing";
import {
  getAccountSet,
  saveCredential,
  setActiveAccount,
} from "../src/oauth/store";

const PROVIDER = "google-antigravity";
const POOL_KEY = "google-antigravity";
const NOW = 1_700_000_000_000;

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

async function seedAccounts(ids: string[], activeId: string): Promise<Record<string, string>> {
  const idByLabel = new Map<string, string>();
  for (const label of ids) {
    await saveCredential(PROVIDER, {
      access: `token-${label}`,
      refresh: `refresh-${label}`,
      expires: NOW + 3_600_000,
      accountId: label,
      projectId: `project-${label}`,
    });
  }
  const set = getAccountSet(PROVIDER)!;
  for (const label of ids) {
    const account = set.accounts.find(entry => entry.credential.accountId === label);
    if (!account) throw new Error(`missing seeded account ${label}`);
    idByLabel.set(label, account.id);
  }
  await setActiveAccount(PROVIDER, idByLabel.get(activeId)!);
  return Object.fromEntries(idByLabel);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-antigravity-affinity-"));
  process.env.OPENCODEX_HOME = home;
  clearAntigravityRoutingHealthForTests();
  clearAntigravityAccountPoolState();
});

afterEach(() => {
  clearAntigravityRoutingHealthForTests();
  clearAntigravityAccountPoolState();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("Antigravity session affinity", () => {
  test("new session uses the store active account", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");

    const selection = resolveAntigravityAccountForSession("thread-1", NOW);

    expect(selection).toEqual({ accountId: ids["acct-a"], reason: "active" });
    expect(getSessionAffinity(POOL_KEY, "thread-1", NOW)?.accountId).toBe(ids["acct-a"]);
  });

  test("bound session keeps its account when global active differs", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");
    bindAntigravitySessionAffinity("thread-2", ids["acct-b"]!, NOW);
    await setActiveAccount(PROVIDER, ids["acct-a"]!);

    const selection = resolveAntigravityAccountForSession("thread-2", NOW);

    expect(selection).toEqual({ accountId: ids["acct-b"], reason: "affinity" });
    expect(getAccountSet(PROVIDER)?.activeAccountId).toBe(ids["acct-a"]);
  });

  test("429 failover binds the replacement to the session only", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");
    bindAntigravitySessionAffinity("thread-a", ids["acct-a"]!, NOW);
    bindAntigravitySessionAffinity("thread-b", ids["acct-b"]!, NOW);
    recordAntigravityCooldown(ids["acct-a"]!, "rate_limited", 120_000, NOW);

    const next = rotateAntigravityAccountOn429(ids["acct-a"]!, "thread-a", NOW);

    expect(next).toBe(ids["acct-b"]);
    expect(getSessionAffinity(POOL_KEY, "thread-a", NOW)?.accountId).toBe(ids["acct-b"]);
    expect(getSessionAffinity(POOL_KEY, "thread-b", NOW)?.accountId).toBe(ids["acct-b"]);
    expect(getAccountSet(PROVIDER)?.activeAccountId).toBe(ids["acct-a"]);
  });

  test("short rate-limit stick-wait does not hop on 429", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");
    bindAntigravitySessionAffinity("thread-1", ids["acct-a"]!, NOW);
    recordAntigravityCooldown(ids["acct-a"]!, "rate_limited", 3_000, NOW);

    expect(isAntigravityRateLimitStickWait(ids["acct-a"]!, NOW)).toBe(true);
    expect(antigravity429StickWaitMs(ids["acct-a"]!, NOW)).toBe(3_000);
    expect(rotateAntigravityAccountOn429(ids["acct-a"]!, "thread-1", NOW)).toBeNull();
    expect(getSessionAffinity(POOL_KEY, "thread-1", NOW)?.accountId).toBe(ids["acct-a"]);
  });

  test("quota_exhausted never stick-waits", () => {
    recordAntigravityCooldown("acct-a", "quota_exhausted", 30_000, NOW);

    expect(isAntigravityRateLimitStickWait("acct-a", NOW)).toBe(false);
    expect(antigravity429StickWaitMs("acct-a", NOW)).toBeNull();
  });

  test("geo_blocked never stick-waits", () => {
    recordAntigravityCooldown("acct-a", "geo_blocked", undefined, NOW);

    expect(isAntigravityRateLimitStickWait("acct-a", NOW)).toBe(false);
    expect(antigravity429StickWaitMs("acct-a", NOW)).toBeNull();
  });

  test("stick-wait keeps the cooled account eligible at bind", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");
    bindAntigravitySessionAffinity("thread-1", ids["acct-a"]!, NOW);
    recordAntigravityCooldown(ids["acct-a"]!, "rate_limited", ANTIGRAVITY_STICK_WAIT_MAX_MS, NOW);

    const selection = resolveAntigravityAccountForSession("thread-1", NOW);

    expect(selection).toEqual({ accountId: ids["acct-a"], reason: "affinity" });
  });

  test("bind failover skips globally cooled active without promoting it", async () => {
    const ids = await seedAccounts(["acct-a", "acct-b"], "acct-a");
    recordAntigravityCooldown(ids["acct-a"]!, "rate_limited", 120_000, NOW);

    const selection = resolveAntigravityAccountForSession("thread-new", NOW);

    expect(selection).toEqual({ accountId: ids["acct-b"], reason: "failover" });
    expect(getAccountSet(PROVIDER)?.activeAccountId).toBe(ids["acct-a"]);
    expect(affinitySizeForTests(POOL_KEY)).toBe(1);
  });
});
