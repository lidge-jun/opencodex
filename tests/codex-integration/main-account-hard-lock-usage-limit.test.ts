/**
 * #7046: a main hard-lock refusal is a terminal usage limit, and a pool request's retry time is
 * clamped to the earliest known recovery of another stored pool account.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAccountCooldownError,
  CodexMainAccountCreditsOffError,
  CodexMainAccountHardLockError,
  MAIN_HARD_LOCK_MIN_POOL_RETRY_MS,
  cooldownErrorResponse,
  resolveCodexAuthContext,
} from "../../src/codex/auth-context";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import * as mainAccount from "../../src/codex/main-account";
import { captureMainQuotaWriter } from "../../src/codex/main-account-cache";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { setAccountHealth } from "../../src/codex/routing/health-store";
import { nextCodexPoolRecoveryAt } from "../../src/codex/routing/pool-recovery";
import { setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MAIN = mainAccount.MAIN_CODEX_ACCOUNT_ID;
const accountId = "hard-lock-usage-main-fixture";
const POOL_A = "usage-limit-pool-a";
const POOL_B = "usage-limit-pool-b";
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

function bearer(): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 86_400,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function config(poolIds: string[] = []): OcxConfig {
  for (const id of poolIds) {
    saveCodexAccountCredential(id, {
      accessToken: `fixture-${id}-access`, refreshToken: `fixture-${id}-refresh`,
      expiresAt: Date.now() + 86_400_000, chatgptAccountId: `fixture-${id}`,
    });
  }
  return {
    port: 10100,
    defaultProvider: "openai",
    codexMainAccountHardLock: true,
    autoSwitchThreshold: 0,
    activeCodexAccountId: MAIN,
    providers: { openai: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      codexAccountMode: "pool",
    } },
    codexAccounts: poolIds.map(id => ({ id, email: `${id}@example.test`, isMain: false })),
  };
}

function lockMain(): void {
  setAccountQuotaFromParsed(MAIN, { shortPercent: 99 }, undefined, captureMainQuotaWriter(accountId));
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-main-hard-lock-usage-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  resetMainCodexAccountIdentityTrackingForTests();
  clearAccountQuota();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  for (const id of [MAIN, POOL_A, POOL_B]) clearAccountNeedsReauth(id);
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
  for (const id of [MAIN, POOL_A, POOL_B]) clearAccountNeedsReauth(id);
  resetMainCodexAccountIdentityTrackingForTests();
  mainAccount.setMainAccountPlan(null);
  setIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json() as { error: Record<string, unknown> }).error;
}

describe("hard-lock refusal contract", () => {
  test("the reported incident: a weekly reset becomes a terminal usage limit with the same deadline", async () => {
    const now = 1_800_000_000_000;
    const response = cooldownErrorResponse(new CodexMainAccountHardLockError(now + 446_329_000), now);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("446329");
    const error = await body(response);
    expect(error).toMatchObject({ type: "usage_limit_reached", code: "usage_limit_reached",
      resets_at: Math.ceil((now + 446_329_000) / 1000) });
    expect(String(error.message)).toContain("main-account quota policy");
    expect(error).not.toHaveProperty("plan_type");
  });

  test("an unknown, past or non-finite reset carries neither Retry-After nor resets_at", async () => {
    const now = 1_800_000_000_000;
    for (const resetAt of [undefined, now - 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const response = cooldownErrorResponse(new CodexMainAccountHardLockError(resetAt), now);
      expect(response.status).toBe(429);
      expect(response.headers.has("retry-after")).toBe(false);
      const error = await body(response);
      expect(error.type).toBe("usage_limit_reached");
      expect(error).not.toHaveProperty("resets_at");
    }
  });

  test("an earlier pool recovery clamps both Retry-After and resets_at; a later one does not", async () => {
    const now = 1_800_000_000_000;
    const early = new CodexMainAccountHardLockError(now + 446_329_000);
    early.poolRecoveryAt = now + 3 * 3_600_000;
    const clamped = cooldownErrorResponse(early, now);
    expect(clamped.headers.get("retry-after")).toBe(String(3 * 3_600));
    expect((await body(clamped)).resets_at).toBe(Math.ceil((now + 3 * 3_600_000) / 1000));
    const late = new CodexMainAccountHardLockError(now + 60_000);
    late.poolRecoveryAt = now + 3_600_000;
    expect(cooldownErrorResponse(late, now).headers.get("retry-after")).toBe("60");
  });

  test("a pool hint is floored, ignored when past, and stands alone when main's reset is unknown", () => {
    const now = 1_800_000_000_000;
    const imminent = new CodexMainAccountHardLockError(now + 446_329_000);
    imminent.poolRecoveryAt = now + 2_000;
    expect(cooldownErrorResponse(imminent, now).headers.get("retry-after"))
      .toBe(String(MAIN_HARD_LOCK_MIN_POOL_RETRY_MS / 1000));
    const past = new CodexMainAccountHardLockError(now + 446_329_000);
    past.poolRecoveryAt = now - 1;
    expect(cooldownErrorResponse(past, now).headers.get("retry-after")).toBe("446329");
    const unknownMain = new CodexMainAccountHardLockError();
    unknownMain.poolRecoveryAt = now + 600_000;
    expect(cooldownErrorResponse(unknownMain, now).headers.get("retry-after")).toBe("600");
  });

  test("other cooldown classes keep the retryable rate-limit contract", async () => {
    const now = 1_800_000_000_000;
    const cooldown = cooldownErrorResponse(new CodexAccountCooldownError("pool-fixture", now + 30_000), now);
    expect(cooldown.headers.get("retry-after")).toBe("30");
    expect((await body(cooldown)).type).toBe("rate_limit_error");
    const credits = cooldownErrorResponse(new CodexMainAccountCreditsOffError(now + 30_000), now);
    expect((await body(credits)).type).toBe("rate_limit_error");
  });
});

describe("pool recovery estimate", () => {
  test("the earliest account whose every known hold ends; unknown, held-forever and hold-free accounts are skipped", () => {
    const now = Date.now();
    const cfg = config([POOL_A, POOL_B]);
    setAccountHealth(POOL_A, { consecutiveFailures: 0, cooldownUntil: now + 2 * 3_600_000, quotaAvoidUntil: now + 3 * 3_600_000 });
    setAccountHealth(POOL_B, { consecutiveFailures: 0, cooldownUntil: now + 5 * 3_600_000 });
    // A's latest hold (avoidance) decides its recovery; it still beats B.
    expect(nextCodexPoolRecoveryAt(cfg, now)).toBe(now + 3 * 3_600_000);
    expect(nextCodexPoolRecoveryAt(cfg, now, undefined, { deniedAccountIds: new Set([POOL_A]) })).toBe(now + 5 * 3_600_000);
    markAccountNeedsReauth(POOL_B);
    expect(nextCodexPoolRecoveryAt(cfg, now, undefined, { deniedAccountIds: new Set([POOL_A]) })).toBeUndefined();
    expect(nextCodexPoolRecoveryAt({ ...cfg, pausedCodexAccountIds: [POOL_A] }, now)).toBeUndefined();
    clearCodexUpstreamHealth();
    expect(nextCodexPoolRecoveryAt(cfg, now)).toBeUndefined();
  });

  test("every routing hold with a known end extends recovery; a gated roster restricts candidates", () => {
    const now = Date.now();
    const cfg = config([POOL_A, POOL_B]);
    // A transient soft avoid that outlives the quota cooldown still blocks selection until it ends.
    setAccountHealth(POOL_A, { consecutiveFailures: 1, cooldownUntil: now + 3_600_000, softAvoidUntil: now + 4 * 3_600_000 });
    setAccountHealth(POOL_B, { consecutiveFailures: 0, cooldownUntil: now + 5 * 3_600_000 });
    expect(nextCodexPoolRecoveryAt(cfg, now)).toBe(now + 4 * 3_600_000);
    expect(nextCodexPoolRecoveryAt(cfg, now, undefined, { eligibleAccountIds: new Set([POOL_B]) })).toBe(now + 5 * 3_600_000);
    expect(nextCodexPoolRecoveryAt(cfg, now, undefined, { eligibleAccountIds: new Set() })).toBeUndefined();
  });

  test("an account-gated model only takes a hint from accounts its roster admits", async () => {
    const cfg = config([POOL_A, POOL_B]);
    lockMain();
    const now = Date.now();
    setAccountHealth(POOL_A, { consecutiveFailures: 0, cooldownUntil: now + 5 * 3_600_000 });
    setAccountHealth(POOL_B, { consecutiveFailures: 0, cooldownUntil: now + 2 * 3_600_000 });
    const model = "gpt-daybreak-blue-latest";
    const error = await resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: model,
      primeCodexPoolQuotas: async () => {},
      resolveCodexModelEntitlements: async () => ({
        modelsByAccount: new Map([[MAIN, new Set([model])], [POOL_A, new Set([model])], [POOL_B, new Set<string>()]]),
        confirmedAccountIds: new Set([MAIN, POOL_A, POOL_B]),
        credentialIdentities: new Map(),
      }),
    }).catch(cause => cause);
    expect(error).toBeInstanceOf(CodexMainAccountHardLockError);
    // POOL_B recovers sooner but cannot serve the model.
    expect((error as CodexMainAccountHardLockError).poolRecoveryAt).toBe(now + 5 * 3_600_000);
  });

  test("an unpinned pool request that falls through to a locked main carries the sibling's recovery", async () => {
    const cfg = config([POOL_A]);
    lockMain();
    const now = Date.now();
    setAccountHealth(POOL_A, { consecutiveFailures: 0, cooldownUntil: now + 2 * 3_600_000 });
    const error = await resolveCodexAuthContext(new Headers(), cfg, "pool").catch(cause => cause);
    expect(error).toBeInstanceOf(CodexMainAccountHardLockError);
    expect((error as CodexMainAccountHardLockError).poolRecoveryAt).toBe(now + 2 * 3_600_000);
    const response = cooldownErrorResponse(error as CodexMainAccountHardLockError, now);
    expect(Number(response.headers.get("retry-after"))).toBe(2 * 3_600);
  });

  test("a request pinned to main keeps main's own reset", async () => {
    const cfg = config([POOL_A]);
    lockMain();
    setAccountHealth(POOL_A, { consecutiveFailures: 0, cooldownUntil: Date.now() + 2 * 3_600_000 });
    const error = await resolveCodexAuthContext(new Headers(), cfg, "pool", { accountId: MAIN }).catch(cause => cause);
    expect(error).toBeInstanceOf(CodexMainAccountHardLockError);
    expect((error as CodexMainAccountHardLockError).poolRecoveryAt).toBeUndefined();
  });
});
