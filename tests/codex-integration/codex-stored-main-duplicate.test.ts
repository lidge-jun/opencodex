import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential, readCodexAccountRecord } from "../../src/codex/account-store";
import { codexAccountUnusableReason } from "../../src/codex/account-usability";
import { resolveCodexAuthContext, isCodexAuthContextUsable, CodexPoolAuthenticationError } from "../../src/codex/auth-context";
import { isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { poolAccountDto, listCodexAuthAccounts } from "../../src/codex/auth-api/account-list";
import * as authCollision from "../../src/codex/auth-collision";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests, applyConfirmedMainCodexAccountTransition } from "../../src/codex/account-lifecycle";
import { runPassiveRead } from "../../src/lib/passive-read";
import { clearThreadAccountMap, clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { observeMainCodexCollisionIdentity } from "../../src/codex/collision-identity";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousCodexHome: string | undefined;
let previousOcxHome: string | undefined;
let config: OcxConfig;
const poolId = "stored-main-duplicate";
const email = "member@example.test";
function jwt(plan: string, member?: string, userId?: string, accountId = "shared-account"): string {
  return `header.${Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    chatgpt_account_id: accountId,
    "https://api.openai.com/auth": { chatgpt_plan_type: plan, ...(userId ? { chatgpt_user_id: userId } : {}) },
    ...(member ? { "https://api.openai.com/profile": { email: member } } : {}),
  })).toString("base64url")}.fake`;
}
function native(accountId = "shared-account", plan = "plus", member: string | undefined = email,
  observe = true, userId?: string): void {
  writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({
    tokens: { access_token: jwt(plan, member, userId, accountId), account_id: accountId },
  }));
  if (observe) reconcileMainCodexAccountRuntimeState();
}
function dto() {
  return poolAccountDto(config, config.codexAccounts![0]!, { quota: null, needsReauth: false }, true, false, 0, false);
}
function forbidNativeReads() {
  const read = spyOn(authCollision, "readCodexTokensResult").mockImplementation(() => { throw new Error("unexpected native read"); });
  const tokens = spyOn(authCollision, "readCodexTokens").mockImplementation(() => { throw new Error("unexpected native read"); });
  return () => {
    const calls = read.mock.calls.length + tokens.mock.calls.length;
    read.mockRestore();
    tokens.mockRestore();
    expect(calls).toBe(0);
  };
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-stored-main-duplicate-"));
  previousCodexHome = process.env.CODEX_HOME;
  previousOcxHome = process.env.OPENCODEX_HOME;
  process.env.CODEX_HOME = join(home, "codex");
  process.env.OPENCODEX_HOME = join(home, "ocx");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
  config = { port: 10100, providers: {}, defaultProvider: "openai", activeCodexAccountId: poolId,
    codexMainAccountHardLock: false, codexAccounts: [{ id: poolId, email, plan: "plus", isMain: false }] };
  saveCodexAccountCredential(poolId, { accessToken: jwt("plus", email), refreshToken: "fake-refresh",
    chatgptAccountId: "shared-account", expiresAt: Date.now() + 3600_000 });
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  resetMainCodexAccountIdentityTrackingForTests();
});
afterEach(() => {
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  resetMainCodexAccountIdentityTrackingForTests();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  removeTreeWithRetry(home);
});

