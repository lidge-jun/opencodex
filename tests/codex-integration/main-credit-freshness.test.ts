import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCodexCooldownRecoveryProbeWorker, runMainCreditFreshnessRefresh } from "../../src/codex/auth-api";
import { MAIN_CREDITS_REFRESH_AFTER_MS } from "../../src/codex/auth-api/main-credit-freshness";
import { CodexMainAccountCreditsOffError, resolveCodexAuthContext } from "../../src/codex/auth-context";
import { setCodexAccountCreditsAfterLimit } from "../../src/codex/account-credit-use";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { captureMainQuotaWriter, clearMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { clearAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { CODEX_CREDITS_FRESHNESS_MS } from "../../src/codex/quota-types";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import * as sweeper from "../../src/lib/state-store-sweeper";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const accountId = "credit-freshness-main";
const whamUrl = "https://chatgpt.com/backend-api/wham/usage";
const DAY_MS = 24 * 60 * 60_000;
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;

/** The hard lock is off so that only the credits hold can refuse the main login. */
function config(): OcxConfig {
  const cfg: OcxConfig = {
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
  setCodexAccountCreditsAfterLimit(cfg, MAIN, true);
  return cfg;
}

/** Encode synthetic account and expiry claims for the fixture; this is not a signed credential. */
function bearer(): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 86_400,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

/** Seed the observed main login with a weekly window and a credit balance observed `creditAgeMs` ago. */
function seedMain(weeklyPercent: number, creditAgeMs: number, credits: "positive" | "retracted" = "positive"): void {
  const writer = captureMainQuotaWriter(accountId);
  if (!writer) throw new Error("fixture identity must be observed first");
  setAccountQuotaFromParsed(MAIN, {
    weeklyPercent, weeklyResetAt: Date.now() + DAY_MS,
    credits: credits === "positive"
      ? { hasCredits: true, balance: 42.5, observedAt: Date.now() - creditAgeMs }
      : null,
  }, undefined, writer);
}

/** Stub WHAM with an exhausted weekly window that still reports a spendable balance. */
function stubWham(): string[] {
  const calls: string[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    expect(url).toBe(whamUrl);
    return Response.json({
      plan_type: "plus",
      rate_limit: { primary_window: {
        used_percent: 100, limit_window_seconds: 604_800, reset_at: Math.floor((Date.now() + DAY_MS) / 1000),
      } },
      credits: { has_credits: true, balance: "42.5", overage_limit_reached: false },
    });
  }, { preconnect: previousFetch.preconnect });
  return calls;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousFetch = globalThis.fetch;
  home = mkdtempSync(join(tmpdir(), "ocx-main-credit-freshness-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  clearAccountQuota();
  clearThreadAccountMap();
  clearAccountNeedsReauth(MAIN);
  clearCodexUpstreamHealth();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  setMainAccountPlan(null);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
    access_token: bearer(), refresh_token: "fixture-refresh", account_id: accountId,
  } }));
  reconcileMainCodexAccountRuntimeState();
});

afterEach(async () => {
  globalThis.fetch = previousFetch;
  clearAccountQuota();
  clearThreadAccountMap();
  clearAccountNeedsReauth(MAIN);
  clearCodexUpstreamHealth();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  setMainAccountPlan(null);
  try {
    await flushConfigDirHardeningForTests();
  } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(home);
  }
});

describe("main credit freshness refresh", () => {
  test("refreshes before the freshness horizon so an opted-in main login keeps serving", async () => {
    expect(MAIN_CREDITS_REFRESH_AFTER_MS).toBeLessThan(CODEX_CREDITS_FRESHNESS_MS - 60_000);
    const cfg = config();
    seedMain(100, MAIN_CREDITS_REFRESH_AFTER_MS);
    const calls = stubWham();
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      await runMainCreditFreshnessRefresh(cfg);
      expect(calls).toEqual([whamUrl]);
      const observedAt = getMainPolicyQuota()?.credits?.observedAt;
      expect(observedAt).toBe(now);
      // Past the original observation's horizon, the refreshed evidence still serves the request.
      now += CODEX_CREDITS_FRESHNESS_MS - MAIN_CREDITS_REFRESH_AFTER_MS + 1;
      await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
        .resolves.toMatchObject({ kind: "main-pool", accountId: MAIN });
    } finally { clock.mockRestore(); }
  });

  test("without the refresh the same request is refused once the evidence ages out", async () => {
    const cfg = config();
    seedMain(100, CODEX_CREDITS_FRESHNESS_MS + 1);
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
      .rejects.toBeInstanceOf(CodexMainAccountCreditsOffError);
    const calls = stubWham();
    await runMainCreditFreshnessRefresh(cfg);
    expect(calls).toEqual([whamUrl]);
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
      .resolves.toMatchObject({ kind: "main-pool", accountId: MAIN });
  });

  test("the existing sweep hook drives the refresh without adding a timer", async () => {
    const cfg = config();
    seedMain(100, MAIN_CREDITS_REFRESH_AFTER_MS);
    const calls = stubWham();
    let afterTick: (() => void) | undefined;
    const registration = spyOn(sweeper, "registerStateSweepAfterTick").mockImplementation(entry => {
      afterTick = entry.afterTick;
      return () => {};
    });
    const timer = spyOn(globalThis, "setInterval");
    try {
      registerCodexCooldownRecoveryProbeWorker(cfg);
      expect(afterTick).toBeDefined();
      afterTick!();
      // Wait for the hook's own read; calling the refresh here would start one by itself.
      for (let attempt = 0; attempt < 200 && calls.length === 0; attempt++) await Bun.sleep(5);
      expect(timer).not.toHaveBeenCalled();
      expect(calls).toEqual([whamUrl]);
    } finally {
      registration.mockRestore();
      timer.mockRestore();
    }
  });

  test.each([
    ["fresh evidence", () => seedMain(100, 60_000)],
    ["included headroom", () => seedMain(50, MAIN_CREDITS_REFRESH_AFTER_MS)],
    ["retracted credits", () => seedMain(100, MAIN_CREDITS_REFRESH_AFTER_MS, "retracted")],
  ] as const)("%s makes no WHAM request", async (_label, seed) => {
    seed();
    const calls = stubWham();
    await runMainCreditFreshnessRefresh(config());
    expect(calls).toEqual([]);
  });

  test("a main login without credit consent makes no WHAM request", async () => {
    const cfg = config();
    setCodexAccountCreditsAfterLimit(cfg, MAIN, false);
    seedMain(100, MAIN_CREDITS_REFRESH_AFTER_MS);
    const calls = stubWham();
    await runMainCreditFreshnessRefresh(cfg);
    expect(calls).toEqual([]);
  });

  test("a main login that needs reauthentication makes no WHAM request", async () => {
    seedMain(100, MAIN_CREDITS_REFRESH_AFTER_MS);
    markAccountNeedsReauth(MAIN);
    const calls = stubWham();
    await runMainCreditFreshnessRefresh(config());
    expect(calls).toEqual([]);
  });
});
