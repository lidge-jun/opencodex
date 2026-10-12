import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import {
  resolveCodexAuthContext, materializeCodexUpstreamAuth, applyCodexAuthContextToProvider,
  assertCodexAuthContextNotCooled, CodexPoolAccountCreditsOffError, createCodexAuthDispatchGuard,
  cooldownErrorMessage, cooldownErrorResponse, shouldMarkAccountNeedsReauthForCodexAuthFailure,
} from "../../src/codex/auth-context";
import { rebindPoolCreditPolicy } from "../../src/codex/pool-credit-policy";
import { TERMINAL_SHORT_WINDOW_FRESHNESS_MS } from "../../src/codex/quota-types";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { getAccountQuota, parseUsageQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { providerFetch, fetchWithHeaderTimeout } from "../../src/server/responses/fetch-helpers";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS, clearCodexUpstreamHealth, clearThreadAccountMap,
  recordCodexUpstreamOutcome, tryAcquireCodexQuotaProbeLease,
} from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ID = "credit-policy-fixture";
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
let dir = "";
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

function config(): OcxConfig {
  return {
    providers: {}, port: 10100, hostname: "127.0.0.1", codexMainAccountHardLock: false,
    codexAccounts: [{ id: ID, email: "fixture@example.test", isMain: false, plan: "pro" }],
    creditCodexAccountIds: [], activeCodexAccountId: ID, autoSwitchThreshold: 0,
    upstreamFailoverThreshold: 3,
  } as OcxConfig;
}
function quota(percent = 100, resetAt = Date.now() + 3_600_000): void {
  updateAccountQuota(ID, percent, resetAt);
  setAccountQuotaFromParsed(ID, { credits: { hasCredits: true, balance: 42.5, observedAt: Date.now() } });
}
const resolve = (cfg: OcxConfig) => resolveCodexAuthContext(new Headers(), cfg, "pool", { accountId: ID, modelId: "gpt-5.5" });

