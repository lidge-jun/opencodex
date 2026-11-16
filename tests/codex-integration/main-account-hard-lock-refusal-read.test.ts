import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import * as authCollision from "../../src/codex/auth-collision";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import {
  MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS, MAIN_HARD_LOCK_REFUSAL_READ_INTERVAL_MS, refreshMainHardLockBeforeRefusal,
  resetMainHardLockRefusalReadForTests,
} from "../../src/codex/auth-api/main-hard-lock-refusal-read";
import { advanceCodexCredentialMutationEpoch } from "../../src/codex/credential-mutation-epoch";
import { CodexMainAccountHardLockError, resolveCodexAuthContext } from "../../src/codex/auth-context";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaCredential } from "../../src/codex/main-account-cache";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { getNativeMainProfileRequestCount, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8113: a hard-lock refusal reads WHAM once when the reading behind it is older than 60 s.
const accountId = "fixture-refusal-main";
const whamUrl = "https://chatgpt.com/backend-api/wham/usage";
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;
let clock: number;
let mainToken: string;

function config(): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: { openai: {
    adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward", codexAccountMode: "pool",
  } }, codexMainAccountHardLock: true, activeCodexAccountId: MAIN, codexAccounts: [] };
}

/** Synthetic unsigned claims for the fixture identity; not a real credential. */
function bearer(account = accountId): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 86_400,
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

/** Seed a blocking 99% short-window reading observed at the current fixture clock. */
function block(account = accountId): void {
  const writer = captureMainQuotaWriter(account);
  if (!writer) throw new Error("fixture identity must be observed");
  setAccountQuotaFromParsed(MAIN, { shortPercent: 99, shortWindowSeconds: 18_000 }, undefined, writer);
}

/** Make `account` the physical main login and block it on a reading observed now. */
function signInMain(account: string): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
    access_token: bearer(account), refresh_token: "fixture-refresh", account_id: account,
  } }));
  reconcileMainCodexAccountRuntimeState();
  block(account);
}

function usage(percent: number): Response {
  return Response.json({ plan_type: "plus", rate_limit: {
    primary_window: { used_percent: percent, limit_window_seconds: 18_000, reset_at: Math.floor(clock / 1000) + 3_600 },
  } });
}

/** Stub WHAM. An owned read runs under the native-main claim; a caller-owned read takes none. */
function wham(respond: () => Response, gate?: Promise<void>, claimed = true): string[] {
  const calls: string[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    expect(url).toBe(whamUrl);
    expect(getNativeMainProfileRequestCount()).toBe(claimed ? 1 : 0);
    await gate;
    return respond();
  }, { preconnect: previousFetch.preconnect });
  return calls;
}

const age = (ms: number) => { clock += ms; };

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousFetch = globalThis.fetch;
  home = mkdtempSync(join(tmpdir(), "ocx-main-refusal-read-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  clock = Date.now();
  spyOn(Date, "now").mockImplementation(() => clock);
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN);
  clearCodexUpstreamHealth();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  resetMainHardLockRefusalReadForTests();
  resetQuotaQueryBackoffForTests();
  setMainAccountPlan(null);
  mainToken = bearer();
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
    access_token: mainToken, refresh_token: "fixture-refresh", account_id: accountId,
  } }));
  reconcileMainCodexAccountRuntimeState();
  block();
});

afterEach(async () => {
  globalThis.fetch = previousFetch;
  (Date.now as unknown as { mockRestore(): void }).mockRestore();
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN);
  clearCodexUpstreamHealth();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  resetMainHardLockRefusalReadForTests();
  resetQuotaQueryBackoffForTests();
  setMainAccountPlan(null);
  try { await flushConfigDirHardeningForTests(); } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(home);
  }
});

test("a reading younger than 60 s refuses without a WHAM read", async () => {
  const calls = wham(() => usage(0));
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS - 1);
  expect(await refreshMainHardLockBeforeRefusal(config())).toBe(false);
  await expect(resolveCodexAuthContext(new Headers(), config(), "pool")).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
  expect(calls).toEqual([]);
});

test("a stale reading is re-read once before refusing, and a reset redeemed elsewhere lifts the lock", async () => {
  const calls = wham(() => usage(0));
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS + 1);
  await expect(resolveCodexAuthContext(new Headers(), config(), "pool"))
    .resolves.toMatchObject({ kind: "main-pool", accountId: MAIN });
  expect(calls).toEqual([whamUrl]);
  expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
});

test("a fresh read that still blocks keeps the refusal", async () => {
  const calls = wham(() => usage(99));
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS + 1);
  await expect(resolveCodexAuthContext(new Headers(), config(), "pool")).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
  expect(calls).toEqual([whamUrl]);
});

