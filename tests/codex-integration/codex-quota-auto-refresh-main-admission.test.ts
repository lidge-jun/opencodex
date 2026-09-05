import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { setMainAccountPlan } from "../../src/codex/main-account";
import * as mainAccount from "../../src/codex/main-account";
import * as nativeClaim from "../../src/codex/native-main-claim";
import { clearAccountQuota, flushQuotaObservationsForTests, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { resetCodexQuotaAutoRefreshForTests, runCodexQuotaAutoRefresh, type CodexQuotaAutoRefreshWindows } from "../../src/codex/quota-auto-refresh";
import { getNativeMainProfileRequestCount, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const accountId = "fixture-auto-main";
const RESET_SECONDS = 1_700_000_000;
const RESET_MILLISECONDS = 1_700_000_000_000;
const responsesUrl = "https://chatgpt.com/backend-api/codex/responses";
const tokenUrl = "https://auth.openai.com/oauth/token";
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;
let now: number;

function config(): OcxConfig {
  return { defaultProvider: "openai", codexMainAccountHardLock: true, providers: { openai: {
    adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool",
  } }, codexAccounts: [], codexQuotaAutoRefresh: { [MAIN]: { fiveHour: true, weekly: true } } };
}

function bearer(expired = false): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + (expired ? -120 : 86_400),
    "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `header.${payload}.signature`;
}

function writeMain(accessToken = bearer(), workspace = accountId): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
    access_token: accessToken, refresh_token: "fixture-refresh", account_id: workspace,
  } }));
}

function observe(percent: number): void {
  const writer = captureMainQuotaWriter(accountId);
  if (!writer) throw new Error("Expected observed fixture identity");
  setAccountQuotaFromParsed(MAIN, { shortPercent: percent, shortWindowSeconds: 18_000,
    shortResetAt: RESET_SECONDS, weeklyPercent: 0, weeklyResetAt: RESET_SECONDS }, undefined, writer);
}

function recordMarkers(cfg: OcxConfig, id: string, completed: CodexQuotaAutoRefreshWindows): boolean {
  cfg.codexQuotaAutoRefresh = { ...cfg.codexQuotaAutoRefresh, [id]: {
    ...cfg.codexQuotaAutoRefresh?.[id],
    ...(completed.fiveHour !== undefined ? { lastFiveHourResetAt: completed.fiveHour } : {}),
    ...(completed.weekly !== undefined ? { lastWeeklyResetAt: completed.weekly } : {}),
  } };
  return true;
}

function completedResponse(): Response {
  return new Response('data: {"type":"response.completed"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
}

function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push(String(input));
    expect([tokenUrl, responsesUrl]).toContain(String(input));
    expect(getNativeMainProfileRequestCount()).toBe(1);
    return handler(String(input), init);
  }, { preconnect: previousFetch.preconnect });
  return calls;
}

function interceptShared(onOwned: () => void): () => void {
  const original = nativeClaim.withNativeMainSharedClaim;
  const spy = spyOn(nativeClaim, "withNativeMainSharedClaim").mockImplementation(async <T>(
    context: Parameters<typeof original>[0], operation: () => Promise<T>, options?: Parameters<typeof original>[2],
  ): Promise<T> => original(context, async () => { onOwned(); return operation(); }, options));
  return () => spy.mockRestore();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  now = Date.now();
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousFetch = globalThis.fetch;
  home = mkdtempSync(join(tmpdir(), "ocx-auto-main-admission-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  resetLifecycleDrainStateForTests();
  resetCodexQuotaAutoRefreshForTests();
  resetMainCodexAccountIdentityTrackingForTests();
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN);
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  writeMain();
  reconcileMainCodexAccountRuntimeState();
  observe(0);
});

