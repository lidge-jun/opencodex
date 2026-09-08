import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAccountCooldownError,
  CodexMainAccountHardLockError,
  cooldownErrorMessage,
  cooldownErrorResponse,
  headersForCodexAuthContext,
  materializeCodexUpstreamAuthAsync,
  resolveCodexAuthContext,
  shouldMarkAccountNeedsReauthForCodexAuthFailure,
} from "../../src/codex/auth-context";
import { isCodexAccountUsable } from "../../src/codex/account-usability";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import * as mainAccount from "../../src/codex/main-account";
import * as authCollision from "../../src/codex/auth-collision";
import {
  captureMainQuotaWriter,
  matchesMainQuotaCredential,
  observeMainQuotaCredential,
  observeMainQuotaIdentity,
} from "../../src/codex/main-account-cache";
import { clearAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth } from "../../src/codex/routing";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar } from "../../src/providers/openai-sidecar";
import { mapCodexAuthContextErrorToResponse } from "../../src/server/responses/codex-auth-error";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { helperPath, repoRoot } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

const MAIN = mainAccount.MAIN_CODEX_ACCOUNT_ID;
const accountId = "hard-lock-main-fixture";
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let tokenExpiry: number;

function bearer(expired = false): string {
  const payload = Buffer.from(JSON.stringify({
    exp: tokenExpiry - (expired ? 86_460 : 0),
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function config(): OcxConfig {
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
    codexAccounts: [],
  };
}

function writeMain(token = bearer()): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    tokens: { access_token: token, refresh_token: "fixture-refresh", account_id: accountId },
  }));
  reconcileMainCodexAccountRuntimeState();
}

function quota(percent: number): void {
  const writer = captureMainQuotaWriter(accountId);
  if (!writer) throw new Error("fixture identity must be observed first");
  setAccountQuotaFromParsed(MAIN, { shortPercent: percent }, undefined, writer);
}

function caller(token = bearer(), effectiveAccountId = accountId): Headers {
  return new Headers({ authorization: `Bearer ${token}`, "chatgpt-account-id": effectiveAccountId });
}

function forbidPhysicalReads(): void {
  const forbidden = () => { throw new Error("caller-owned path read physical main"); };
  spyOn(authCollision, "readCodexTokens").mockImplementation(forbidden);
  spyOn(authCollision, "getMainChatgptAccountId").mockImplementation(forbidden);
  spyOn(mainAccount, "getMainAccountToken").mockImplementation(forbidden);
  spyOn(mainAccount, "getValidMainAccountToken").mockImplementation(forbidden);
  spyOn(mainAccount, "isMainAccountCredentialUsable").mockImplementation(forbidden);
}

function addAlternative(cfg: OcxConfig): void {
  cfg.codexAccounts = [{ id: "hard-lock-pool", email: "pool@example.test", isMain: false }];
  saveCodexAccountCredential("hard-lock-pool", {
    accessToken: "fixture-pool-access",
    refreshToken: "fixture-pool-refresh",
    expiresAt: Date.now() + 86_400_000,
    chatgptAccountId: "fixture-pool-account",
  });
}

beforeEach(() => {
  tokenExpiry = Math.floor(Date.now() / 1000) + 86_400;
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-main-hard-lock-auth-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  resetMainCodexAccountIdentityTrackingForTests();
  clearAccountQuota();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth(MAIN);
  clearAccountNeedsReauth("hard-lock-pool");
  mainAccount.setMainAccountPlan(null);
  writeMain();
});

