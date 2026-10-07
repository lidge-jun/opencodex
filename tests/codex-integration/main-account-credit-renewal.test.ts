import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexMainAccountCreditsOffError, resolveCodexAuthContext } from "../../src/codex/auth-context";
import { fetchMainAccountInfoAttempt } from "../../src/codex/auth-api/main-account-probe";
import { registerCodexCooldownRecoveryProbeWorker, runMainAccountHardLockRecovery } from "../../src/codex/auth-api/pool-mode-gate";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { captureMainQuotaWriter, clearMainAccountInfoCache, getMainAccountInfoCache, isMainAccountIdentityGenerationLive, observeMainQuotaCredential, setMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { clearAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { hasSpendableCodexCredits, type CodexSpendableCredits } from "../../src/codex/quota-types";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import * as mainAccount from "../../src/codex/main-account";
import * as sweeper from "../../src/lib/state-store-sweeper";
import * as quotaQueries from "../../src/codex/quota-query-backoff";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { getNativeMainProfileRequestCount, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { mapCodexAuthContextErrorToResponse } from "../../src/server/responses/codex-auth-error";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const accountId = "fixture-credit-renewal";
const whamUrl = "https://chatgpt.com/backend-api/wham/usage";
const tokenUrl = "https://auth.openai.com/oauth/token";
const HOUR = 3_600_000;
let home: string;
let now: number;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;
let cfg: OcxConfig;
let calls: string[];

function bearer(id = accountId, expired = false): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + (expired ? -120 : 86_400),
    "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url");
  return `header.${payload}.signature`;
}

function writeMain(id = accountId, expired = false): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
    access_token: bearer(id, expired), refresh_token: "fixture-refresh", account_id: id,
  } }));
  reconcileMainCodexAccountRuntimeState();
  observeMainQuotaCredential(bearer(id, expired), id);
}

function seed(credits: CodexSpendableCredits | null | undefined = {
  hasCredits: true, balance: 5, allowed: true, observedAt: now - 180_000,
}): void {
  clearAccountQuota(MAIN);
  setAccountQuotaFromParsed(MAIN, { weeklyPercent: 100, weeklyResetAt: now + HOUR,
    ...(credits !== undefined ? { credits } : {}) }, undefined, captureMainQuotaWriter(accountId));
}

function usage(restriction?: string): Response {
  return Response.json({ plan_type: "plus", rate_limit: {
    primary_window: { used_percent: 100, limit_window_seconds: 604_800,
      reset_at: Math.floor((now + HOUR) / 1000) },
    secondary_window: null, tertiary_window: null,
  }, ...(restriction === "omitted" ? {} : { credits: restriction === "retracted" ? null : {
    has_credits: restriction !== "empty", balance: restriction === "empty" ? 0 : 5,
    overage_limit_reached: restriction === "overage",
  } }), spend_control: { reached: restriction === "restricted" } });
}

function fetchWith(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect([whamUrl, tokenUrl]).toContain(url);
    expect(getNativeMainProfileRequestCount()).toBeGreaterThan(0);
    return handler(url, init);
  }, { preconnect: previousFetch.preconnect });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function refused(): Promise<void> {
  const error = await resolveCodexAuthContext(new Headers(), cfg, "pool").catch(error => error);
  expect(error).toBeInstanceOf(CodexMainAccountCreditsOffError);
  const response = mapCodexAuthContextErrorToResponse(error, { now })!;
  expect(response.status).toBe(429);
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousFetch = globalThis.fetch;
  home = mkdtempSync(join(tmpdir(), "ocx-credit-renewal-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  now = Math.floor(Date.now() / 1000) * 1000;
  spyOn(Date, "now").mockImplementation(() => now);
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN);
  clearCodexUpstreamHealth();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  resetQuotaQueryBackoffForTests();
  mainAccount.setMainAccountPlan(null);
  writeMain();
  calls = [];
  cfg = { port: 10100, defaultProvider: "openai", codexMainAccountHardLock: false,
    activeCodexAccountId: MAIN, creditCodexAccountIds: [MAIN], codexAccounts: [], providers: { openai: {
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", codexAccountMode: "pool",
    } } };
  seed();
  fetchWith(async () => usage());
});