afterEach(async () => {
  globalThis.fetch = previousFetch;
  clearAccountQuota();
  await flushQuotaObservationsForTests();
  clearAccountNeedsReauth(MAIN);
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  resetMainCodexAccountIdentityTrackingForTests();
  resetCodexQuotaAutoRefreshForTests();
  resetLifecycleDrainStateForTests();
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

describe("quota auto-refresh native-main admission", () => {
  test("owned reconciliation activates retained99 before token preparation when current identity was not observed", async () => {
    const cfg = config();
    const writer = captureMainQuotaWriter(accountId);
    if (!writer) throw new Error("Expected fixture's persisted policy owner");
    clearAccountQuota();
    resetMainCodexAccountIdentityTrackingForTests();
    clearMainAccountInfoCache();
    // Simulate a process which has not observed the current physical account yet.
    observeMainQuotaIdentity("fixture-unrelated-observation");
    writeMain(bearer(true));
    const quota = { shortPercent: 99, shortWindowSeconds: 18_000, shortResetAt: RESET_SECONDS,
      weeklyPercent: 0, weeklyResetAt: RESET_SECONDS, updatedAt: now };
    writeFileSync(join(home, "codex-quota-cache.json"), JSON.stringify({
      version: 1, quotas: { [MAIN]: quota }, mainPolicyQuota: { identityKey: writer.identityKey, quota },
    }));
    expect(getMainAccountHardLockStatus(cfg).state).toBe("unknown");
    const token = spyOn(mainAccount, "getValidMainAccountToken");
    const calls = installFetch(async () => completedResponse());
    try {
      await runCodexQuotaAutoRefresh(cfg, now, { persistCompleted: recordMarkers });
      expect(getMainAccountHardLockStatus(cfg)).toEqual({ enabled: true, state: "blocked" });
      expect(token).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(cfg.codexQuotaAutoRefresh?.[MAIN]).toEqual({ fiveHour: true, weekly: true });
      expect(getNativeMainProfileRequestCount()).toBe(0);
    } finally { token.mockRestore(); }
    writeMain();
    observe(0);
    await runCodexQuotaAutoRefresh(cfg, now + 1, { persistCompleted: recordMarkers });
    expect(calls).toEqual([responsesUrl]);
    expect(cfg.codexQuotaAutoRefresh?.[MAIN]?.lastWeeklyResetAt).toBe(RESET_MILLISECONDS);
  });

  test("retained99 skips main and markers after reset while an added account completes; fresh0 admits main immediately", async () => {
    const cfg = config();
    cfg.codexAccounts = [{ id: "pool-a", email: "pool@example.test", isMain: false }];
    cfg.codexQuotaAutoRefresh!["pool-a"] = { weekly: true };
    setAccountQuotaFromParsed("pool-a", { weeklyPercent: 0, weeklyResetAt: RESET_SECONDS });
    observe(99);
    const warmed: string[] = [];
    await runCodexQuotaAutoRefresh(cfg, now, { warmAccount: async (_cfg, id) => { warmed.push(id); }, persistCompleted: recordMarkers });
    expect(warmed).toEqual(["pool-a"]);
    expect(cfg.codexQuotaAutoRefresh?.[MAIN]).toEqual({ fiveHour: true, weekly: true });
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]?.lastWeeklyResetAt).toBe(RESET_MILLISECONDS);
    observe(0);
    const calls = installFetch(async () => completedResponse());
    await runCodexQuotaAutoRefresh(cfg, now + 1, { persistCompleted: recordMarkers });
    expect(calls).toEqual([responsesUrl]);
    expect(cfg.codexQuotaAutoRefresh?.[MAIN]).toMatchObject({ lastFiveHourResetAt: RESET_MILLISECONDS, lastWeeklyResetAt: RESET_MILLISECONDS });
    expect(getNativeMainProfileRequestCount()).toBe(0);
  });

  test("policy off preserves main warmup and its existing model fallback", async () => {
    const cfg = config();
    cfg.codexMainAccountHardLock = false;
    observe(99);
    const models: string[] = [];
    const calls = installFetch(async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return models.length === 1 ? new Response(null, { status: 400 }) : completedResponse();
    });
    await runCodexQuotaAutoRefresh(cfg, now, { persistCompleted: recordMarkers });
    expect(calls).toEqual([responsesUrl, responsesUrl]);
    expect(models).toEqual(["gpt-5.4-mini", "gpt-5.5"]);
    expect(cfg.codexQuotaAutoRefresh?.[MAIN]?.lastWeeklyResetAt).toBe(RESET_MILLISECONDS);
    expect(getNativeMainProfileRequestCount()).toBe(0);
  });

  test("expired token refresh precedes shared claim and inference uses the prepared credential", async () => {
    const cfg = config();
    writeMain(bearer(true));
    const fresh = bearer();
    const order: string[] = [];
    const restore = interceptShared(() => { order.push("shared"); });
    const calls = installFetch(async (url, init) => {
      if (url === tokenUrl) {
        order.push("refresh");
        return Response.json({ access_token: fresh, refresh_token: "fixture-rotated", expires_in: 86_400 });
      }
      order.push("inference");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${fresh}`);
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(accountId);
      return completedResponse();
    });
    try {
      await runCodexQuotaAutoRefresh(cfg, now, { persistCompleted: recordMarkers });
      expect(calls).toEqual([tokenUrl, responsesUrl]);
      expect(order).toEqual(["refresh", "shared", "inference"]);
      expect(cfg.codexQuotaAutoRefresh?.[MAIN]?.lastWeeklyResetAt).toBe(RESET_MILLISECONDS);
      expect(getNativeMainProfileRequestCount()).toBe(0);
    } finally { restore(); }
  });

  test.each(["policy", "pause", "reauth"] as const)("%s during refresh skips inference and completion without delaying later eligibility", async restriction => {
    const cfg = config();
    writeMain(bearer(true));
    const entered = deferred<void>();
    const response = deferred<Response>();
    const fresh = { access_token: bearer(), refresh_token: "fixture-rotated", expires_in: 86_400 };
    const calls = installFetch(async url => {
      if (url !== tokenUrl) return completedResponse();
      entered.resolve();
      return response.promise;
    });
    const run = runCodexQuotaAutoRefresh(cfg, now, { persistCompleted: recordMarkers });
    try {
      await Promise.race([entered.promise, run.then(() => { throw new Error("Token endpoint was never reached"); })]);
      if (restriction === "policy") observe(99);
      else if (restriction === "pause") cfg.pausedCodexAccountIds = [MAIN];
      else markAccountNeedsReauth(MAIN);
      response.resolve(Response.json(fresh));
      await run;
      expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens.access_token).toBe(fresh.access_token);
      expect(calls).toEqual([tokenUrl]);
      expect(cfg.codexQuotaAutoRefresh?.[MAIN]).toEqual({ fiveHour: true, weekly: true });
      expect(getNativeMainProfileRequestCount()).toBe(0);
      if (restriction === "reauth") expect(isAccountNeedsReauth(MAIN)).toBe(true);
      if (restriction === "policy") expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
    } finally { response.resolve(Response.json(fresh)); await run; }
    observe(0);
    cfg.pausedCodexAccountIds = [];
    clearAccountNeedsReauth(MAIN);
    await runCodexQuotaAutoRefresh(cfg, now + 1, { persistCompleted: recordMarkers });
    expect(calls).toEqual([tokenUrl, responsesUrl]);
    expect(cfg.codexQuotaAutoRefresh?.[MAIN]?.lastWeeklyResetAt).toBe(RESET_MILLISECONDS);
  });

  test.each(["bearer", "workspace", "missing", "policy", "pause", "reauth"] as const)("%s changing at shared-claim acquisition skips inference and markers", async change => {
    const cfg = config();
    const restore = interceptShared(() => {
      if (change === "bearer") writeMain("fixture-replacement-token");
      else if (change === "workspace") writeMain(bearer(), "fixture-other-workspace");
      else if (change === "missing") writeFileSync(join(home, "auth.json"), "{}");
      else if (change === "policy") observe(99);
      else if (change === "pause") cfg.pausedCodexAccountIds = [MAIN];
      else markAccountNeedsReauth(MAIN);
    });
    const calls = installFetch(async () => completedResponse());
    try {
      await runCodexQuotaAutoRefresh(cfg, now, { persistCompleted: recordMarkers });
      expect(calls).toEqual([]);
      expect(cfg.codexQuotaAutoRefresh?.[MAIN]).toEqual({ fiveHour: true, weekly: true });
      expect(getNativeMainProfileRequestCount()).toBe(0);
    } finally { restore(); }
    writeMain();
    observe(0);
    cfg.pausedCodexAccountIds = [];
    clearAccountNeedsReauth(MAIN);
    await runCodexQuotaAutoRefresh(cfg, now + 1, { persistCompleted: recordMarkers });
    expect(calls).toEqual([responsesUrl]);
    expect(cfg.codexQuotaAutoRefresh?.[MAIN]?.lastWeeklyResetAt).toBe(RESET_MILLISECONDS);
  });
});
