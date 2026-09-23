import { registerStoredDirectIdentityTests } from "../helpers/stored-direct-identity";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodexAuthContextToProvider,
  assertCodexAuthContextNotCooled,
  CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexMainProfileDrainingError,
  CodexModelAvailabilityError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  codexMainProfileDrainingResponse,
  __resetNativeMainFenceReasonLog,
  cooldownErrorMessage,
  cooldownErrorResponse,
  headersForCodexAuthContext,
  materializeCodexUpstreamAuth,
  CodexMainSubstitutionUnavailableError,
  isCodexAuthContextUsable,
  codexPoolAffinityKey,
  resolveCodexAuthContext,
  requestOwnedMainPinState,
  releaseCodexAuthContextProbeLease,
  shouldMarkAccountNeedsReauthForCodexAuthFailure,
  stripCodexRuntimeProviderFields,
} from "../../src/codex/auth-context";
import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  CodexCredentialRefreshBusyError,
  CodexCredentialRefreshStaleError,
  getCodexAccountCredential,
  getValidCodexToken,
  readCodexAccountRecord,
  removeCodexAccountCredential,
  saveCodexAccountCredential,
} from "../../src/codex/account-store";
import { ConfigMutationLockError, getConfigPath } from "../../src/config";
import {
  getMainAccountPlan,
  MAIN_CODEX_ACCOUNT_ID,
  setMainAccountPlan,
} from "../../src/codex/main-account";
import {
  clearMainAccountInfoCache,
  observeMainQuotaCredential,
  observeMainQuotaIdentity,
} from "../../src/codex/main-account-cache";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  handleCodexAuthAPI,
  isAccountNeedsReauth,
  markAccountNeedsReauth,
  setAccountQuotaFromParsed,
} from "../../src/codex/auth-api";
import { __resetGuardianState, guardianSweep } from "../../src/oauth/token-guardian";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexQuotaHealthSnapshot,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
} from "../../src/codex/routing";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import {
  blockNativeMainStartupForUnownedServiceHome,
  completeNativeMainRecovery,
  initializeNativeMainStartupGate,
} from "../../src/codex/native-profile-startup";
import type { NativeProfileManager } from "../../src/codex/native-profile-manager";
import {
  acquireNativeMainProfileDrain,
  codexAccountSelectionForTurn,
  tryAdmitTurn,
} from "../../src/server/lifecycle";
import type { CodexModelEntitlementSnapshot } from "../../src/codex/model-entitlements";
import { recordContextSessionOwner, clearContextSessionOwnersForTests } from "../../src/codex/context-owner";
import { handleContextHistory } from "../../src/server/context-history";
import { resetContextRelayActivationForTests } from "../../src/codex/context-compat";
import { hasForwardableCodexBearer } from "../../src/server/auth-cors";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  // This suite validates refresh admission and auth-context outcomes. Real icacls
  // processes are covered elsewhere and can retain temp-dir handles long enough
  // to obscure those assertions under Windows isolated-test load.
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  testDir = mkdtempSync(join(tmpdir(), "ocx-auth-ctx-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  // Isolate the main-account credential source: testDir has no auth.json, so the main
  // account is deterministically absent (these cases test pool-only fail-closed behavior).
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = testDir;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  setMainAccountPlan(null);
  __resetGuardianState();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
});

