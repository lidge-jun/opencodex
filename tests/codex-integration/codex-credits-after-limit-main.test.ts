import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAccountCooldownError,
  CodexMainAccountCreditsOffError,
  CodexMainAccountHardLockError,
  cooldownErrorMessage,
  resolveCodexAuthContext,
  shouldMarkAccountNeedsReauthForCodexAuthFailure,
} from "../../src/codex/auth-context";
import { setCodexAccountCreditsAfterLimit } from "../../src/codex/account-credit-use";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import * as mainAccount from "../../src/codex/main-account";
import * as authCollision from "../../src/codex/auth-collision";
import { captureMainQuotaWriter, getMainQuotaCredentialGeneration, observeMainQuotaCredential } from "../../src/codex/main-account-cache";
import { clearAccountQuota, getAccountQuota, parseUsageQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { CODEX_CREDITS_FRESHNESS_MS, hasSpendableCodexCredits, type CodexSpendableCredits } from "../../src/codex/quota-types";
import { fetchCodexUsage, resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { runMainAccountHardLockRecovery } from "../../src/codex/auth-api/pool-mode-gate";
import { captureConfigGeneration, STATE_SWEEP_INTERVAL_MS } from "../../src/lib/state-store-sweeper";
import { WHAM_REQUEST_TIMEOUT_MS } from "../../src/codex/quota-recovery-timing";
import { codexAuthContextErrorResponse } from "../../src/server/responses/codex-auth-error";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexQuotaHealthSnapshot, pickLowestUsageCodexAccount, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MAIN = mainAccount.MAIN_CODEX_ACCOUNT_ID;
const accountId = "credits-main-fixture";
const POOL = "credits-main-pool";
const DAY_MS = 24 * 60 * 60_000;
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let tokenExpiry: number;

function bearer(): string {
  const payload = Buffer.from(JSON.stringify({
    exp: tokenExpiry,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

/** The hard lock is off so that only the credits switch can refuse the main login. */
function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    codexMainAccountHardLock: false,
    autoSwitchThreshold: 0,
    activeCodexAccountId: MAIN,
    providers: { openai: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      codexAccountMode: "pool",
    } },
    codexAccounts: [],
  };
}

function mainWeekly(percent: number, resetAt: number): void {
  const writer = captureMainQuotaWriter(accountId);
  if (!writer) throw new Error("fixture identity must be observed first");
  setAccountQuotaFromParsed(MAIN, { weeklyPercent: percent, weeklyResetAt: resetAt,
    credits: { hasCredits: true, balance: 42.5, observedAt: Date.now() } }, undefined, writer);
}

/** Seed current full-window policy with a separate, explicitly controlled credit observation. */
function mainCreditObservation(now: number, credits: CodexSpendableCredits | null): void {
  clearAccountQuota(MAIN);
  setAccountQuotaFromParsed(MAIN, { weeklyPercent: 100, weeklyResetAt: now + DAY_MS,
    credits }, undefined, captureMainQuotaWriter(accountId)!);
  observeMainQuotaCredential(bearer(), accountId);
}

/** Exercise caller-owned admission and the production HTTP error mapping without auth-file I/O. */
async function creditRefusal(cfg: OcxConfig, now: number) {
  const headers = new Headers({ authorization: `Bearer ${bearer()}`, "chatgpt-account-id": accountId });
  const error = await resolveCodexAuthContext(headers, cfg, "direct", { requestScopedMainCredential: true })
    .catch(cause => cause);
  expect(error).toBeInstanceOf(CodexMainAccountCreditsOffError);
  expect(error.resetAt).toBe(now + DAY_MS);
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
  expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(error)).toBe(false);
  const response = codexAuthContextErrorResponse(error, { now })!;
  expect(response.status).toBe(429);
  const body = await response.json();
  expect(body.error.type).toBe("rate_limit_error");
  expect(body.error.message).toBe(error.message);
  return { error, response };
}

function addPoolAccount(cfg: OcxConfig): void {
  cfg.codexAccounts = [{ id: POOL, email: "pool@example.test", isMain: false }];
  saveCodexAccountCredential(POOL, {
    accessToken: "fixture-pool-access",
    refreshToken: "fixture-pool-refresh",
    expiresAt: Date.now() + DAY_MS,
    chatgptAccountId: "fixture-pool-account",
  });
  setAccountQuotaFromParsed(POOL, { weeklyPercent: 10 });
}

beforeEach(() => {
  tokenExpiry = Math.floor(Date.now() / 1000) + 86_400;
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-credits-main-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  resetMainCodexAccountIdentityTrackingForTests();
  clearAccountQuota();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth(MAIN);
  clearAccountNeedsReauth(POOL);
  resetQuotaQueryBackoffForTests();
  mainAccount.setMainAccountPlan(null);
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    tokens: { access_token: bearer(), refresh_token: "fixture-refresh", account_id: accountId },
  }));
  reconcileMainCodexAccountRuntimeState();
});