afterEach(() => {
  mock.restore();
  clearAccountQuota();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth(MAIN);
  clearAccountNeedsReauth("hard-lock-pool");
  resetMainCodexAccountIdentityTrackingForTests();
  mainAccount.setMainAccountPlan(null);
  setIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

describe("main quota policy at native admission", () => {
  test.each(["owned-99", "owned-98", "foreign", "unknown", "recovery", "second-listener",
    "invalid-access-token", "invalid-account-id", "invalid-id-token", "mismatched-identity", "renewed-listener",
    "stage-retry", "manual-recovery", "stale-sweep", "retained-unknown-binding",
    "conflicting-token-identities", "owned-opaque-99"] as const)(
    "fresh startup restores durable main policy only after owned recovery (%s)", scenario => {
      const restoredId = scenario === "recovery" ? "hard-lock-recovered-main" : accountId;
      const restoredBearer = scenario === "owned-opaque-99" ? "opaque-owned-startup-bearer" : `header.${Buffer.from(JSON.stringify({ exp: tokenExpiry,
        ...(["renewed-listener", "manual-recovery", "stale-sweep"].includes(scenario) ? { startupTokenRevision: 1 } : {}),
        "https://api.openai.com/auth": { chatgpt_account_id: scenario === "conflicting-token-identities"
          ? "hard-lock-conflicting-access-account" : restoredId } })).toString("base64url")}.signature`;
      const quota = { weeklyPercent: scenario === "owned-98" ? 98 : 99, updatedAt: Date.now() - 7 * 60 * 60_000 };
      const identityKey = createHash("sha256").update("opencodex-main-quota-v1\0").update(restoredId).digest("hex");
      if (scenario.startsWith("invalid-") || scenario === "mismatched-identity") {
        writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
          access_token: scenario === "invalid-access-token" ? 17 : bearer(),
          account_id: scenario === "invalid-account-id" ? { invalid: true }
            : scenario === "mismatched-identity" ? "conflicting-physical-account" : accountId,
          ...(scenario === "invalid-id-token" ? { id_token: 17 } : {}),
        } }));
      }
      if (scenario === "conflicting-token-identities" || scenario === "owned-opaque-99") {
        writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
          access_token: restoredBearer, account_id: accountId,
          ...(scenario === "conflicting-token-identities" ? { id_token: bearer() } : {}),
        } }));
      }
      writeFileSync(join(home, "config.json"), JSON.stringify({
        ...config(), port: 0, hostname: "127.0.0.1", codexMainAccountHardLock: scenario !== "second-listener",
        providers: { openai: { ...config().providers.openai, codexAccountMode: "direct" } },
      }));
      writeFileSync(join(home, "config.toml"), 'model = "gpt-5.6-sol"\n');
      writeFileSync(join(home, "codex-quota-cache.json"), JSON.stringify({
        version: 1, quotas: { [MAIN]: quota }, mainPolicyQuota: { identityKey, quota },
      }));
      const fixturePath = join(home, "startup-fixture.json");
      writeFileSync(fixturePath, JSON.stringify({ scenario, accountId: restoredId, bearer: restoredBearer,
        originalAccountId: accountId, originalBearer: bearer() }));
      const child = Bun.spawnSync([process.execPath, helperPath("main-account-policy-startup-child.ts")], {
        cwd: repoRoot(), env: { ...process.env, OCX_POLICY_STARTUP_FIXTURE: fixturePath,
          HOME: home, USERPROFILE: home, TMP: home, TEMP: home, TMPDIR: home,
          XDG_RUNTIME_DIR: home, LOCALAPPDATA: join(home, "LocalAppData") },
        timeout: SPAWN_BUDGET_MS - INTERNAL_DEADLINE_MS, stdout: "pipe", stderr: "pipe",
      });
      expect({ exitCode: child.exitCode, signal: child.signalCode, stderr: child.stderr.toString() }).toMatchObject({ exitCode: 0 });
      const line = child.stdout.toString().split(/\r?\n/).find(value => value.startsWith("POLICY_STARTUP_RESULT="));
      expect(line).toBeDefined();
      const result = JSON.parse(line!.slice("POLICY_STARTUP_RESULT=".length));
      expect(result.before).toMatchObject({ matched: false, policy: null, tokenReads: 0 });
      expect(result.listeners[0].tokenReads).toBe(0);
      expect(result.unexpectedNetwork).toEqual([]);
      expect(result.policyReadsPinned).toBe(true);
      expect(result.beforePrimaryUpstreamCalls).toBe(scenario === "retained-unknown-binding" ? 3 : 0);
      const unowned = scenario === "foreign" || scenario === "unknown";
      const unverified = scenario.startsWith("invalid-") || scenario === "mismatched-identity"
        || scenario === "conflicting-token-identities";
      if (unowned) {
        expect(result.firstAdmission.admitted).toBe(true);
        expect(result.after.tokenReads).toBe(0);
      } else {
        expect(result.firstAdmission).toEqual({ admitted: false, error: "CodexMainProfileDrainingError" });
        expect(result.settled.status).toBe("ready");
      }
      if (unowned || unverified) {
        expect(result.after).toMatchObject({ matched: false, policy: null });
        expect(result.response.status).toBe(200);
        expect(result.primaryUpstreamCalls).toBe(1);
      } else {
        expect(result.after).toMatchObject({ matched: true, policy: quota });
        expect(result.response.status).toBe(scenario === "owned-98" ? 200 : 429);
        expect(result.primaryUpstreamCalls).toBe(scenario === "owned-98" ? 1 : 0);
        if (scenario !== "owned-98") expect(result.response.hardLockError).toBe(true);
      }
      if (scenario === "recovery") {
        expect(result.heldRecovery.observation).toMatchObject({ matched: false, policy: null, tokenReads: 0 });
        expect(result.heldRecovery.poolFallback).toEqual({ admitted: false, error: "CodexMainProfileDrainingError" });
        expect(result.heldRecovery.mainPin).toEqual({ admitted: false, error: "CodexMainProfileDrainingError" });
        expect(result.heldRecovery.storedAlternative).toMatchObject({ admitted: true, kind: "pool" });
        expect(result.heldRecovery.automaticAlternative).toMatchObject({ admitted: true, kind: "pool" });
        expect(result.originalResponse.status).toBe(200);
      }
      if (scenario === "second-listener") {
        expect(result.firstServerSettled).toMatchObject({ matched: false, policy: null, tokenReads: 0 });
      }
      if (scenario === "second-listener" || scenario === "renewed-listener") {
        expect(result.listeners).toHaveLength(2);
        expect(result.listeners[1].tokenReads).toBe(result.firstServerSettled.tokenReads);
      }
      if (scenario === "renewed-listener") {
        expect(result.firstServerSettled).toMatchObject({ matched: false, policy: quota });
        expect(result.originalResponse.status).toBe(200);
      }
      if (scenario === "stage-retry" || scenario === "manual-recovery") {
        expect(result.laterRecovery.blocked).toMatchObject({ matched: false, policy: null, tokenReads: 0,
          gate: { status: "blocked", reason: scenario === "stage-retry" ? "stage-cleanup-required" : "manual-recovery" } });
      }
      if (scenario === "stage-retry") expect(result.laterRecovery.sweepCalls).toBeGreaterThanOrEqual(2);
      if (scenario === "manual-recovery") {
        expect(result.laterRecovery).toMatchObject({ apiStatus: 200, duplicateCompleted: true, joined: true, recoveryCalls: 1 });
        expect(result.laterRecovery.pending).toMatchObject({ matched: false, tokenReads: 0,
          gate: { status: "blocked", reason: "recovery-pending" } });
        expect(result.originalResponse.status).toBe(200);
      }
      if (scenario === "stale-sweep") {
        expect(result.laterRecovery.pending.gate).toMatchObject({ status: "blocked", reason: "recovery-pending" });
        expect(result.laterRecovery.admission).toEqual({ admitted: false, error: "CodexMainProfileDrainingError" });
        expect(result.originalResponse.status).toBe(200);
      }
      if (scenario === "retained-unknown-binding") {
        expect(result.retainedUnknown.map((entry: { kind: string }) => entry.kind))
          .toEqual(["malformed", "conflicting", "conflicting-tokens"]);
        for (const entry of result.retainedUnknown) {
          expect(entry.observed).toMatchObject({ matched: true, policy: quota });
          expect(entry.main).toMatchObject({ status: 429, hardLockError: true });
          expect(entry.other.status).toBe(200);
        }
        expect(result.validReplacement).toMatchObject({ oldMatched: false, newMatched: true, policy: null,
          old: { status: 200, hardLockError: false } });
      }
    }, SPAWN_BUDGET_MS,
  );

  test("short-only 99 blocks exact main and main-only Pool without probe or reauth", async () => {
    quota(99);
    const cfg = config();
    const refresh = spyOn(mainAccount, "getValidMainAccountToken");
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", { accountId: MAIN }))
      .rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
      .rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    expect(refresh).not.toHaveBeenCalled();
    expect(getCodexUpstreamHealth(MAIN)).toBeNull();
    expect(isAccountNeedsReauth(MAIN)).toBe(false);
    expect(isCodexAccountUsable(cfg, MAIN, { nativeMainSelectionOnly: true })).toBe(false);
  });

  test("eligible added account continues when main is blocked", async () => {
    const cfg = config();
    addAlternative(cfg);
    quota(99);
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
      .resolves.toMatchObject({ kind: "pool", accountId: "hard-lock-pool" });
  });

  test("request-owned main pin detours to a stored alternative with no physical reads", async () => {
    const cfg = config();
    addAlternative(cfg);
    cfg.activeCodexAccountPinned = MAIN;
    observeMainQuotaCredential(bearer(), accountId);
    quota(99);
    forbidPhysicalReads();
    await expect(resolveCodexAuthContext(caller(), cfg, "pool", { requestScopedMainCredential: true }))
      .resolves.toMatchObject({ kind: "pool", accountId: "hard-lock-pool" });
  });

  test("Direct and exact caller-owned matching main fail without physical reads", async () => {
    observeMainQuotaCredential(bearer(), accountId);
    quota(99);
    forbidPhysicalReads();
    await expect(resolveCodexAuthContext(caller(), config(), "direct"))
      .rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    await expect(resolveCodexAuthContext(caller(), config(), "pool", {
      requestScopedMainCredential: true, accountId: MAIN,
    })).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    await expect(resolveCodexAuthContext(caller(), config(), "pool", {
      requestScopedMainCredential: true,
    })).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
  });

  test("unmatched, spoofed-claim, and conflicting-workspace callers do not inherit main policy", async () => {
    observeMainQuotaCredential(bearer(), accountId);
    quota(99);
    forbidPhysicalReads();
    for (const headers of [caller("opaque-other"), caller(`${bearer()}-different`), caller(bearer(), "other-workspace")]) {
      const ctx = await resolveCodexAuthContext(headers, config(), "direct");
      expect(headersForCodexAuthContext(headers, ctx, config()).get("authorization"))
        .toBe(headers.get("authorization"));
    }
    expect(getMainPolicyQuota()?.shortPercent).toBe(99);
  });

  test("selection writer survives to headers; live quota and toggle are checked at materialization", async () => {
    const cfg = config();
    quota(98.99);
    const ctx = await resolveCodexAuthContext(new Headers(), cfg, "pool", { accountId: MAIN });
    expect(ctx.kind).toBe("main-pool");
    if (ctx.kind !== "main-pool") throw new Error("expected stored main context");
    expect(ctx.mainQuotaWriter).toEqual(captureMainQuotaWriter(accountId));
    expect(matchesMainQuotaCredential(ctx.accessToken, ctx.chatgptAccountId)).toBe(true);
    cfg.codexMainAccountHardLock = false;
    quota(99);
    expect(headersForCodexAuthContext(new Headers(), ctx, cfg).get("authorization")).toBe(`Bearer ${bearer()}`);
    cfg.codexMainAccountHardLock = true;
    expect(() => headersForCodexAuthContext(new Headers(), ctx, cfg)).toThrow(CodexMainAccountHardLockError);
    quota(98.99);
    expect(() => headersForCodexAuthContext(new Headers(), ctx, cfg)).not.toThrow();
  });

  test("quota changing while selected main refresh awaits rejects without quarantining it", async () => {
    quota(98.99);
    await expect(resolveCodexAuthContext(new Headers(), config(), "pool", {
      accountId: MAIN,
      getValidMainAccountToken: async () => {
        await Promise.resolve();
        quota(99);
        return { accessToken: bearer(), chatgptAccountId: accountId };
      },
    })).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    expect(isAccountNeedsReauth(MAIN)).toBe(false);
    expect(getCodexUpstreamHealth(MAIN)).toBeNull();
  });

  test("actual Direct substitution rechecks after awaited native refresh", async () => {
    writeMain(bearer(true));
    quota(98.99);
    const cfg = config();
    cfg.codexMainAccountHardLock = false;
    await expect(materializeCodexUpstreamAuthAsync(caller("proxy-admission"), { kind: "main", accountId: null }, {
      config: cfg,
      substituteMainCredential: true,
      nativeMainRefreshDependencies: { refreshToken: async () => {
        await Promise.resolve();
        quota(99);
        cfg.codexMainAccountHardLock = true;
        return { access: bearer(), refresh: "rotated-fixture", expires: Date.now() + 86_400_000, accountId };
      } },
    })).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    expect(isAccountNeedsReauth(MAIN)).toBe(false);
  });

  test("Direct substitution resolver refuses blocked main with an actionable policy error", async () => {
    quota(99);
    await expect(resolveCodexAuthContext(caller("proxy-admission"), config(), "direct", {
      substituteMainCredentialForDirect: true,
      beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} }),
    })).rejects.toBeInstanceOf(CodexMainAccountHardLockError);
  });

  test("Direct sidecar uses the same matched-main policy", async () => {
    const cfg = config();
    cfg.providers.openai!.codexAccountMode = "direct";
    observeMainQuotaCredential(bearer(), accountId);
    quota(99);
    forbidPhysicalReads();
    await expect(resolveFirstUsableOpenAiSidecar(listOpenAiForwardSidecarCandidates(cfg), caller(), cfg))
      .rejects.toBeInstanceOf(CodexMainAccountHardLockError);
  });

  test("Responses applies matched-main policy only to the selected Codex-forward transport", async () => {
    const cfg = config();
    cfg.providers.openai!.codexAccountMode = "direct";
    cfg.providers["fixture-native"] = {
      adapter: "openai-responses", authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    cfg.providers.independent = {
      adapter: "openai-responses", authMode: "key",
      baseUrl: "https://independent.example.test/v1", apiKey: "independent-fixture-key",
    };
    observeMainQuotaCredential(bearer(), accountId);
    quota(99);
    const sends: Array<{ url: string; authorization: string | null }> = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (
      input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1],
    ) => {
      const request = input instanceof Request ? input : new Request(input, init);
      sends.push({ url: request.url, authorization: request.headers.get("authorization") });
      return Response.json({
        id: "resp_policy_transport", object: "response", status: "completed", created_at: 1,
        model: "fixture-model", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      });
    }, { preconnect() {} }));
    const post = (model: string) => handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { ...Object.fromEntries(caller()), "content-type": "application/json" },
      body: JSON.stringify({ model, input: "ping", stream: false }),
    }), cfg, { model: "", provider: "" });

    for (const model of ["gpt-5.6-sol", "fixture-native/gpt-5.6-sol"]) {
      const blocked = await post(model);
      expect(blocked.status).toBe(429);
      expect(await blocked.text()).toContain("codexMainAccountHardLock");
    }
    expect(sends).toEqual([]);
    const keyed = await post("independent/fixture-model");
    expect(keyed.status).toBe(200);
    expect(await keyed.json()).toMatchObject({ id: "resp_policy_transport", status: "completed" });
    expect(sends).toEqual([{
      url: "https://independent.example.test/v1/responses",
      authorization: "Bearer independent-fixture-key",
    }]);
    expect(getMainPolicyQuota()?.shortPercent).toBe(99);
  });

  test("Compact keeps independently keyed OpenAI traffic outside matched-main policy", async () => {
    const cfg = config();
    cfg.providers.openai!.codexAccountMode = "direct";
    cfg.providers["openai-apikey"] = {
      adapter: "openai-responses", authMode: "key",
      baseUrl: "https://api.openai.com/v1", apiKey: "compact-fixture-key",
    };
    observeMainQuotaCredential(bearer(), accountId);
    quota(99);
    const sends: Array<{ url: string; authorization: string | null }> = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (
      input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1],
    ) => {
      const request = input instanceof Request ? input : new Request(input, init);
      sends.push({ url: request.url, authorization: request.headers.get("authorization") });
      return Response.json({ id: "cmp_policy_transport", object: "response.compaction", output: [] });
    }, { preconnect() {} }));
    const post = (model: string) => handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { ...Object.fromEntries(caller()), "content-type": "application/json" },
      body: JSON.stringify({ model, input: [{ role: "user", content: "ping" }] }),
    }), cfg, { model: "", provider: "" });

    const blocked = await post("gpt-5.6-sol");
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("codexMainAccountHardLock");
    expect(sends).toEqual([]);
    const keyed = await post("openai-apikey/gpt-5.6-sol");
    expect(keyed.status).toBe(200);
    expect(await keyed.json()).toMatchObject({ id: "cmp_policy_transport" });
    expect(sends).toEqual([{
      url: "https://api.openai.com/v1/responses/compact",
      authorization: "Bearer compact-fixture-key",
    }]);
    expect(getMainPolicyQuota()?.shortPercent).toBe(99);
  });

  test("stale writer is retained for rejection rather than converted into an untrusted write", async () => {
    quota(98.99);
    const ctx = await resolveCodexAuthContext(new Headers(), config(), "pool", { accountId: MAIN });
    if (ctx.kind !== "main-pool") throw new Error("expected stored main context");
    const writer = ctx.mainQuotaWriter;
    observeMainQuotaIdentity("replacement-account");
    headersForCodexAuthContext(new Headers(), ctx, config());
    expect(ctx.mainQuotaWriter).toEqual(writer);
  });

  test("canonical cooldown mapping preserves policy instructions without a fake reset deadline", async () => {
    const error = new CodexMainAccountHardLockError();
    expect(error).toBeInstanceOf(CodexAccountCooldownError);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(error)).toBe(false);
    expect(cooldownErrorMessage(error)).toContain("codexMainAccountHardLock");
    expect(cooldownErrorMessage(error)).not.toContain("clear-cooldown");
    const response = mapCodexAuthContextErrorToResponse(error, { now: Date.now() });
    expect(response?.status).toBe(429);
    expect(response?.headers.has("retry-after")).toBe(false);
    expect(await response?.text()).not.toContain(accountId);
    const now = Date.now();
    expect(cooldownErrorResponse(new CodexMainAccountHardLockError(now + 60_000), now).headers.get("retry-after"))
      .toBe("60");
  });
});