afterEach(async () => {
  mock.restore();
  globalThis.fetch = previousFetch;
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN);
  clearCodexUpstreamHealth();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  resetQuotaQueryBackoffForTests();
  mainAccount.setMainAccountPlan(null);
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

test("without renewal, five-minute credit expiry produces a local 429", async () => {
  seed({ hasCredits: true, balance: 5, observedAt: now });
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool")).resolves.toMatchObject({ kind: "main-pool" });
  now += 300_001;
  await refused();
  expect(calls).toEqual([]);
});

test.each([false, true])("hidden-dashboard sweep renews at three minutes and admits past original expiry (unlimited=%j)", async unlimited => {
  const original = now;
  seed({ hasCredits: true, ...(unlimited ? { unlimited: true } : { balance: 5 }), observedAt: now });
  let worker: (() => void) | undefined;
  spyOn(sweeper, "registerStateSweepAfterTick").mockImplementation(registration => { worker = registration.afterTick; });
  registerCodexCooldownRecoveryProbeWorker(cfg);
  now += 179_999;
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([]);
  now++;
  expect(worker).toBeDefined();
  worker!(); // No account-list/dashboard request is made.
  await runMainAccountHardLockRecovery(cfg); // Join the already scheduled sweep.
  expect(calls).toEqual([whamUrl]);
  expect(getMainPolicyQuota()?.credits?.observedAt).toBe(now);
  now = original + 300_001;
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool")).resolves.toMatchObject({ kind: "main-pool" });
  expect(getNativeMainProfileRequestCount()).toBe(0);
});

test.each([503, 401, 403])("failed renewal HTTP %s preserves evidence and eventual refusal", async status => {
  seed({ hasCredits: true, balance: 5, observedAt: now - 240_000 });
  const observation = getMainPolicyQuota()!.credits!.observedAt;
  fetchWith(async () => Response.json({ detail: { code: "invalid_workspace_selected" } }, { status }));
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([whamUrl]);
  expect(getMainPolicyQuota()?.credits?.observedAt).toBe(observation);
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
  now += 120_001;
  await refused();
});

test.each(["empty", "restricted", "overage", "retracted", "omitted"])("renewal with %s credits cannot authorize expired evidence", async restriction => {
  fetchWith(async () => usage(restriction));
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([whamUrl]);
  now += 120_001;
  await refused();
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([whamUrl]);
});

test.each(["missing", "retracted", "zero", "negative", "invalid-balance", "no-flags", "no-balance", "has-false", "restricted", "overage", "future", "invalid-time", "negative-time"])("%s credit evidence never initiates renewal", async condition => {
  const credits: CodexSpendableCredits = { hasCredits: true, balance: 5, observedAt: now - 180_000 };
  if (condition === "zero") credits.balance = 0;
  if (condition === "negative") credits.balance = -1;
  if (condition === "invalid-balance") credits.balance = Number.NaN;
  if (condition === "no-flags") delete credits.hasCredits;
  if (condition === "no-balance") delete credits.balance;
  if (condition === "has-false") { credits.hasCredits = false; credits.unlimited = true; }
  if (condition === "restricted") credits.allowed = false;
  if (condition === "overage") credits.overageLimitReached = true;
  if (condition === "future") credits.observedAt = now + 1;
  if (condition === "invalid-time") credits.observedAt = Number.NaN;
  if (condition === "negative-time") credits.observedAt = -1;
  seed(condition === "retracted" ? null : credits);
  if (condition === "missing") { clearAccountQuota(MAIN); setAccountQuotaFromParsed(MAIN,
    { weeklyPercent: 100, weeklyResetAt: now + HOUR }, undefined, captureMainQuotaWriter(accountId)); }
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([]);
  expect(getNativeMainProfileRequestCount()).toBe(0);
});

test.each(["no-consent", "paused", "reauth", "fresh", "reset", "hard-lock", "identity"])("%s excludes credit renewal", async condition => {
  if (condition === "no-consent") cfg.creditCodexAccountIds = [];
  if (condition === "paused") cfg.pausedCodexAccountIds = [MAIN];
  if (condition === "reauth") markAccountNeedsReauth(MAIN);
  if (condition === "fresh") seed({ hasCredits: true, balance: 5, observedAt: now });
  if (condition === "reset") setAccountQuotaFromParsed(MAIN, { weeklyPercent: 0 }, undefined, captureMainQuotaWriter(accountId));
  if (condition === "hard-lock") cfg.codexMainAccountHardLock = true;
  if (condition === "identity") writeMain("fixture-replacement");
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([]);
});

test("expired access token is refreshed before credit WHAM", async () => {
  writeMain(accountId, true);
  seed();
  fetchWith(async (url, init) => {
    if (url === tokenUrl) return Response.json({ access_token: bearer(), refresh_token: "fixture-rotated", expires_in: 86_400 });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${bearer()}`);
    return usage();
  });
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([tokenUrl, whamUrl]);
  expect(getMainPolicyQuota()?.credits?.observedAt).toBe(now);
  now += 120_001;
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool")).resolves.toMatchObject({ kind: "main-pool" });
});

test("failed refresh leaves stale-credit refusal and never calls WHAM", async () => {
  writeMain(accountId, true);
  seed();
  fetchWith(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([tokenUrl]);
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
  now += 120_001;
  await refused();
});

test.each(["consent", "pause", "credits", "reauth", "identity", "hard-lock"])("eligibility is checked after token preparation changes %s", async change => {
  const original = mainAccount.getValidMainAccountToken;
  spyOn(mainAccount, "getValidMainAccountToken").mockImplementation(async options => {
    const token = await original(options);
    if (change === "consent") cfg.creditCodexAccountIds = [];
    if (change === "pause") cfg.pausedCodexAccountIds = [MAIN];
    if (change === "credits") seed(null);
    if (change === "reauth") markAccountNeedsReauth(MAIN);
    if (change === "identity") writeMain("fixture-replacement");
    if (change === "hard-lock") cfg.codexMainAccountHardLock = true;
    return token;
  });
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([]);
});

test("overlapping sweeps share one credit renewal and release ownership", async () => {
  const entered = deferred<void>();
  const finish = deferred<Response>();
  fetchWith(async () => { entered.resolve(); return finish.promise; });
  const first = runMainAccountHardLockRecovery(cfg);
  await entered.promise;
  const others = [runMainAccountHardLockRecovery(cfg), runMainAccountHardLockRecovery(cfg)];
  expect(calls).toEqual([whamUrl]);
  finish.resolve(usage());
  await Promise.all([first, ...others]);
  expect(getNativeMainProfileRequestCount()).toBe(0);
  expect(getMainPolicyQuota()?.credits?.observedAt).toBe(now);
});

test("upstream Retry-After paces credit renewal until its deadline", async () => {
  let reads = 0;
  fetchWith(async () => ++reads === 1 ? new Response("{}", { status: 429, headers: { "Retry-After": "900" } }) : usage());
  await runMainAccountHardLockRecovery(cfg);
  now += 899_999;
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([whamUrl]);
  expect(hasSpendableCodexCredits(getMainPolicyQuota())).toBe(false);
  now++;
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([whamUrl, whamUrl]);
  expect(hasSpendableCodexCredits(getMainPolicyQuota())).toBe(true);
});


test.each([401, 403])("passive option survives identity retry for terminal WHAM %s", async status => {
  fetchWith(async () => {
    if (calls.length === 1) { writeMain("fixture-replacement"); return usage(); }
    return Response.json({ detail: { code: "invalid_workspace_selected" } }, { status });
  });
  const result = await fetchMainAccountInfoAttempt(true, 1, undefined, false, true, false, cfg, { passive: true });
  expect(calls).toEqual([whamUrl, whamUrl]);
  expect(result.terminalAuthFailure).toBe(true);
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
});

test.each([true, false])("passive successful probe retains reauth marked in flight (identity retry=%j)", async retry => {
  fetchWith(async () => {
    if (retry && calls.length === 1) { writeMain("fixture-replacement"); return usage(); }
    markAccountNeedsReauth(MAIN);
    return usage();
  });
  await fetchMainAccountInfoAttempt(true, 1, undefined, false, true, false, cfg, { passive: true });
  expect(calls).toHaveLength(retry ? 2 : 1);
  expect(isAccountNeedsReauth(MAIN)).toBe(true);
});


test.each([401, 403])("terminal passive WHAM %s retains recovery backoff without quarantine", async status => {
  fetchWith(async () => Response.json({ detail: { code: "invalid_workspace_selected" } }, { status }));
  await runMainAccountHardLockRecovery(cfg);
  now += 60_000;
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([whamUrl]);
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
  now += 240_000;
  await runMainAccountHardLockRecovery(cfg);
  expect(calls).toEqual([whamUrl, whamUrl]);
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
});


async function joinPassiveRenewal(explicitRefresh: boolean) {
  const entered = deferred<void>();
  const joined = deferred<void>();
  const finish = deferred<Response>();
  const originalQuery = quotaQueries.fetchCodexUsage;
  let queries = 0;
  spyOn(quotaQueries, "fetchCodexUsage").mockImplementation(<T>(...args: Parameters<typeof originalQuery>) => {
    const read = originalQuery<T>(...args);
    if (++queries === 2) joined.resolve();
    return read;
  });
  fetchWith(async () => { entered.resolve(); return finish.promise; });
  const renewal = runMainAccountHardLockRecovery(cfg);
  await entered.promise;
  const caller = fetchMainAccountInfoAttempt(true, 1, undefined, false, explicitRefresh, false, cfg);
  await joined.promise; // The real single-flight join is pending before releasing WHAM.
  expect(calls).toEqual([whamUrl]);
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
  return { renewal, caller, finish };
}

test.each([
  { status: 401, explicitRefresh: true }, { status: 403, explicitRefresh: true },
  { status: 401, explicitRefresh: false }, { status: 403, explicitRefresh: false },
])("ordinary caller joining passive renewal quarantines terminal WHAM %j", async ({ status, explicitRefresh }) => {
  const { renewal, caller, finish } = await joinPassiveRenewal(explicitRefresh);
  setMainAccountInfoCache({ email: null, plan: "plus", quota: null, ts: now });
  finish.resolve(Response.json({ detail: { code: "invalid_workspace_selected" } }, { status }));
  const [, result] = await Promise.all([renewal, caller]);
  expect(calls).toEqual([whamUrl]);
  expect(result.terminalAuthFailure).toBe(true);
  expect(result.quotaRefresh).toEqual({ status: "http_error", httpStatus: status, code: "invalid_workspace_selected" });
  expect(isAccountNeedsReauth(MAIN)).toBe(true);
  expect(getMainAccountInfoCache()).toBeNull();
  expect(isMainAccountIdentityGenerationLive(result.quotaRefreshGeneration!)).toBe(true);
  expect(getNativeMainProfileRequestCount()).toBe(0);
});

test.each([true, false])("successful caller joining passive renewal clears quarantine only for explicit refresh=%j", async explicitRefresh => {
  const { renewal, caller, finish } = await joinPassiveRenewal(explicitRefresh);
  markAccountNeedsReauth(MAIN);
  finish.resolve(usage());
  const [, result] = await Promise.all([renewal, caller]);
  expect(calls).toEqual([whamUrl]);
  expect(result.quotaRefresh?.status).toBe("ok");
  expect(isAccountNeedsReauth(MAIN)).toBe(!explicitRefresh);
  expect(getNativeMainProfileRequestCount()).toBe(0);
});

test.each(["credential", "configuration"])("joined terminal-auth evidence cannot quarantine after %s changes", async fence => {
  const { renewal, caller, finish } = await joinPassiveRenewal(true);
  if (fence === "credential") writeMain(accountId, true);
  else {
    const generation = sweeper.captureConfigGeneration();
    spyOn(sweeper, "captureConfigGeneration").mockReturnValue(generation + 1);
  }
  finish.resolve(Response.json({ detail: { code: "invalid_workspace_selected" } }, { status: 403 }));
  const [, result] = await Promise.all([renewal, caller]);
  expect(calls).toEqual([whamUrl]);
  expect(result.terminalAuthFailure).toBeUndefined();
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
  expect(getNativeMainProfileRequestCount()).toBe(0);
});
