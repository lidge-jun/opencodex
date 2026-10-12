import { registerWarmupRateLimitCases } from "../helpers/codex-warmup-rate-limit";
import { registerResetCreditConsumeValidationTests } from "../helpers/reset-credit-consume-validation";
import * as usageHistoryModule from "../../src/usage/log";
import { getAccountQuotaHistory } from "../../src/codex/quota";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireNativeMainProfileDrain,
  getNativeMainProfileRequestCount,
  resetLifecycleDrainStateForTests,
} from "../../src/server/lifecycle";
import { fallbackCodexAccountLogLabel } from "../../src/codex/account-label";
import {
  handleCodexAuthAPI, updateAccountQuota, getAccountQuota,
  checkAccountIdCollision, getMainChatgptAccountId,
  markAccountNeedsReauth, isAccountNeedsReauth, clearAccountNeedsReauth, clearAccountQuota,
  clearMainAccountInfoCache, maskEmail, fetchMainAccountInfo, fetchMainAccountInfoSnapshot,
  clearCodexQuotaPrimeState, primeCodexPoolQuotas, seedCodexAuthAdmissionForTests,
  type CodexAuthAccountDto,
  listCodexAuthAccounts,
  setAccountQuotaFromParsed,
} from "../../src/codex/auth-api";
import {
  getCodexAccountCredential,
  listCodexAccountIds,
  readCodexAccountRecord,
  removeCodexAccountCredential,
  saveCodexAccountCredential,
} from "../../src/codex/account-store";
import * as accountStoreModule from "../../src/codex/account-store";
import { isCodexAccountUsable } from "../../src/codex/account-usability";
import * as reserveAvailabilityModule from "../../src/codex/reserve-availability";
import { getMainAccountInfoCache, observeMainQuotaCredential } from "../../src/codex/main-account-cache";
import { openManualResetCreditOperation } from "../../src/codex/reset-credit-operation-ledger";
import { quotaRecoveryRecordForTests, resetQuotaRecoveryForTests } from "../../src/codex/quota-401-recovery";
import { watchdogMs } from "../helpers/ci-watchdog";
import {
  clearCodexUpstreamHealth,
  clearCodexUpstreamHealthForAccount,
  getCodexQuotaHealthSnapshot,
  claimManualResetCooldowns,
  settleManualResetCooldown,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
  resolveCodexAccountForThread,
} from "../../src/codex/routing";
import { pinnedCodexAccountId, setCodexAccountPin } from "../../src/codex/account-priority";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import {
  clearCodexWebSocketRegistry,
  getTrackedCodexWebSocketCountForAccount,
  registerCodexWebSocket,
} from "../../src/codex/websocket-registry";
import type { OcxConfig } from "../../src/types";
import type { WsData } from "../../src/server/ws-bridge";
import { handleNativeProfileAPI } from "../../src/codex/native-profile-api";
import type { NativeProfileManager } from "../../src/codex/native-profile-manager";
import { getMainPolicyQuota } from "../../src/codex/quota";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "../../src/codex/main-account";
import { reconcileCodexPlansFromTokens, resetJwtPlanNotesForTests } from "../../src/codex/plan-from-token";
import {
  deleteCodexAccount,
  reconcileMainCodexAccountRuntimeState,
  resetMainCodexAccountIdentityTrackingForTests,
} from "../../src/codex/account-lifecycle";
import {
  ConfigMutationLockError,
  armClaudeCodeBaseline,
  getConfigPath,
  loadConfig,
  saveConfig,
  setPersistedConfigMutationBeforeCommitForTests,
} from "../../src/config";
import * as configModule from "../../src/config";
import { setCodexAccountAutoSwitchThresholdOverride } from "../../src/codex/account-auto-switch";
import { prepareConfigObjectChildDeletionRebase } from "../../src/config/rebase-provenance";
import type { CatalogDisposition } from "../../src/codex/convergence-types";
import { captureConfigGeneration, registerStateStore } from "../../src/lib/state-store-sweeper";
import {
  reconcileLiveStateStores,
  setLiveStateStoreConfig,
  STATE_STORE_REGISTRATIONS,
} from "../../src/lib/state-store-registrations";
import {
  listOpenAiForwardSidecarCandidates,
  resolveFirstUsableOpenAiSidecar,
} from "../../src/providers/openai-sidecar";
import { BOUNDED_BODY_MAX_BYTES } from "../../src/lib/bounded-body";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let TEST_DIR = "";
let TEST_CODEX_HOME = "";
const MANUAL_IMPORT_ENV = "OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT";
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;
let previousManualImportEnv: string | undefined;
let previousFetch: typeof fetch;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  };
}