afterEach(() => {
  mock.restore();
  clearAccountQuota();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth(MAIN);
  clearAccountNeedsReauth(POOL);
  resetQuotaQueryBackoffForTests();
  resetMainCodexAccountIdentityTrackingForTests();
  mainAccount.setMainAccountPlan(null);
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

test("a full main login allowed to use credits keeps serving", async () => {
  const cfg = config();
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  mainWeekly(100, Date.now() + DAY_MS);
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
    .resolves.toMatchObject({ kind: "main-pool", accountId: MAIN });
});

test.each([false, true])("WHAM included-plan refusal respects the main spending control (%j)", async reached => {
  const cfg = config();
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  const quota = parseUsageQuota({
    plan_type: "pro",
    rate_limit: { allowed: false, primary_window: {
      used_percent: 100, limit_window_seconds: 604_800, reset_at: Date.now() + DAY_MS,
    } },
    credits: { has_credits: true, balance: "42.5", overage_limit_reached: false },
    spend_control: { reached },
  });
  setAccountQuotaFromParsed(MAIN, quota, undefined, captureMainQuotaWriter(accountId)!);
  const result = resolveCodexAuthContext(new Headers(), cfg, "pool");
  if (reached) await expect(result).rejects.toBeInstanceOf(CodexMainAccountCreditsOffError);
  else await expect(result).resolves.toMatchObject({ kind: "main-pool", accountId: MAIN });
});

test.each([{ reached: true }, {}])("a control-only refusal retracts cached main credit permission (%j)", async spend_control => {
  const cfg = config();
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  mainWeekly(100, Date.now() + DAY_MS);
  const writer = captureMainQuotaWriter(accountId)!;
  setAccountQuotaFromParsed(MAIN, parseUsageQuota({
    credits: { has_credits: true, balance: "42.5" }, spend_control: { reached: false },
  }), undefined, writer);
  expect(hasSpendableCodexCredits(getAccountQuota(MAIN))).toBe(true);
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
    .resolves.toMatchObject({ kind: "main-pool", accountId: MAIN });

  const retraction = parseUsageQuota({ spend_control });
  expect(retraction).toEqual({ credits: null });
  setAccountQuotaFromParsed(MAIN, retraction, undefined, writer);
  expect(getAccountQuota(MAIN)?.credits).toBeNull();
  expect(hasSpendableCodexCredits(getAccountQuota(MAIN))).toBe(false);
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
    .rejects.toBeInstanceOf(CodexMainAccountCreditsOffError);
});

test("main credit consent without a fresh balance cannot release a full window", async () => {
  const cfg = config();
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  mainWeekly(100, Date.now() + DAY_MS);
  const writer = captureMainQuotaWriter(accountId)!;
  setAccountQuotaFromParsed(MAIN, { credits: {
    hasCredits: true, balance: 42.5, observedAt: Date.now() - 300_001,
  } }, undefined, writer);
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
    .rejects.toBeInstanceOf(CodexMainAccountCreditsOffError);
});

test.each([false, true])("only expired spendable evidence gets a short check-again hint (unlimited=%j)", async unlimited => {
  const now = Date.now();
  spyOn(Date, "now").mockReturnValue(now);
  const cfg = config();
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  mainCreditObservation(now, { observedAt: now - CODEX_CREDITS_FRESHNESS_MS - 1,
    hasCredits: true, unlimited, ...(unlimited ? {} : { balance: 5 }) });
  const forbidden = () => { throw new Error("credit refusal read physical main"); };
  spyOn(authCollision, "readCodexTokens").mockImplementation(forbidden);
  spyOn(mainAccount, "getMainAccountToken").mockImplementation(forbidden);
  spyOn(mainAccount, "getValidMainAccountToken").mockImplementation(forbidden);
  const { error, response } = await creditRefusal(cfg, now);
  expect(error.cooldownUntil).toBe(now + STATE_SWEEP_INTERVAL_MS + WHAM_REQUEST_TIMEOUT_MS);
  expect(response.headers.get("Retry-After")).toBe("68");
  expect(error.message).toContain("information has expired");
  expect(error.message).not.toContain("spending ChatGPT credits is off");
});

test.each(["consent-off", "no-credits", "zero-balance", "spending-off", "overage"])(
  "%s retains the real reset deadline and reports the actual blocker", async condition => {
    const now = Date.now();
    spyOn(Date, "now").mockReturnValue(now);
    const cfg = config();
    setCodexAccountCreditsAfterLimit(cfg, MAIN, condition !== "consent-off");
    mainCreditObservation(now, { observedAt: now, hasCredits: condition !== "no-credits",
      balance: condition === "zero-balance" ? 0 : 5, unlimited: false,
      allowed: condition !== "spending-off", overageLimitReached: condition === "overage" });
    const { error, response } = await creditRefusal(cfg, now);
    expect(error.cooldownUntil).toBe(now + DAY_MS);
    expect(response.headers.get("Retry-After")).toBe(String(DAY_MS / 1000));
    expect(error.message).toContain(condition === "consent-off" ? "spending ChatGPT credits is off"
      : condition === "spending-off" || condition === "overage" ? "spending restriction" : "no spendable balance");
    expect(error.message).not.toContain("information has expired");
  });

test.each(["missing", "balance-missing", "flags-missing", "future", "invalid-time", "negative-time", "invalid-balance", "inconsistent"])(
  "%s evidence stays unverified rather than claiming expired spendable funds", async condition => {
    const now = Date.now();
    spyOn(Date, "now").mockReturnValue(now);
    const cfg = config();
    setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
    const credits: CodexSpendableCredits = { observedAt: now - CODEX_CREDITS_FRESHNESS_MS - 1,
      hasCredits: true, balance: 5 };
    if (condition === "balance-missing") delete credits.balance;
    if (condition === "flags-missing") delete credits.hasCredits;
    if (condition === "future") credits.observedAt = now + 60_000;
    if (condition === "invalid-time") credits.observedAt = Number.NaN;
    if (condition === "negative-time") credits.observedAt = -1;
    if (condition === "invalid-balance") credits.balance = Number.NaN;
    if (condition === "inconsistent") { credits.hasCredits = false; credits.unlimited = true; }
    mainCreditObservation(now, condition === "missing" ? null : credits);
    const { error, response } = await creditRefusal(cfg, now);
    expect(error.cooldownUntil).toBe(now + DAY_MS);
    expect(response.headers.get("Retry-After")).toBe(String(DAY_MS / 1000));
    expect(error.message).toContain("cannot be verified");
    expect(error.message).not.toContain("information has expired");
  });

test.each([true, false])("the short hint respects only the current WHAM credential's Retry-After (%j)", async sameCredential => {
  const now = Date.now();
  spyOn(Date, "now").mockReturnValue(now);
  const cfg = config();
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  mainCreditObservation(now, { observedAt: now - CODEX_CREDITS_FRESHNESS_MS - 1, hasCredits: true, balance: 5 });
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "900" } }));
  const generation = getMainQuotaCredentialGeneration() + (sameCredential ? 0 : 1);
  const query = await fetchCodexUsage(`main:${captureConfigGeneration()}:${generation}`, {});
  if (!query || query.kind !== "owner") throw new Error("fixture WHAM query was not dispatched");
  query.settle(false);
  const { error, response } = await creditRefusal(cfg, now);
  expect(error.cooldownUntil).toBe(now + (sameCredential ? 900_000 : 68_000));
  expect(response.headers.get("Retry-After")).toBe(sameCredential ? "900" : "68");
});