test("a failed read keeps the refusal, and the main identity is read at most once a minute", async () => {
  const calls = wham(() => new Response("unavailable", { status: 503 }));
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS + 1);
  expect(await refreshMainHardLockBeforeRefusal(config())).toBe(false);
  expect(calls).toHaveLength(1);
  // The failed read also paces WHAM for minutes; lift that so only the per-identity minute applies.
  resetQuotaQueryBackoffForTests();
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS - 1);
  await expect(resolveCodexAuthContext(new Headers(), config(), "pool")).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
  expect(calls).toHaveLength(1);
  age(1);
  expect(await refreshMainHardLockBeforeRefusal(config())).toBe(false);
  expect(calls).toHaveLength(2);
});

test("concurrent refusals share one in-flight read", async () => {
  const gate = Promise.withResolvers<void>();
  const calls = wham(() => usage(0), gate.promise);
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS + 1);
  const first = refreshMainHardLockBeforeRefusal(config());
  const second = refreshMainHardLockBeforeRefusal(config());
  gate.resolve();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(calls).toEqual([whamUrl]);
});

test("a paused main receives no refusal read", async () => {
  const calls = wham(() => usage(0));
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS + 1);
  expect(await refreshMainHardLockBeforeRefusal({ ...config(), pausedCodexAccountIds: [MAIN] })).toBe(false);
  expect(calls).toEqual([]);
});
test("a caller-owned main bearer refusal gets the same fresh read", async () => {
  const calls = wham(() => usage(0), undefined, false);
  // A caller-owned request may never read the physical main credential, so the read uses its bearer.
  const physicalReads = spyOn(authCollision, "readCodexTokensResult");
  // The caller presents the main login itself, so the observed-main lock applies to it.
  observeMainQuotaCredential(mainToken, accountId);
  const headers = new Headers({ authorization: `Bearer ${mainToken}`, "chatgpt-account-id": accountId });
  await expect(resolveCodexAuthContext(headers, config(), "pool", { requestScopedMainCredential: true }))
    .rejects.toBeInstanceOf(CodexMainAccountHardLockError);
  expect(calls).toEqual([]);
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS + 1);
  await expect(resolveCodexAuthContext(headers, config(), "pool", { requestScopedMainCredential: true }))
    .resolves.toMatchObject({ kind: "main" });
  expect(calls).toEqual([whamUrl]);
  expect(physicalReads).not.toHaveBeenCalled();
  physicalReads.mockRestore();
});
test("a credential commit during a caller-owned read keeps the refusal", async () => {
  const gate = Promise.withResolvers<void>();
  const calls = wham(() => usage(0), gate.promise, false);
  observeMainQuotaCredential(mainToken, accountId);
  const headers = new Headers({ authorization: `Bearer ${mainToken}`, "chatgpt-account-id": accountId });
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS + 1);
  const pending = resolveCodexAuthContext(headers, config(), "pool", { requestScopedMainCredential: true });
  while (calls.length === 0) await Promise.resolve();
  // A native refresh or same-account reauthentication commits before the observed HMAC changes.
  advanceCodexCredentialMutationEpoch();
  gate.resolve();
  await expect(pending).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
  expect(calls).toEqual([whamUrl]);
  expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
});

test("a Direct-mode refusal read records Retry-After, so the next minute does not read again", async () => {
  const direct = { ...config(), providers: { openai: { ...config().providers.openai!, codexAccountMode: "direct" as const } } };
  const calls = wham(() => new Response("slow down", { status: 429, headers: { "retry-after": "600" } }));
  age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS + 1);
  expect(await refreshMainHardLockBeforeRefusal(direct)).toBe(false);
  age(MAIN_HARD_LOCK_REFUSAL_READ_INTERVAL_MS);
  expect(await refreshMainHardLockBeforeRefusal(direct)).toBe(false);
  expect(calls).toEqual([whamUrl]);
});

test("switching main logins A, B, A inside one minute reads A only once", async () => {
  const calls = wham(() => new Response("unavailable", { status: 503 }));
  const stale = async (): Promise<void> => {
    age(MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS + 1);
    expect(await refreshMainHardLockBeforeRefusal(config())).toBe(false);
    // Lift the failed-read pacing so only the per-identity minute decides.
    resetQuotaQueryBackoffForTests();
    clock -= MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS;
  };
  await stale();
  signInMain("fixture-refusal-other");
  await stale();
  signInMain(accountId);
  await stale();
  expect(calls).toHaveLength(2);
});