describe("stored Pool duplicate of native main", () => {
  test("official rows join the same upstream user without exposing identity claims", async () => {
    writeFileSync(join(process.env.OPENCODEX_HOME!, "admin-api-token"), `ocx_admin_${"x".repeat(43)}\n`);
    native("shared-account", "plus", email, true, "same-user");
    saveCodexAccountCredential(poolId, { accessToken: jwt("plus", email, "same-user"),
      refreshToken: "fake-refresh", chatgptAccountId: "shared-account", expiresAt: Date.now() + 3600_000 });
    const rows = await runPassiveRead(() => listCodexAuthAccounts(config));
    const main = rows.find(row => row.id === "__main__")!;
    const pool = rows.find(row => row.id === poolId)!;
    expect(main).toMatchObject({ slotId: "__main__", slotKind: "native-main" });
    expect(pool).toMatchObject({ slotId: poolId, slotKind: "pool" });
    expect(main.upstreamAccountKey).toMatch(/^uai1_[0-9a-f]{64}$/);
    expect(pool.upstreamAccountKey).toBe(main.upstreamAccountKey);
    expect(JSON.stringify(rows)).not.toContain("same-user");
    expect(JSON.stringify(rows)).not.toContain("shared-account");

    saveCodexAccountCredential(poolId, { accessToken: jwt("plus", email, "other-user"),
      refreshToken: "fake-refresh", chatgptAccountId: "shared-account", expiresAt: Date.now() + 3600_000 });
    const changed = await runPassiveRead(() => listCodexAuthAccounts(config));
    expect(changed.find(row => row.id === poolId)?.upstreamAccountKey).not.toBe(main.upstreamAccountKey);
    expect(changed.find(row => row.id === "__main__")?.upstreamAccountKey).toBe(main.upstreamAccountKey);
  });

  test("a missing user claim or local secret preserves separate registered slots", async () => {
    native();
    const noSecret = await runPassiveRead(() => listCodexAuthAccounts(config));
    expect(noSecret.map(row => row.slotKind)).toEqual(["native-main", "pool"]);
    expect(noSecret.every(row => row.upstreamAccountKey === undefined)).toBe(true);
    writeFileSync(join(process.env.OPENCODEX_HOME!, "admin-api-token"), `ocx_admin_${"x".repeat(43)}\n`);
    const noClaim = await runPassiveRead(() => listCodexAuthAccounts(config));
    expect(noClaim.every(row => row.upstreamAccountKey === undefined)).toBe(true);
  });
  test("conflicting native user claims and pool account claims omit join keys", async () => {
    writeFileSync(join(process.env.OPENCODEX_HOME!, "admin-api-token"), `ocx_admin_${"x".repeat(43)}\n`);
    writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: {
      access_token: jwt("plus", email, "access-user"),
      id_token: jwt("plus", email, "different-user"),
      account_id: "shared-account",
    } }));
    reconcileMainCodexAccountRuntimeState();
    saveCodexAccountCredential(poolId, { accessToken: jwt("plus", email, "access-user", "other-account"),
      refreshToken: "fake-refresh", chatgptAccountId: "shared-account", expiresAt: Date.now() + 3600_000 });
    const rows = await runPassiveRead(() => listCodexAuthAccounts(config));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.upstreamAccountKey === undefined)).toBe(true);
    expect(rows.map(row => row.slotId)).toEqual(["__main__", poolId]);
  });
  test("conflicting replacement native claims remove a previously observed join key", async () => {
    writeFileSync(join(process.env.OPENCODEX_HOME!, "admin-api-token"), `ocx_admin_${"x".repeat(43)}\n`);
    native("shared-account", "plus", email, true, "same-user");
    expect((await runPassiveRead(() => listCodexAuthAccounts(config)))[0]?.upstreamAccountKey).toMatch(/^uai1_/);
    observeMainCodexCollisionIdentity({
      access_token: jwt("plus", email, "same-user", "other-account"),
      account_id: "shared-account",
    });
    expect((await runPassiveRead(() => listCodexAuthAccounts(config)))[0]?.upstreamAccountKey).toBeUndefined();
  });
  test("malformed present native ID token suppresses a previously observed join key", async () => {
    writeFileSync(join(process.env.OPENCODEX_HOME!, "admin-api-token"), `ocx_admin_${"x".repeat(43)}\n`);
    native("shared-account", "plus", email, true, "same-user");
    expect((await runPassiveRead(() => listCodexAuthAccounts(config)))[0]?.upstreamAccountKey).toMatch(/^uai1_/);
    observeMainCodexCollisionIdentity({
      access_token: jwt("plus", email, "same-user"),
      id_token: "malformed",
      account_id: "shared-account",
    });
    expect((await runPassiveRead(() => listCodexAuthAccounts(config)))[0]?.upstreamAccountKey).toBeUndefined();
    expect(codexAccountUnusableReason(config, poolId)).toBe("duplicate_main");
  });
  test("existing duplicate is ineligible without deleting its credential or config row", () => {
    native();
    expect(codexAccountUnusableReason(config, poolId)).toBe("duplicate_main");
    expect(readCodexAccountRecord(poolId)?.credential).toBeDefined();
    expect(config.codexAccounts).toHaveLength(1);
  });
  test("reverse native relogin excludes and later releases an existing pool entry", () => {
    native("other-account");
    expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
    native();
    expect(codexAccountUnusableReason(config, poolId)).toBe("duplicate_main");
    native("other-account");
    expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
  });
  test("automatic selection cannot fall back to a duplicate when main is excluded", async () => {
    native();
    await expect(resolveCodexAuthContext(new Headers(), config, "pool", {
      excludeAccountId: "__main__", primeCodexPoolQuotas: async () => {},
    })).rejects.toThrow();
  });
  test("an explicit stored-account selector cannot bypass duplicate exclusion", async () => {
    native();
    await expect(resolveCodexAuthContext(new Headers(), config, "pool", {
      accountId: poolId, primeCodexPoolQuotas: async () => {},
    })).rejects.toThrow();
  });
  test("an already-resolved context becomes unusable after native relogin", async () => {
    native("other-account");
    const ctx = await resolveCodexAuthContext(new Headers(), config, "pool", {
      accountId: poolId, primeCodexPoolQuotas: async () => {},
    });
    native();
    expect(isCodexAuthContextUsable(ctx, config)).toBe(false);
  });
  test("account DTO exposes an actionable exclusion independently of reauthentication", () => {
    native();
    const row = dto();
    expect(row.selectionExcludedReason).toBe("duplicate_main");
    expect(row.selectionExcludedAction).toContain("native Codex");
    expect(row.needsReauth).toBe(false);
    expect(row.hasCredential).toBe(true);
  });
  test("DTO follows reverse relogin and recovers without changing the pool", () => {
    native("other-account");
    expect(dto().selectionExcludedReason).toBeUndefined();
    native();
    expect(dto().selectionExcludedReason).toBe("duplicate_main");
    native("other-account");
    expect(dto().selectionExcludedReason).toBeUndefined();
  });
  test.each([
    { name: "normalized matching email", mainEmail: " MEMBER@EXAMPLE.TEST ", poolEmail: email, mainPlan: "pro", poolPlan: "plus", blocked: true },
    { name: "missing native email", mainEmail: "", poolEmail: email, mainPlan: "plus", poolPlan: "plus", blocked: true },
    { name: "missing stored email", mainEmail: email, poolEmail: "", mainPlan: "plus", poolPlan: "plus", blocked: true },
    { name: "same workspace subscription", mainEmail: email, poolEmail: email, mainPlan: "team", poolPlan: "business", blocked: true },
    { name: "distinct workspace members", mainEmail: "other@example.test", poolEmail: email, mainPlan: "team", poolPlan: "team", blocked: false },
    { name: "native workspace and stored personal", mainEmail: email, poolEmail: email, mainPlan: "team", poolPlan: "plus", blocked: false },
    { name: "native personal and stored workspace", mainEmail: email, poolEmail: email, mainPlan: "plus", poolPlan: "team", blocked: false },
  ])("$name", scenario => {
    config.codexAccounts![0]!.email = scenario.poolEmail;
    config.codexAccounts![0]!.plan = scenario.poolPlan;
    native("shared-account", scenario.mainPlan, scenario.mainEmail);
    expect(codexAccountUnusableReason(config, poolId)).toBe(scenario.blocked ? "duplicate_main" : undefined);
  });
  test("no native credential leaves the pool usable", () => {
    expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
    expect(dto().selectionExcludedReason).toBeUndefined();
  });
  test.each([
    { name: "missing persisted email", storedEmail: "", tokenEmail: email, blocked: true },
    { name: "legacy account-id email", storedEmail: poolId, tokenEmail: email, blocked: true },
    { name: "legacy email with distinct workspace member", storedEmail: poolId, tokenEmail: "colleague@example.test", blocked: false },
  ])("token metadata repairs $name", scenario => {
    config.codexAccounts![0]!.email = scenario.storedEmail;
    delete config.codexAccounts![0]!.plan;
    saveCodexAccountCredential(poolId, { accessToken: jwt("team", scenario.tokenEmail), refreshToken: "fake-refresh",
      chatgptAccountId: "shared-account", expiresAt: Date.now() + 3600_000 });
    native("shared-account", "team");
    expect(codexAccountUnusableReason(config, poolId)).toBe(scenario.blocked ? "duplicate_main" : undefined);
    expect(dto().selectionExcludedReason).toBe(scenario.blocked ? "duplicate_main" : undefined);
  });
  test("known duplicate remains excluded for caller-owned and drain selection without native reads", () => {
    native();
    const restore = forbidNativeReads();
    try {
      expect(codexAccountUnusableReason(config, poolId, { requestOwnedMainCredential: true })).toBe("duplicate_main");
      expect(codexAccountUnusableReason(config, poolId, { nativeMainSelectionOnly: true })).toBe("duplicate_main");
      expect(dto().selectionExcludedReason).toBe("duplicate_main");
    } finally { restore(); }
  });
  test("caller-owned exact selection refuses known duplicate without native reads", async () => {
    native();
    const restore = forbidNativeReads();
    try {
      await expect(resolveCodexAuthContext(new Headers({ authorization: `Bearer ${jwt("plus", email)}` }), config, "pool", {
        accountId: poolId, requestScopedMainCredential: true,
        primeCodexPoolQuotas: async () => {},
      })).rejects.toThrow();
    } finally { restore(); }
  });
  test("draining selection refuses known duplicate without native reads", async () => {
    native();
    const restore = forbidNativeReads();
    try {
      await expect(resolveCodexAuthContext(new Headers(), config, "pool", {
        accountId: poolId, beginCodexAccountSelection: () => ({ mainProfileDraining: true,
          claimMainProfile: () => false, release: () => {} }),
        primeCodexPoolQuotas: async () => {},
      })).rejects.toThrow();
    } finally { restore(); }
  });
  test("passive account list projects known exclusion without native reads", async () => {
    native();
    const restore = forbidNativeReads();
    try {
      const rows = await runPassiveRead(() => listCodexAuthAccounts(config));
      expect(rows.find(row => row.id === poolId)?.selectionExcludedReason).toBe("duplicate_main");
    } finally { restore(); }
  });
  test("post-refresh and context revalidation perform no native reads after selection release", async () => {
    native("other-account");
    saveCodexAccountCredential(poolId, { accessToken: jwt("plus", email), refreshToken: "fake-refresh",
      chatgptAccountId: "shared-account", expiresAt: 0 });
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      access_token: jwt("plus", email), refresh_token: "fake-new-refresh", expires_in: 3600,
    }));
    let restore: (() => void) | undefined;
    try {
      const ctx = await resolveCodexAuthContext(new Headers(), config, "pool", {
        accountId: poolId, beginCodexAccountSelection: () => ({ mainProfileDraining: false,
          claimMainProfile: () => true, release: () => { restore = forbidNativeReads(); } }),
        primeCodexPoolQuotas: async () => {},
      });
      expect(ctx.kind).toBe("pool");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(isCodexAuthContextUsable(ctx, config)).toBe(true);
    } finally { fetch.mockRestore(); restore?.(); }
  });
  test("a duplicate observed during refresh refuses without quarantining a healthy pool credential", async () => {
    native("other-account");
    saveCodexAccountCredential(poolId, { accessToken: jwt("plus", email), refreshToken: "fake-refresh",
      chatgptAccountId: "shared-account", expiresAt: 0 });
    let refreshStarted!: () => void;
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    let finishRefresh!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finishRefresh = resolve; });
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
      refreshStarted();
      return response;
    });
    const pending = resolveCodexAuthContext(new Headers(), config, "pool", {
      accountId: poolId, primeCodexPoolQuotas: async () => {},
    });
    const settled = pending.then(() => undefined, cause => cause);
    try {
      await started;
      native();
      finishRefresh(Response.json({ access_token: jwt("plus", email), refresh_token: "fake-new-refresh", expires_in: 3600 }));
      const refusal = await settled;
      expect(refusal).toBeInstanceOf(Error);
      expect(isAccountNeedsReauth(poolId)).toBe(false);
      expect(refusal).toBeInstanceOf(CodexPoolAuthenticationError);
      expect(codexAccountUnusableReason(config, poolId)).toBe("duplicate_main");
      expect(readCodexAccountRecord(poolId)?.credential?.refreshToken).toBe("fake-new-refresh");
      native("other-account");
      expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
      const ctx = await resolveCodexAuthContext(new Headers(), config, "pool", {
        accountId: poolId, primeCodexPoolQuotas: async () => {},
      });
      expect(ctx.kind).toBe("pool");
      expect(isCodexAuthContextUsable(ctx, config)).toBe(true);
      expect(isAccountNeedsReauth(poolId)).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      finishRefresh(Response.json({ access_token: jwt("plus", email), expires_in: 3600 }));
      await settled;
      fetch.mockRestore();
    }
  });
  test("external relogin is detected only after the next owned observation", () => {
    native("other-account");
    native("shared-account", "plus", email, false);
    expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
    reconcileMainCodexAccountRuntimeState();
    expect(codexAccountUnusableReason(config, poolId)).toBe("duplicate_main");
  });
  test("same-id email and plan changes refresh the collision snapshot", () => {
    native();
    native("shared-account", "plus", "other@example.test");
    expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
    native("shared-account", "team");
    expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
    native();
    expect(codexAccountUnusableReason(config, poolId)).toBe("duplicate_main");
  });
  test("transient malformed read preserves evidence; confirmed missing clears it", () => {
    native();
    writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), "{");
    reconcileMainCodexAccountRuntimeState();
    expect(codexAccountUnusableReason(config, poolId)).toBe("duplicate_main");
    unlinkSync(join(process.env.CODEX_HOME!, "auth.json"));
    reconcileMainCodexAccountRuntimeState();
    expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
  });
  test("confirmed transition and identity generation retirement clear collision evidence", () => {
    native();
    applyConfirmedMainCodexAccountTransition("shared-account", "replacement-account");
    expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
    native();
    clearMainAccountInfoCache();
    expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
  });
  test("an observation from another home is never reused", () => {
    native();
    const original = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = join(home, "other-home");
      expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
      expect(dto().selectionExcludedReason).toBeUndefined();
    } finally { process.env.CODEX_HOME = original; }
  });
});

test("owned API-key-only login retires the prior ChatGPT collision", () => {
  native();
  expect(codexAccountUnusableReason(config, poolId)).toBe("duplicate_main");
  writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ auth_mode: "api_key", OPENAI_API_KEY: "fake-native-key" }));
  reconcileMainCodexAccountRuntimeState();
  expect(codexAccountUnusableReason(config, poolId)).toBeUndefined();
});