test("a real account-wide cooldown is never shortened by the stale-credit hint", async () => {
  const now = Date.now();
  spyOn(Date, "now").mockReturnValue(now);
  const cfg = config();
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  mainCreditObservation(now, { observedAt: now - CODEX_CREDITS_FRESHNESS_MS - 1, hasCredits: true, balance: 5 });
  recordCodexUpstreamOutcome(cfg, MAIN, 429, { now, retryAfter: "900" });
  const deadline = getCodexQuotaHealthSnapshot(MAIN, undefined, now)!.cooldownUntil!;
  const { error, response } = await creditRefusal(cfg, now);
  expect(error.cooldownUntil).toBe(deadline);
  expect(response.headers.get("Retry-After")).toBe(String(Math.ceil((deadline - now) / 1000)));
});

test.each([true, false])("a later WHAM200 with credits empty or omitted still refuses (%j)", async empty => {
  let now = Math.floor(Date.now() / 1000) * 1000;
  spyOn(Date, "now").mockImplementation(() => now);
  const cfg = config();
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  const observedAt = now - CODEX_CREDITS_FRESHNESS_MS - 1;
  mainCreditObservation(now, { observedAt, hasCredits: true, balance: 5 });
  expect((await creditRefusal(cfg, now)).response.headers.get("Retry-After")).toBe("68");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ plan_type: "plus",
    rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604_800,
      reset_at: Math.floor((now + DAY_MS) / 1000) }, secondary_window: null, tertiary_window: null },
    ...(empty ? { credits: { has_credits: false, unlimited: false, balance: 0 } } : {}) }));
  await runMainAccountHardLockRecovery(cfg);
  const { error, response } = await creditRefusal(cfg, now);
  expect(error.message).toContain(empty ? "no spendable balance" : "information has expired");
  expect(response.headers.get("Retry-After")).toBe(empty ? String(DAY_MS / 1000) : "68");
  if (!empty) expect(getAccountQuota(MAIN)?.credits?.observedAt).toBe(observedAt);
  now += 68_000;
  await runMainAccountHardLockRecovery(cfg);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("by default a full main login is refused as a cooldown that names its reset", async () => {
  const cfg = config();
  const resetAt = Date.now() + DAY_MS;
  mainWeekly(100, resetAt);
  const refused = await resolveCodexAuthContext(new Headers(), cfg, "pool").catch(error => error);
  expect(refused).toBeInstanceOf(CodexMainAccountCreditsOffError);
  expect(refused).toBeInstanceOf(CodexAccountCooldownError);
  expect(refused).not.toBeInstanceOf(CodexMainAccountHardLockError);
  expect((refused as CodexMainAccountCreditsOffError).resetAt).toBe(resetAt);
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", { accountId: MAIN }))
    .rejects.toBeInstanceOf(CodexMainAccountCreditsOffError);
});

