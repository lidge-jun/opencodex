import { rotateAnthropicAccountOn429 } from "../../helpers/anthropic-shared-quota";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../../../src/codex/pool-rotation";
import { OAuthAccountPausedError, OAuthLoginRequiredError, OAUTH_PROVIDERS, refreshAnthropicAccountWithLock } from "../../../src/oauth";
import { AnthropicTokenError } from "../../../src/oauth/anthropic";
import {
  bindAnthropicSessionAffinity, clearAnthropicAccountPoolState, getAnthropicAccountHealthSnapshot,
  getAnthropicPoolAccessSnapshot, getEligibleAnthropicAccounts, hasAnthropicFailoverQuorum,
  promoteAnthropicActiveAccount, resolveAnthropicAccountForSession,
} from "../../../src/oauth/anthropic-routing";
import {
  captureOAuthAccountSelection, createOAuthRefreshIntentLock, getAccountCredential, getAccountSet,
  removeAccount, saveAccountCredential, saveCredential, setAccountPaused, setActiveAccount,
} from "../../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import type { OcxAccountPoolQuotaWindow, OcxAccountPoolRotationStrategy, OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home: string;
let ids: string[];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-pause-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache();
  for (let i = 0; i < 3; i++) await saveCredential("anthropic", {
    access: `synthetic-access-${i}`, refresh: `synthetic-refresh-${i}`,
    expires: Date.now() + 3_600_000, accountId: `pause-${i}`,
  });
  ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
});
afterEach(() => {
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function config(enabled = true, strategy: OcxAccountPoolRotationStrategy = "quota", quotaWindow: OcxAccountPoolQuotaWindow = "five-hour"): OcxConfig {
  return { port: 0, defaultProvider: "anthropic", providers: {
    anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
  }, anthropicAccountPool: { enabled, strategy, quotaWindow } };
}

for (const strategy of ["quota", "round-robin", "fill-first"] as const) {
  for (const window of ["five-hour", "weekly", "max-utilization"] as const) {
    test(`${strategy}/${window}: paused active, manual and affined accounts cannot win`, async () => {
      const [a, b, c] = ids as [string, string, string];
      const cfg = config(true, strategy, window);
      resolveAnthropicAccountForSession("session", cfg); // Cache the initial manual preference.
      bindAnthropicSessionAffinity("session", a);
      setCachedProviderAccountQuotaForTests("anthropic", a, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt: Date.now() });
      await setAccountPaused("anthropic", a, true);
      await setAccountPaused("anthropic", b, true);
      expect(getEligibleAnthropicAccounts()).toEqual([c]);
      expect(resolveAnthropicAccountForSession("session", cfg).accountId).toBe(c);
      expect(resolveAnthropicAccountForSession(null, cfg).accountId).toBe(c);
      expect(rotateAnthropicAccountOn429(cfg, b, "60")).toBe(c);
    });
  }
}

test("pause invalidates quorum immediately; disabled-pool reactive failover skips paused successors", async () => {
  const [a, b, c] = ids as [string, string, string];
  expect(hasAnthropicFailoverQuorum()).toBe(true);
  await setAccountPaused("anthropic", b, true);
  expect(rotateAnthropicAccountOn429(config(false), a, "60")).toBe(c);
  await setAccountPaused("anthropic", a, true);
  expect(hasAnthropicFailoverQuorum()).toBe(false);
  // The turn on A was already sent when it was paused; B stays excluded, C can recover it.
  expect(rotateAnthropicAccountOn429(config(false), a, "60")).toBe(c);
  await setAccountPaused("anthropic", b, false);
  expect(hasAnthropicFailoverQuorum()).toBe(true);
});

test("all-paused refusal and resume preserve credentials and cooldown, independent of pool enable", async () => {
  const a = ids[0]!;
  const credential = getAccountCredential("anthropic", a);
  rotateAnthropicAccountOn429(config(), a, "60");
  const health = getAnthropicAccountHealthSnapshot(a);
  for (const id of ids) await setAccountPaused("anthropic", id, true);
  for (const enabled of [true, false]) expect(resolveAnthropicAccountForSession("old", config(enabled))).toMatchObject({ accountId: null, reason: "paused" });
  await expect(getAnthropicPoolAccessSnapshot(a)).rejects.toBeInstanceOf(OAuthAccountPausedError);
  expect(await setActiveAccount("anthropic", a)).toBe(false);
  await setAccountPaused("anthropic", a, false);
  expect(getAccountCredential("anthropic", a)).toEqual(credential);
  expect(getAnthropicAccountHealthSnapshot(a)).toEqual(health);
  expect(getAccountSet("anthropic")!.activeAccountId).toBe(a);
});

test("model routes cannot restore a paused account, but explicit fallback can widen", async () => {
  const [a, b, c] = ids as [string, string, string];
  await setAccountPaused("anthropic", a, true);
  await setAccountPaused("anthropic", b, true);
  const route = { position: 1, accounts: [a, b], fallback: false };
  expect(resolveAnthropicAccountForSession("", config(), Date.now(), route).reason).toBe("paused");
  expect(resolveAnthropicAccountForSession("", config(), Date.now(), { ...route, fallback: true }).accountId).toBe(c);
});

test("pause and pause-resume ABA both invalidate an earlier credential proposal", async () => {
  const a = ids[0]!;
  const selection = captureOAuthAccountSelection("anthropic");
  const snapshot = await getAnthropicPoolAccessSnapshot(a);
  await setAccountPaused("anthropic", a, true);
  expect(await promoteAnthropicActiveAccount(a, selection, { config: config(), expectedCredentialGeneration: snapshot.generation })).toBeNull();
  await setAccountPaused("anthropic", a, false);
  // Resume preserves the credential but cannot authorize a proposal captured before pause.
  expect(await promoteAnthropicActiveAccount(a, selection, { config: config() })).toBeNull();
  expect(await promoteAnthropicActiveAccount(a, captureOAuthAccountSelection("anthropic"), { config: config() })).not.toBeNull();
});

test("pause during an asynchronous credential refresh prevents returning its bearer", async () => {
  const a = ids[0]!;
  const credential = getAccountCredential("anthropic", a)!;
  await saveAccountCredential("anthropic", a, { ...credential, expires: 0 });
  const refresh = spyOn(OAUTH_PROVIDERS.anthropic!, "refresh").mockImplementation(async () => {
    await setAccountPaused("anthropic", a, true);
    return { ...credential, access: "synthetic-after-wait", refresh: "synthetic-after-wait-refresh" };
  });
  try {
    await expect(getAnthropicPoolAccessSnapshot(a)).rejects.toBeInstanceOf(OAuthAccountPausedError);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Keep an already-rotated refresh token for resume without authorizing this request.
    expect(getAccountCredential("anthropic", a)?.access).toBe("synthetic-after-wait");
  } finally { refresh.mockRestore(); }
});

test("pause is durable, idempotent, preserved on relogin and removed with its account", async () => {
  const a = ids[0]!;
  const credential = getAccountCredential("anthropic", a)!;
  await Promise.all([setAccountPaused("anthropic", a, true), setAccountPaused("anthropic", ids[1]!, true)]);
  expect((await setAccountPaused("anthropic", a, true)).status).toBe("unchanged");
  clearAnthropicAccountPoolState();
  expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).anthropic.accounts.filter((row: { paused?: boolean }) => row.paused)).toHaveLength(2);
  await saveCredential("anthropic", credential);
  expect(getAccountSet("anthropic")!.accounts.find(row => row.id === a)?.paused).toBe(true);
  await removeAccount("anthropic", a);
  await saveCredential("anthropic", credential);
  expect(getAccountSet("anthropic")!.accounts.find(row => row.credential.accountId === credential.accountId)?.paused).toBeUndefined();
});