function seedPoolAccount(
  config: OcxConfig,
  account: {
    id: string;
    email: string;
    plan?: string;
    accessToken?: string;
    refreshToken?: string;
    chatgptAccountId?: string;
    expiresAt?: number;
  },
): void {
  config.codexAccounts = [
    ...(config.codexAccounts ?? []),
    { id: account.id, email: account.email, plan: account.plan, isMain: false },
  ];
  saveCodexAccountCredential(account.id, {
    accessToken: account.accessToken ?? `access-${account.id}`,
    refreshToken: account.refreshToken ?? `refresh-${account.id}`,
    expiresAt: account.expiresAt ?? Date.now() + 5 * 60_000,
    chatgptAccountId: account.chatgptAccountId ?? `acct-${account.id}`,
  });
}

beforeEach(() => {
  resetLifecycleDrainStateForTests();
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousManualImportEnv = process.env[MANUAL_IMPORT_ENV];
  previousFetch = globalThis.fetch;
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-codex-auth-api-"));
  TEST_CODEX_HOME = join(TEST_DIR, "codex");
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
  delete process.env[MANUAL_IMPORT_ENV];
  clearAccountNeedsReauth("__main__");
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearCodexWebSocketRegistry();
  resetMainCodexAccountIdentityTrackingForTests();
  resetJwtPlanNotesForTests();
  resetQuotaRecoveryForTests();
});

afterEach(async () => {
  resetLifecycleDrainStateForTests();
  setPersistedConfigMutationBeforeCommitForTests(null);
  clearAccountNeedsReauth("__main__");
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearCodexWebSocketRegistry();
  globalThis.fetch = previousFetch;
  resetQuotaRecoveryForTests();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousManualImportEnv === undefined) delete process.env[MANUAL_IMPORT_ENV];
  else process.env[MANUAL_IMPORT_ENV] = previousManualImportEnv;
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (TEST_DIR) removeTreeWithRetry(TEST_DIR);
  TEST_DIR = "";
  TEST_CODEX_HOME = "";
});

