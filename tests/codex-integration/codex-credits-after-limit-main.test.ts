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
import { captureMainQuotaWriter, observeMainQuotaCredential } from "../../src/codex/main-account-cache";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, pickLowestUsageCodexAccount } from "../../src/codex/routing";
import { setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
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
  setAccountQuotaFromParsed(MAIN, { weeklyPercent: percent, weeklyResetAt: resetAt }, undefined, writer);
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
  resetMainCodexAccountIdentityTrackingForTests();
  clearAccountQuota();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth(MAIN);
  clearAccountNeedsReauth(POOL);
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
  resetMainCodexAccountIdentityTrackingForTests();
  mainAccount.setMainAccountPlan(null);
  setIcaclsRunnerForTests(null);
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