afterEach(() => {
  resetContextRelayActivationForTests();
  setIcaclsRunnerForTests(null);
  removeTreeWithRetry(testDir);
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  setMainAccountPlan(null);
  __resetGuardianState();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    activeCodexAccountId: "pool-a",
    providers: {
      routed: { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" },
      chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/backend-api/codex", authMode: "forward" },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
    ],
  };
}

describe("Codex account thresholds preserve auth fences", () => {
  test.each([99, 100])("a zero account threshold preserves entitlement and exhaustion policy at %s usage", async usage => {
    const cfg = config();
    cfg.autoSwitchThreshold = 50;
    cfg.codexAccountAutoSwitchThresholds = { "pool-a": 0 };
    cfg.activeCodexAccountPinned = "pool-a";
    cfg.codexAccounts?.push({ id: "pool-b", email: "b@example.test", isMain: false });
    for (const id of ["pool-a", "pool-b"]) {
      saveCodexAccountCredential(id, {
        accessToken: `${id}-token`,
        refreshToken: `${id}-refresh`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: `${id}-account`,
      });
    }
    setAccountQuotaFromParsed("pool-a", { weeklyPercent: usage });
    setAccountQuotaFromParsed("pool-b", { weeklyPercent: 1 });
    resetCodexRoutingForManualSelection("pool-a");
    const headers = new Headers({ "x-codex-parent-thread-id": "zero-threshold-auth-detour" });
    const ordinaryOptions = { modelId: "gpt-5.5", primeCodexPoolQuotas: async () => {} };
    await expect(resolveCodexAuthContext(headers, cfg, "pool", ordinaryOptions))
      .resolves.toMatchObject({ kind: "pool", accountId: "pool-a", accessToken: "pool-a-token" });

    const entitlementSnapshot: CodexModelEntitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-5.5"])],
        ["pool-b", new Set(["gpt-daybreak-blue-latest"])],
      ]),
      confirmedAccountIds: new Set(["pool-a", "pool-b"]),
      credentialIdentities: new Map(),
    };
    const gatedOptions = {
      modelId: "gpt-daybreak-blue-latest",
      resolveCodexModelEntitlements: async () => entitlementSnapshot,
      primeCodexPoolQuotas: async () => {},
    };
    await expect(resolveCodexAuthContext(headers, cfg, "pool", {
      ...gatedOptions,
      accountId: "pool-a",
    })).rejects.toThrow("Selected Codex account does not support this model");
    await expect(resolveCodexAuthContext(headers, cfg, "pool", gatedOptions))
      .resolves.toMatchObject({ kind: "pool", accountId: "pool-b", accessToken: "pool-b-token" });
    const expectedShared = usage < 100 ? "pool-a" : "pool-b";
    expect(cfg.activeCodexAccountId).toBe(expectedShared);
    expect(cfg.activeCodexAccountPinned).toBe(usage < 100 ? "pool-a" : undefined);
    await expect(resolveCodexAuthContext(headers, cfg, "pool", ordinaryOptions))
      .resolves.toMatchObject({ kind: "pool", accountId: expectedShared });
  });

  test("a zero account threshold rejects a gated model when no stored account is entitled", async () => {
    const cfg = config();
    cfg.codexAccounts = cfg.codexAccounts?.filter(account => !account.isMain);
    cfg.autoSwitchThreshold = 50;
    cfg.codexAccountAutoSwitchThresholds = { "pool-a": 0 };
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-token",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool-account",
    });
    setAccountQuotaFromParsed("pool-a", { weeklyPercent: 100 });
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: "gpt-daybreak-blue-latest",
      resolveCodexModelEntitlements: async () => ({
        modelsByAccount: new Map([["pool-a", new Set(["gpt-5.5"])]]),
        confirmedAccountIds: new Set(["pool-a"]),
        credentialIdentities: new Map(),
      }),
    })).rejects.toThrow("No eligible Codex account supports this model");
  });

  async function resolveRequestOwnedMainPinCase(options: {
    mainWeeklyPercent: number;
    poolWeeklyPercent: number;
    callerEntitled: boolean;
    mainThresholdOverride?: number;
    poolEntitled?: boolean;
    mainRetryAfter?: string;
    poolUsable?: boolean;
    duringCallerEntitlement?: (cfg: OcxConfig) => Promise<void>;
    mode?: "pool" | "direct";
  }): Promise<{
    cfg: OcxConfig;
    context: Awaited<ReturnType<typeof resolveCodexAuthContext>>;
    directEntitlementChecks: number;
  }> {
    const cfg = config();
    cfg.accountPoolStrategy = "quota";
    cfg.autoSwitchThreshold = 90;
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    if (options.poolUsable === false) cfg.pausedCodexAccountIds = ["pool-a"];
    if (options.mainThresholdOverride !== undefined) {
      cfg.codexAccountAutoSwitchThresholds = {
        [MAIN_CODEX_ACCOUNT_ID]: options.mainThresholdOverride,
      };
    }
    cfg.codexAccountPriorities = {
      [MAIN_CODEX_ACCOUNT_ID]: 0,
      "pool-a": 0,
    };
    resetCodexRoutingForManualSelection(MAIN_CODEX_ACCOUNT_ID);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-token",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool-account",
    });
    setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, { weeklyPercent: options.mainWeeklyPercent });
    setAccountQuotaFromParsed("pool-a", { weeklyPercent: options.poolWeeklyPercent });
    if (options.mainRetryAfter !== undefined) {
      recordCodexUpstreamOutcome(cfg, MAIN_CODEX_ACCOUNT_ID, 429, {
        retryAfter: options.mainRetryAfter,
        fixedAccount: true,
        now: Date.now(),
      });
    }
    let directEntitlementChecks = 0;
    const context = await resolveCodexAuthContext(new Headers({
      authorization: "Bearer caller-keyring-token",
      "chatgpt-account-id": "caller-keyring-account",
    }), cfg, options.mode ?? "pool", {
      requestScopedMainCredential: true,
      // Uses the one model still account-gated. These #3157 cases are about how a caller
      // entitlement MISS interacts with the main pin, so they need a model whose entitlement is
      // actually consulted; the flagships stopped being gated on 2026-09-04 and now skip the
      // check entirely, which would leave directEntitlementChecks at 0 and prove nothing.
      modelId: "gpt-daybreak-blue-latest",
      isDirectCallerEntitledToCodexModel: async () => {
        directEntitlementChecks += 1;
        await options.duringCallerEntitlement?.(cfg);
        return options.callerEntitled;
      },
      resolveCodexModelEntitlements: async () => ({
        modelsByAccount: new Map([["pool-a", new Set(
          options.poolEntitled === false ? [] : ["gpt-daybreak-blue-latest"],
        )]]),
        clientVersionByAccount: new Map([["pool-a", "0.150.1"]]),
        confirmedAccountIds: new Set(["pool-a"]),
        credentialIdentities: new Map([["pool-a", "pool:1:pool-account"]]),
      }),
    });
    return { cfg, context, directEntitlementChecks };
  }

  test("a healthy manual main pin keeps the validated caller bearer ahead of an exhausted pool account (#3157)", async () => {
    const { cfg, context, directEntitlementChecks } = await resolveRequestOwnedMainPinCase({
      mainWeeklyPercent: 16,
      poolWeeklyPercent: 100,
      callerEntitled: true,
    });
    expect(context).toMatchObject({ kind: "main", accountId: null });
    expect(directEntitlementChecks).toBe(1);
    expect(cfg.activeCodexAccountId).toBe(MAIN_CODEX_ACCOUNT_ID);
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("a zero main-account threshold override preserves a request-owned main pin at full usage", async () => {
    const { cfg, context, directEntitlementChecks } = await resolveRequestOwnedMainPinCase({
      mainWeeklyPercent: 100,
      poolWeeklyPercent: 16,
      callerEntitled: true,
      mainThresholdOverride: 0,
    });
    expect(context).toMatchObject({ kind: "main", accountId: null });
    expect(directEntitlementChecks).toBe(1);
    expect(cfg.activeCodexAccountId).toBe(MAIN_CODEX_ACCOUNT_ID);
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("a zero main-account threshold does not let a request-owned main pin bypass Retry-After", async () => {
    // Model a previously observed physical-main identity matching this caller.
    // An unrelated caller must not inherit stored main's cooldown.
    observeMainQuotaIdentity("caller-keyring-account");
    observeMainQuotaCredential("caller-keyring-token", "caller-keyring-account");
    try {
      const { cfg, context } = await resolveRequestOwnedMainPinCase({
        mainWeeklyPercent: 100,
        poolWeeklyPercent: 16,
        callerEntitled: true,
        mainThresholdOverride: 0,
        mainRetryAfter: "600",
      });
      const cooldown = getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, "shared");
      expect(cooldown).toMatchObject({ cooldownSource: "retry-after" });
      expect(cooldown!.cooldownUntil).toBeGreaterThan(Date.now());
      expect(context).toMatchObject({ kind: "pool", accountId: "pool-a", accessToken: "pool-token" });
      // Request preview shares the final-auth predicate and must honor the same cooldown.
      cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
      cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
      expect(requestOwnedMainPinState(new Headers({
        authorization: "Bearer caller-keyring-token",
        "chatgpt-account-id": "caller-keyring-account",
      }), cfg, cfg, true, undefined, "shared")).toEqual({ candidate: true, preserve: false });
    } finally {
      clearMainAccountInfoCache();
    }
  });

  test.each(["caller-keyring-account", "other-main-account"])(
    "a zero main-account threshold does not impose main cooldown on an unrelated caller credential in workspace %s",
    async (observedAccountId) => {
      observeMainQuotaIdentity(observedAccountId);
      observeMainQuotaCredential("other-main-token", observedAccountId);
      try {
        const { cfg, context } = await resolveRequestOwnedMainPinCase({
          mainWeeklyPercent: 100,
          poolWeeklyPercent: 16,
          callerEntitled: true,
          mainThresholdOverride: 0,
          mainRetryAfter: "600",
        });
        expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, "shared"))
          .toMatchObject({ cooldownSource: "retry-after" });
        expect(context).toMatchObject({ kind: "main", accountId: null });
        const forwarded = headersForCodexAuthContext(new Headers({
          authorization: "Bearer caller-keyring-token",
          "chatgpt-account-id": "caller-keyring-account",
        }), context);
        expect(forwarded.get("authorization")).toBe("Bearer caller-keyring-token");
        expect(forwarded.get("chatgpt-account-id")).toBe("caller-keyring-account");
        expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
      } finally {
        clearMainAccountInfoCache();
      }
    },
  );

  test.each(["unentitled", "paused"] as const)(
    "a zero main-account threshold rejects cooled matching caller when Pool fallback is %s",
    async (unavailableReason) => {
      observeMainQuotaIdentity("caller-keyring-account");
      observeMainQuotaCredential("caller-keyring-token", "caller-keyring-account");
      try {
        await expect(resolveRequestOwnedMainPinCase({
          mainWeeklyPercent: 100,
          poolWeeklyPercent: 16,
          callerEntitled: true,
          mainThresholdOverride: 0,
          mainRetryAfter: "600",
          poolEntitled: unavailableReason !== "unentitled",
          poolUsable: unavailableReason !== "paused",
        })).rejects.toBeInstanceOf(CodexAccountCooldownError);
        expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, "shared"))
          .toMatchObject({ cooldownSource: "retry-after" });
      } finally {
        clearMainAccountInfoCache();
      }
    },
  );

  test.each([true, false])(
    "a zero main-account threshold rechecks cooldown after caller entitlement resolves with Pool entitled %s",
    async (poolEntitled) => {
      observeMainQuotaIdentity("caller-keyring-account");
      observeMainQuotaCredential("caller-keyring-token", "caller-keyring-account");
      let entered!: (cfg: OcxConfig) => void;
      const entitlementStarted = new Promise<OcxConfig>(resolve => { entered = resolve; });
      let release!: () => void;
      const entitlementGate = new Promise<void>(resolve => { release = resolve; });
      const pending = resolveRequestOwnedMainPinCase({
        mainWeeklyPercent: 100,
        poolWeeklyPercent: 16,
        callerEntitled: true,
        mainThresholdOverride: 0,
        poolEntitled,
        duringCallerEntitlement: async cfg => {
          entered(cfg);
          await entitlementGate;
        },
      });
      // Attach rejection handling before releasing the asynchronous dependency.
      const outcome = pending.then(
        result => ({ status: "resolved" as const, result }),
        error => ({ status: "rejected" as const, error }),
      );
      try {
        const cfg = await entitlementStarted;
        expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, "shared")).toBeNull();
        const now = Date.now();
        recordCodexUpstreamOutcome(cfg, MAIN_CODEX_ACCOUNT_ID, 429, {
          retryAfter: "600", fixedAccount: true, now,
        });
        release();
        const settled = await outcome;
        if (poolEntitled) {
          expect(settled.status).toBe("resolved");
          if (settled.status === "resolved") {
            expect(settled.result.context).toMatchObject({ kind: "pool", accountId: "pool-a" });
          }
        } else {
          expect(settled.status).toBe("rejected");
          if (settled.status === "rejected") expect(settled.error).toBeInstanceOf(CodexAccountCooldownError);
        }
        expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, "shared")).toMatchObject({
          cooldownSource: "retry-after", cooldownUntil: now + 600_000,
        });
      } finally {
        release();
        await outcome;
        clearMainAccountInfoCache();
      }
    },
  );

  test.each([
    ["reserve", "gpt-reserve", "shared", "main", null],
    ["shared", "gpt-5.6-sol", "reserve", "pool", "pool-a"],
  ] as const)(
    "a zero main-account threshold respects %s cooldown when resolving shared caller auth",
    async (cooledScope, cooledModel, healthyScope, expectedKind, expectedAccountId) => {
      observeMainQuotaIdentity("caller-keyring-account");
      observeMainQuotaCredential("caller-keyring-token", "caller-keyring-account");
      try {
        const { cfg } = await resolveRequestOwnedMainPinCase({
          mainWeeklyPercent: 100,
          poolWeeklyPercent: 16,
          callerEntitled: true,
          mainThresholdOverride: 0,
        });
        const now = Date.now();
        recordCodexUpstreamOutcome(cfg, MAIN_CODEX_ACCOUNT_ID, 429, {
          now,
          resetAt: Math.floor((now + 600_000) / 1_000),
          modelId: cooledModel,
          fixedAccount: true,
        });
        const cooldown = getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, cooledScope);
        expect(cooldown).toMatchObject({ cooldownSource: "reset-derived", quotaScope: cooledScope });
        expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, healthyScope)).toBeNull();
        const headers = new Headers({
          authorization: "Bearer caller-keyring-token",
          "chatgpt-account-id": "caller-keyring-account",
        });
        // Reserve evidence is state-only: shared requests must not inherit its cooldown,
        // and this test must not turn Reserve into an ordinary Pool-selectable model.
        await expect(resolveCodexAuthContext(headers, cfg, "pool", {
          requestScopedMainCredential: true, modelId: "gpt-5.6-sol",
        })).resolves.toMatchObject({ kind: expectedKind, accountId: expectedAccountId });
        expect(cfg.activeCodexAccountPinned).toBe(expectedKind === "main" ? MAIN_CODEX_ACCOUNT_ID : undefined);
        expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, cooledScope)).toEqual(cooldown);
        expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, healthyScope)).toBeNull();
      } finally {
        clearMainAccountInfoCache();
      }
    },
  );

  test("a zero main-account threshold leaves explicit Direct caller auth unchanged during matching main cooldown", async () => {
    observeMainQuotaIdentity("caller-keyring-account");
    observeMainQuotaCredential("caller-keyring-token", "caller-keyring-account");
    try {
      const { cfg, context, directEntitlementChecks } = await resolveRequestOwnedMainPinCase({
        mainWeeklyPercent: 100,
        poolWeeklyPercent: 16,
        callerEntitled: true,
        mainThresholdOverride: 0,
        mainRetryAfter: "600",
        mode: "direct",
      });
      expect(context).toMatchObject({ kind: "main", accountId: null });
      expect(directEntitlementChecks).toBe(1);
      const forwarded = headersForCodexAuthContext(new Headers({
        authorization: "Bearer caller-keyring-token",
        "chatgpt-account-id": "caller-keyring-account",
      }), context);
      expect(forwarded.get("authorization")).toBe("Bearer caller-keyring-token");
      expect(forwarded.get("chatgpt-account-id")).toBe("caller-keyring-account");
      expect(cfg.activeCodexAccountId).toBe(MAIN_CODEX_ACCOUNT_ID);
      expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
      expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, "shared"))
        .toMatchObject({ cooldownSource: "retry-after" });
    } finally {
      clearMainAccountInfoCache();
    }
  });

  test("an exhausted request-owned main pin still yields to the healthy Pool account (#3157)", async () => {
    const { cfg, context, directEntitlementChecks } = await resolveRequestOwnedMainPinCase({
      mainWeeklyPercent: 100,
      poolWeeklyPercent: 16,
      callerEntitled: true,
    });
    expect(context).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(directEntitlementChecks).toBe(0);
    expect(cfg.activeCodexAccountId).toBe("pool-a");
    expect(cfg.activeCodexAccountPinned).toBeUndefined();
  });

  test.each([99, 100])("a zero main-account threshold respects model-detour exhaustion policy at %s usage", async usage => {
    const { cfg, context, directEntitlementChecks } = await resolveRequestOwnedMainPinCase({
      mainWeeklyPercent: usage,
      poolWeeklyPercent: 16,
      callerEntitled: false,
      mainThresholdOverride: 0,
    });
    expect(context).toMatchObject({ kind: "pool", accountId: "pool-a", accessToken: "pool-token" });
    expect(directEntitlementChecks).toBe(1);
    expect(cfg.activeCodexAccountId).toBe(usage < 100 ? MAIN_CODEX_ACCOUNT_ID : "pool-a");
    expect(cfg.activeCodexAccountPinned).toBe(usage < 100 ? MAIN_CODEX_ACCOUNT_ID : undefined);
  });

  test("a zero main-account threshold rejects an unentitled caller when no Pool detour supports the model", async () => {
    await expect(resolveRequestOwnedMainPinCase({
      mainWeeklyPercent: 100,
      poolWeeklyPercent: 16,
      callerEntitled: false,
      poolEntitled: false,
      mainThresholdOverride: 0,
    })).rejects.toThrow(CodexPoolAuthenticationError);
  });

  test("a caller entitlement miss uses a Pool model detour without clearing the healthy main pin (#3157)", async () => {
    const { cfg, context, directEntitlementChecks } = await resolveRequestOwnedMainPinCase({
      mainWeeklyPercent: 16,
      poolWeeklyPercent: 20,
      callerEntitled: false,
    });
    expect(context).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(directEntitlementChecks).toBe(1);
    expect(cfg.activeCodexAccountId).toBe(MAIN_CODEX_ACCOUNT_ID);
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test.each([undefined, "pool-a"])(
    "a zero account threshold still enforces Retry-After with account selector %s",
    async (accountId) => {
      const cfg = config();
      cfg.autoSwitchThreshold = 50;
      cfg.codexAccountAutoSwitchThresholds = { "pool-a": 0 };
      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-token",
        refreshToken: "pool-refresh",
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: "pool-account",
      });
      setAccountQuotaFromParsed("pool-a", { weeklyPercent: 100 });
      const headers = new Headers({ authorization: "Bearer inbound-main-token" });
      const options = { accountId, modelId: "gpt-5.5", primeCodexPoolQuotas: async () => {} };
      const context = await resolveCodexAuthContext(headers, cfg, "pool", options);
      expect(context).toMatchObject({ kind: "pool", accountId: "pool-a", accessToken: "pool-token" });

      const now = Date.now();
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        retryAfter: "600",
        fixedAccount: true,
        now,
      });
      await expect(resolveCodexAuthContext(headers, cfg, "pool", options))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);
      expect(() => assertCodexAuthContextNotCooled(context)).toThrow(CodexAccountCooldownError);
      expect(getCodexQuotaHealthSnapshot("pool-a", "shared")).toMatchObject({
        cooldownUntil: now + 600_000,
        cooldownSource: "retry-after",
      });
    },
  );

});