describe("Codex per-account threshold API", () => {
  async function putAccountAutoSwitch(config: OcxConfig, body: unknown): Promise<Response> {
    const req = new Request("http://localhost/api/codex-auth/auto-switch", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return (await handleCodexAuthAPI(req, new URL(req.url), config))!;
  }

  test("PUT /api/codex-auth/auto-switch persists a pool account override", async () => {
    const config = makeConfig({ autoSwitchThreshold: 95 });
    seedPoolAccount(config, { id: "work", email: "work@example.test" });

    const resp = await putAccountAutoSwitch(config, { id: "work", threshold: 60 });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({
      ok: true,
      id: "work",
      autoSwitchThresholdOverride: 60,
      autoSwitchThreshold: 60,
    });
    expect(config.codexAccountAutoSwitchThresholds).toEqual({ work: 60 });
  });

  test("PUT /api/codex-auth/auto-switch persists a main-account override", async () => {
    const config = makeConfig({ autoSwitchThreshold: 95 });

    const resp = await putAccountAutoSwitch(config, {
      id: MAIN_CODEX_ACCOUNT_ID,
      threshold: 0,
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({
      id: MAIN_CODEX_ACCOUNT_ID,
      autoSwitchThresholdOverride: 0,
      autoSwitchThreshold: 0,
    });
    expect(config.codexAccountAutoSwitchThresholds).toEqual({
      [MAIN_CODEX_ACCOUNT_ID]: 0,
    });
  });

  test.each([
    ["new override", undefined, 0],
    ["replacement override", { __main__: 60, side: 35 }, 0],
    ["last override reset", { __main__: 60 }, null],
    ["sibling-preserving reset", { __main__: 60, side: 35 }, null],
  ] as const)("account threshold rollback preserves live and disk state after lock contention: %s", async (_label, thresholds, threshold) => {
    saveConfig(makeConfig({ providers: { openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" } },
      autoSwitchThreshold: 95, ...(thresholds ? { codexAccountAutoSwitchThresholds: { ...thresholds } } : {}) }));
    const config = loadConfig();
    armClaudeCodeBaseline(config);
    // Established deletion provenance allows rebasing newly added disk-only fields.
    configModule.deleteConfigTopLevelKey(config, "injectionPrompt");
    const previousMap = config.codexAccountAutoSwitchThresholds;
    const previousDescriptor = Object.getOwnPropertyDescriptor(config, "codexAccountAutoSwitchThresholds");
    const diskBefore = readFileSync(getConfigPath(), "utf8");
    const lockDatabase = new Database(join(TEST_DIR, "config-mutation.sqlite"), { create: true });
    lockDatabase.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    try {
      await expect(putAccountAutoSwitch(config, { id: MAIN_CODEX_ACCOUNT_ID, threshold }))
        .rejects.toBeInstanceOf(ConfigMutationLockError);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(diskBefore);
      expect(config.codexAccountAutoSwitchThresholds).toBe(previousMap);
      expect(config.codexAccountAutoSwitchThresholds).toEqual(thresholds);
      expect(Object.getOwnPropertyDescriptor(config, "codexAccountAutoSwitchThresholds")).toEqual(previousDescriptor);
    } finally {
      lockDatabase.exec("ROLLBACK");
      lockDatabase.close();
    }
    // A later unrelated save must not publish the rejected override/reset or erase a disk sibling.
    writeFileSync(getConfigPath(), JSON.stringify({ ...JSON.parse(diskBefore),
      codexAccountAutoSwitchThresholds: { ...thresholds, concurrent: 25 }, autoSwitchThreshold: 90 }));
    config.upstreamFailoverThreshold = 4;
    configModule.saveConfigPreservingClaudeCode(config);
    expect(loadConfig()).toMatchObject({ autoSwitchThreshold: 90, upstreamFailoverThreshold: 4,
      codexAccountAutoSwitchThresholds: { ...thresholds, concurrent: 25 } });
    expect(config.codexAccountAutoSwitchThresholds).toEqual({ ...thresholds, concurrent: 25 });
    expect(loadConfig().configRebaseProvenance).toEqual({ version: 1, deletedTopLevelKeys: ["injectionPrompt"] });
  });

  test.each(["lock contention", "save boundary failure"] as const)(
    "account threshold rollback restores pending child deletions after %s", async failure => {
      saveConfig(makeConfig({ providers: { openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" } },
        autoSwitchThreshold: 95, codexAccountAutoSwitchThresholds: { work: 60 } }));
      const config = loadConfig();
      armClaudeCodeBaseline(config);
      // This pending, previously accepted reset must survive rollback of the next request.
      setCodexAccountAutoSwitchThresholdOverride(config, "work", null);
      const previousDescriptor = Object.getOwnPropertyDescriptor(config, "codexAccountAutoSwitchThresholds");
      const diskBefore = readFileSync(getConfigPath(), "utf8");
      const lockDatabase = failure === "lock contention"
        ? new Database(join(TEST_DIR, "config-mutation.sqlite"), { create: true }) : undefined;
      lockDatabase?.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      const saveSpy = failure === "save boundary failure"
        ? spyOn(configModule, "saveConfigPreservingClaudeCode").mockImplementation(candidate => {
          // Real pre-save preparation can recreate the absent parent before a later failure.
          prepareConfigObjectChildDeletionRebase(candidate);
          throw new ConfigMutationLockError("synthetic config commit failure");
        }) : undefined;
      try {
        await expect(putAccountAutoSwitch(config, { id: MAIN_CODEX_ACCOUNT_ID, threshold: null }))
          .rejects.toBeInstanceOf(ConfigMutationLockError);
        expect(readFileSync(getConfigPath(), "utf8")).toBe(diskBefore);
        expect(Object.getOwnPropertyDescriptor(config, "codexAccountAutoSwitchThresholds")).toEqual(previousDescriptor);
      } finally {
        saveSpy?.mockRestore();
        lockDatabase?.exec("ROLLBACK");
        lockDatabase?.close();
      }
      writeFileSync(getConfigPath(), JSON.stringify({ ...JSON.parse(diskBefore),
        codexAccountAutoSwitchThresholds: { work: 85, __main__: 70, concurrent: 25 }, autoSwitchThreshold: 90 }));
      config.upstreamFailoverThreshold = 4;
      configModule.saveConfigPreservingClaudeCode(config);
      // Keep old work deletion, discard rejected main deletion, adopt concurrent additions.
      expect(config.codexAccountAutoSwitchThresholds).toEqual({ __main__: 70, concurrent: 25 });
      expect(loadConfig()).toMatchObject({ autoSwitchThreshold: 90, upstreamFailoverThreshold: 4,
        codexAccountAutoSwitchThresholds: { __main__: 70, concurrent: 25 } });
      expect(loadConfig().codexAccountAutoSwitchThresholds).not.toHaveProperty("work");
    },
  );

  test("PUT /api/codex-auth/auto-switch rejects an unknown pool account", async () => {
    const config = makeConfig({ autoSwitchThreshold: 95 });

    const resp = await putAccountAutoSwitch(config, { id: "missing", threshold: 60 });

    expect(resp.status).toBe(404);
    expect(config.codexAccountAutoSwitchThresholds).toBeUndefined();
  });

  test("a null account threshold restores global inheritance and drops an empty map", async () => {
    const config = makeConfig({
      autoSwitchThreshold: 95,
      codexAccountAutoSwitchThresholds: { work: 60 },
    });
    seedPoolAccount(config, { id: "work", email: "work@example.test" });

    const resp = await putAccountAutoSwitch(config, { id: "work", threshold: null });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({
      id: "work",
      autoSwitchThresholdOverride: null,
      autoSwitchThreshold: 95,
    });
    expect(config.codexAccountAutoSwitchThresholds).toBeUndefined();
  });

  test("account threshold overrides include main and are reported by the account list", async () => {
    const config = makeConfig({
      autoSwitchThreshold: 95,
      codexAccountAutoSwitchThresholds: { work: 60, [MAIN_CODEX_ACCOUNT_ID]: 0 },
    });
    seedPoolAccount(config, { id: "work", email: "work@example.test" });
    seedPoolAccount(config, { id: "side", email: "side@example.test" });

    const accounts = await listCodexAuthAccounts(config);

    expect(accounts.find(a => a.id === "work")?.autoSwitchThresholdOverride).toBe(60);
    expect(accounts.find(a => a.id === "side")?.autoSwitchThresholdOverride).toBeNull();
    expect(accounts.find(a => a.isMain)?.autoSwitchThresholdOverride).toBe(0);
  });

  test.each([
    [true, "p***n@example.test"],
    [false, "person@example.test"],
  ] as const)("account threshold DTOs preserve email masking=%s", async (maskEmails, expectedEmail) => {
    const config = makeConfig({
      autoSwitchThreshold: 95,
      codexAccountAutoSwitchThresholds: { work: 0, missing: 60 },
      privacy: { maskEmails },
    });
    seedPoolAccount(config, { id: "work", email: "person@example.test" });
    seedPoolAccount(config, { id: "missing", email: "person@example.test" });
    updateAccountQuota("work", 99);
    removeCodexAccountCredential("missing");

    const accounts = await listCodexAuthAccounts(config);

    expect(accounts.find(account => account.id === "work")).toMatchObject({
      email: expectedEmail,
      autoSwitchThresholdOverride: 0,
      hasCredential: true,
    });
    expect(accounts.find(account => account.id === "missing")).toMatchObject({
      email: expectedEmail,
      autoSwitchThresholdOverride: 60,
      hasCredential: false,
      needsReauth: true,
    });
    expect(JSON.stringify(accounts)).not.toContain("access-work");
    expect(JSON.stringify(accounts)).not.toContain("refresh-work");
  });

  test.each([
    ["a negative threshold", -1],
    ["a threshold above 100", 101],
    ["a fractional threshold", 1.5],
    ["a numeric string", "80"],
    ["a missing threshold", undefined],
  ] as const)("rejects %s as an account threshold override", async (_label, threshold) => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "work", email: "work@example.test" });

    const resp = await putAccountAutoSwitch(config, { id: "work", threshold });

    expect(resp.status).toBe(400);
    expect(config.codexAccountAutoSwitchThresholds).toBeUndefined();
  });

});