test("by default the pool moves to another account instead of the full main login", async () => {
  const cfg = config();
  addPoolAccount(cfg);
  mainWeekly(100, Date.now() + DAY_MS);
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
    .resolves.toMatchObject({ kind: "pool", accountId: POOL });
});

test("a caller using the main credential is held too, without reading the physical auth file", async () => {
  const cfg = config();
  addPoolAccount(cfg);
  cfg.activeCodexAccountPinned = MAIN;
  observeMainQuotaCredential(bearer(), accountId);
  mainWeekly(100, Date.now() + DAY_MS);
  const forbidden = () => { throw new Error("caller-owned path read physical main"); };
  spyOn(authCollision, "readCodexTokens").mockImplementation(forbidden);
  spyOn(mainAccount, "getMainAccountToken").mockImplementation(forbidden);
  spyOn(mainAccount, "getValidMainAccountToken").mockImplementation(forbidden);
  const headers = new Headers({ authorization: `Bearer ${bearer()}`, "chatgpt-account-id": accountId });
  await expect(resolveCodexAuthContext(headers, cfg, "pool", { requestScopedMainCredential: true }))
    .resolves.toMatchObject({ kind: "pool", accountId: POOL });
});

test("an elapsed reset or a reading below 100% releases the main login", async () => {
  const cfg = config();
  mainWeekly(100, Date.now() - 60_000);
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
    .resolves.toMatchObject({ kind: "main-pool", accountId: MAIN });
  mainWeekly(99, Date.now() + DAY_MS);
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
    .resolves.toMatchObject({ kind: "main-pool", accountId: MAIN });
});

test("selection leaves a held main login out of the candidates on its own", () => {
  // The policy check above would refuse main later anyway; this pins the selection-side hold, which
  // is what lets the pool pick another account instead of failing on main.
  const cfg = config();
  addPoolAccount(cfg);
  setAccountQuotaFromParsed(POOL, { weeklyPercent: 50 });
  mainWeekly(100, Date.now() + DAY_MS);
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  expect(pickLowestUsageCodexAccount(cfg, POOL)).toBe(MAIN);
  setCodexAccountCreditsAfterLimit(cfg, MAIN, false);
  expect(pickLowestUsageCodexAccount(cfg, POOL)).toBeNull();
});

test("a full window that lands during the token refresh stays a policy refusal, not a reauth", async () => {
  // The second policy check runs after the awaited refresh; a refusal there must not be read as a
  // failed login, or a valid main account would stay marked for reauthentication past its reset.
  const cfg = config();
  const resetAt = Date.now() + DAY_MS;
  mainWeekly(50, resetAt);
  const refused = await resolveCodexAuthContext(new Headers(), cfg, "pool", {
    getValidMainAccountToken: async () => {
      mainWeekly(100, resetAt);
      return { accessToken: bearer(), chatgptAccountId: accountId };
    },
  }).catch(error => error);
  expect(refused).toBeInstanceOf(CodexMainAccountCreditsOffError);
  expect(isAccountNeedsReauth(MAIN)).toBe(false);
  expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(refused)).toBe(false);
});

test("the client sees the credits remedy, not cooldown-clearing advice", () => {
  const message = cooldownErrorMessage(new CodexMainAccountCreditsOffError(Date.now() + DAY_MS));
  expect(message).toContain("spending ChatGPT credits is off");
  expect(message).not.toContain("clear-cooldown");
});

test("with the default hard lock on, allowing credits does not lift the main lock", async () => {
  // The two policies are separate on purpose: the lock (98% by default) still stops the main
  // login first, and the dashboard says so next to the main account's credits switch.
  const cfg = config();
  delete cfg.codexMainAccountHardLock;
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  mainWeekly(100, Date.now() + DAY_MS);
  await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
    .rejects.toBeInstanceOf(CodexMainAccountHardLockError);
});