describe("stored-account credit policy at authentication", () => {
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    dir = mkdtempSync(join(tmpdir(), "ocx-pool-credit-policy-"));
    process.env.OPENCODEX_HOME = dir;
    process.env.CODEX_HOME = dir;
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState();
    clearAccountNeedsReauth(ID);
    saveCodexAccountCredential(ID, {
      accessToken: "access-token-value-credit-policy", refreshToken: "fixture-refresh-credit-policy",
      expiresAt: Date.now() + 3_600_000, chatgptAccountId: "fixture-workspace-credit-policy",
    });
  });
  afterEach(async () => {
    try {
      clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState();
      clearAccountNeedsReauth(ID);
      await flushConfigDirHardeningForTests();
    } finally {
      setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
      if (dir) removeTreeWithRetry(dir);
      dir = "";
    }
  });
  test("an exact selector respects the credits-off hold without quarantining the account", async () => {
    quota();
    await expect(resolve(config())).rejects.toBeInstanceOf(CodexPoolAccountCreditsOffError);
    expect(isAccountNeedsReauth(ID)).toBe(false);
  });
  test("an exact selector still respects credits-off when the default mode is Direct", async () => {
    quota();
    await expect(resolveCodexAuthContext(new Headers(), config(), "direct", { accountId: ID, modelId: "gpt-5.5" }))
      .rejects.toBeInstanceOf(CodexPoolAccountCreditsOffError);
    expect(isAccountNeedsReauth(ID)).toBe(false);
  });
  test("a spending-control-only refusal revokes an opted-in exact account's cached permission", async () => {
    const cfg = config(); cfg.creditCodexAccountIds = [ID]; quota();
    const revoked = parseUsageQuota({ spend_control: { reached: true } });
    expect(revoked?.credits).toBeNull();
    setAccountQuotaFromParsed(ID, revoked!);
    await expect(resolve(cfg)).rejects.toBeInstanceOf(CodexPoolAccountCreditsOffError);
  });
  test("explicit opt-in with current spendable evidence still materializes the selected credential", async () => {
    const cfg = config(); cfg.creditCodexAccountIds = [ID]; quota();
    const ctx = await resolve(cfg);
    expect(ctx.kind).toBe("pool");
    expect(materializeCodexUpstreamAuth(new Headers(), ctx).get("authorization")).toBe("Bearer access-token-value-credit-policy");
  });
  test("a below-limit exact account remains usable", async () => {
    quota(99);
    expect((await resolve(config())).kind).toBe("pool");
  });
  test("a later full window is checked even when materialization options omit config", async () => {
    quota(99); const ctx = await resolve(config()); quota();
    expect(() => materializeCodexUpstreamAuth(new Headers(), ctx)).toThrow(CodexPoolAccountCreditsOffError);
  });
  test("provider overrides recheck the same live policy", async () => {
    const cfg = config(); cfg.creditCodexAccountIds = [ID]; quota();
    const ctx = await resolve(cfg); cfg.creditCodexAccountIds = [];
    expect(() => applyCodexAuthContextToProvider({ adapter: "openai-responses", baseUrl: "https://example.test", authMode: "forward" }, ctx, "pool"))
      .toThrow(CodexPoolAccountCreditsOffError);
  });
  test("a recovery probe does not grant credit-spending permission", async () => {
    quota(99); const ctx = await resolve(config());
    if (ctx.kind !== "pool") throw new Error("expected pool fixture");
    ctx.probeLeaseId = "fixture-probe"; quota();
    expect(() => assertCodexAuthContextNotCooled(ctx)).toThrow(CodexPoolAccountCreditsOffError);
  });
  test("an explicit current materialization policy takes precedence", async () => {
    const cfg = config(); cfg.creditCodexAccountIds = [ID]; quota();
    const ctx = await resolve(cfg);
    expect(() => materializeCodexUpstreamAuth(new Headers(), ctx, { config: { creditCodexAccountIds: [] } }))
      .toThrow(CodexPoolAccountCreditsOffError);
  });
  test("an elapsed full window does not hold the account indefinitely", async () => {
    quota(100, Date.now() - 1_000);
    expect((await resolve(config())).kind).toBe("pool");
  });
  test("a reset-less full short window holds until the observation goes stale", async () => {
    setAccountQuotaFromParsed(ID, { shortPercent: 100 });
    const observedAt = getAccountQuota(ID)?.shortObservedAt;
    expect(observedAt).toBeDefined();
    const error = await resolve(config()).catch(cause => cause);
    expect(error).toBeInstanceOf(CodexPoolAccountCreditsOffError);
    // The refusal must tell the client when the hold ends — the freshness horizon — instead
    // of reporting `now` and inviting an immediate retry against a still-blocked account.
    expect(error.resetAt).toBe(observedAt! + TERMINAL_SHORT_WINDOW_FRESHNESS_MS);
    const retryAfter = Number(cooldownErrorResponse(error).headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(1);
    expect(retryAfter).toBeLessThanOrEqual(Math.ceil(TERMINAL_SHORT_WINDOW_FRESHNESS_MS / 1_000));
  });
  test("a supplied short reset is the hold deadline", async () => {
    const resetAt = Date.now() + 120_000;
    setAccountQuotaFromParsed(ID, { shortPercent: 100, shortObservedAt: Date.now(), shortResetAt: resetAt });
    const error = await resolve(config()).catch(cause => cause);
    expect(error).toBeInstanceOf(CodexPoolAccountCreditsOffError);
    expect(error.resetAt).toBe(resetAt);
  });
  test("a pool context rebuilt by copy keeps the resolver's live credit policy", async () => {
    quota(99);
    const ctx = await resolve(config());
    if (ctx.kind !== "pool") throw new Error("expected pool fixture");
    // The 401-refresh replay rebuilds the context by spread; the rebind carries the WeakMap
    // entry so a hold landing during the refresh await is enforced on the copy too.
    const copy = rebindPoolCreditPolicy(ctx, { ...ctx, accessToken: "rotated-access" });
    quota();
    expect(() => applyCodexAuthContextToProvider({ adapter: "openai-responses", baseUrl: "https://example.test", authMode: "forward" }, copy, "pool"))
      .toThrow(CodexPoolAccountCreditsOffError);
    expect(() => materializeCodexUpstreamAuth(new Headers(), copy)).toThrow(CodexPoolAccountCreditsOffError);
  });
  test.each(["quota", "consent", "allowed"])("ordinary physical dispatch rechecks live policy after pacing: %s", async change => {
    const cfg = config(); cfg.creditCodexAccountIds = [ID]; quota(change === "quota" ? 99 : 100);
    const ctx = await resolve(cfg);
    const headers = materializeCodexUpstreamAuth(new Headers(), ctx);
    let sends = 0;
    const provider = { adapter: "openai-responses" as const, authMode: "forward" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex", fetch: Object.assign(async () => {
        sends++; return Response.json({});
      }, { preconnect() {} }) as typeof fetch };
    const executor = providerFetch(provider, undefined, { httpOnly: true,
      beforeDispatch: createCodexAuthDispatchGuard(ctx, cfg, "gpt-5.5") });
    let release!: () => void;
    executor.waitForPacing = () => new Promise<void>(resolve => { release = resolve; });
    const pending = fetchWithHeaderTimeout(`${provider.baseUrl}/responses`, { method: "POST", headers, body: "{}" },
      new AbortController().signal, 1000, false, executor);
    const observed = pending.catch(error => error);
    if (change === "quota") { cfg.creditCodexAccountIds = []; quota(); }
    else if (change === "consent") cfg.creditCodexAccountIds = [];
    release();
    if (change === "allowed") { expect((await observed).status).toBe(200); expect(sends).toBe(1); }
    else { expect(await observed).toBeInstanceOf(CodexPoolAccountCreditsOffError); expect(sends).toBe(0); }
  });
  test("a mid-acquisition credit hold releases the due cooldown probe lease", async () => {
    const cfg = config();
    quota(99);
    const recordedAt = Date.now() - CODEX_QUOTA_PROBE_INTERVAL_MS - 1_000;
    recordCodexUpstreamOutcome(cfg, ID, 429, {
      resetAt: Math.floor((recordedAt + 4 * 24 * 60 * 60_000) / 1_000),
      now: recordedAt,
      fixedAccount: true,
    });
    // The resolver stays synchronous until the credential await, so this lands between the
    // two stored-account credit checks exactly as a limit observed mid-flight would.
    const pending = resolveCodexAuthContext(new Headers(), cfg, "pool", { modelId: "gpt-5.5" });
    quota();
    await expect(pending).rejects.toBeInstanceOf(CodexPoolAccountCreditsOffError);
    // The catch must hand the probe lease back: an unreleased lease would keep
    // `probeLeaseId` set and block every subsequent probe regardless of the interval.
    expect(tryAcquireCodexQuotaProbeLease(ID, Date.now() + CODEX_QUOTA_PROBE_INTERVAL_MS)).toBeTruthy();
  });
  test("policy refusal retains actionable wording and is not a reauthentication failure", () => {
    const error = new CodexPoolAccountCreditsOffError(ID, Date.now() + 3_600_000);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(error)).toBe(false);
    expect(cooldownErrorMessage(error)).toBe(error.message);
    expect(error.message).not.toContain(ID);
    expect(error.message).not.toContain("clear-cooldown");
  });
});