test("refresh waiting for its lock observes a newly persisted pause without upstream use", async () => {
  const a = ids[0]!;
  const lock = createOAuthRefreshIntentLock("anthropic", a);
  const originalAcquire = lock.acquire.bind(lock);
  lock.acquire = async () => { await setAccountPaused("anthropic", a, true); return originalAcquire(); };
  let sends = 0;
  await expect(refreshAnthropicAccountWithLock("anthropic", a, {
    ...OAUTH_PROVIDERS.anthropic!, refresh: async () => { sends++; throw new Error("unexpected refresh"); },
  }, getAccountCredential("anthropic", a)!, { intentLock: lock })).rejects.toBeInstanceOf(OAuthAccountPausedError);
  expect(sends).toBe(0);
});

test("refresh finishing after pause preserves rotated credentials; late failure preserves health", async () => {
  const a = ids[0]!;
  const original = getAccountCredential("anthropic", a)!;
  await refreshAnthropicAccountWithLock("anthropic", a, {
    ...OAUTH_PROVIDERS.anthropic!, refresh: async () => {
      await setAccountPaused("anthropic", a, true);
      return { ...original, access: "synthetic-rotated", refresh: "synthetic-rotated-refresh" };
    },
  }, original);
  expect(getAccountCredential("anthropic", a)?.access).toBe("synthetic-rotated");
  expect(getAccountSet("anthropic")!.accounts.find(row => row.id === a)?.paused).toBe(true);
  await setAccountPaused("anthropic", a, false);
  await expect(refreshAnthropicAccountWithLock("anthropic", a, {
    ...OAUTH_PROVIDERS.anthropic!, refresh: async () => {
      await setAccountPaused("anthropic", a, true);
      throw new AnthropicTokenError("synthetic rejection", 400, "invalid_grant");
    },
  }, getAccountCredential("anthropic", a)!)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
  expect(getAccountSet("anthropic")!.accounts.find(row => row.id === a)?.needsReauth).not.toBe(true);
});
