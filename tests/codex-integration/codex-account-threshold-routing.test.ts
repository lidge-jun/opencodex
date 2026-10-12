import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_BUDGET_MS } from "../helpers/test-budget";
import {
  CODEX_FAILURE_WINDOW_MS,
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  CODEX_TRANSIENT_SOFT_AVOID_MS,
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  CODEX_THREAD_AFFINITY_MAX_ENTRIES,
  CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS,
  classifyCodexUpstreamOutcome,
  clearCodexAccountCooldown,
  clearCodexUpstreamHealth,
  clearCodexUpstreamHealthForAccount,
  clearThreadAccountMap,
  clearThreadAccountMapForAccount,
  computeCodexUsageScore,
  getCodexAccountCooldownUntil,
  getEffectiveActiveCodexAccountId,
  getCodexQuotaHealthSnapshot,
  getCodexAccountSoftAvoidUntil,
  getCodexUpstreamHealth,
  isCodexAccountInCooldown,
  isCodexAccountSoftAvoided,
  pickLowestUsageCodexAccount,
  parseRetryAfterMs,
  previewCodexAccountForRequest,
  reconcileCodexActiveAfterExclusion,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
  resolveCodexAccountForThread,
  resolveCodexAccountForThreadDetailed,
  tryAcquireCodexQuotaProbeLease,
} from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { readCodexAccountRecord, removeCodexAccountCredential, saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  getAccountQuota,
  handleCodexAuthAPI,
  isAccountNeedsReauth,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  updateAccountQuota,
} from "../../src/codex/auth-api";
import { CODEX_UNKNOWN_USAGE_SCORE, isCodexQuotaExhausted } from "../../src/codex/quota";
import { setCodexAccountPriority } from "../../src/codex/account-priority";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { NATIVE_RESERVE_MODEL } from "../../src/codex/catalog/native-models";
import { routeModel } from "../../src/router";
import { consumeForInspection } from "../../src/server/relay";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

import { flushConfigDirHardeningForTests, hardenConfigDir } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";

let TEST_DIR = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

function installRoutingScratchHome(): void {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-routing-"));
  // Routing cases exercise account state, not the operating system ACL implementation.
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_DIR;
}

async function removeRoutingScratchHome(): Promise<void> {
  const ownedDirectory = TEST_DIR;
  TEST_DIR = "";
  try {
    await flushConfigDirHardeningForTests();
  } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (ownedDirectory) removeTreeWithRetry(ownedDirectory);
  }
}

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "a", email: "a@test", isMain: false },
      { id: "b", email: "b@test", isMain: false },
    ],
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    upstreamFailoverThreshold: 3,
    ...overrides,
  } as OcxConfig;
}

function saveTestCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

describe("codex routing", () => {
  beforeEach(() => {
    installRoutingScratchHome();
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearAccountNeedsReauth("a");
    clearAccountNeedsReauth("b");
    clearAccountNeedsReauth("c");
    saveTestCredential("a");
    saveTestCredential("b");
  });

  afterEach(async () => {
    try {
      clearAccountQuota();
      clearCodexUpstreamHealth();
      clearThreadAccountMap();
      clearAccountNeedsReauth("a");
      clearAccountNeedsReauth("b");
      clearAccountNeedsReauth("c");
    } finally {
      await removeRoutingScratchHome();
    }
  });

  test("an inherited fractional global threshold keeps its configured value", () => {
    const config = makeConfig({ autoSwitchThreshold: 95.5 });
    updateAccountQuota("a", 90);
    updateAccountQuota("b", 5);

    expect(resolveCodexAccountForThread("fractional-global-threshold", config)).toBe("a");
  });

  test("an account threshold override switches below the global threshold", () => {
    const config = makeConfig({
      autoSwitchThreshold: 95,
      codexAccountAutoSwitchThresholds: { a: 50 },
    } as Partial<OcxConfig> & { codexAccountAutoSwitchThresholds: Record<string, number> });
    updateAccountQuota("a", 60);
    updateAccountQuota("b", 5);

    expect(resolveCodexAccountForThread("account-threshold", config)).toBe("b");
  });

  test("a zero account override disables proactive switching only for that account", () => {
    const config = makeConfig({
      autoSwitchThreshold: 50,
      codexAccountAutoSwitchThresholds: { a: 0 },
    } as Partial<OcxConfig> & { codexAccountAutoSwitchThresholds: Record<string, number> });
    updateAccountQuota("a", 99);
    updateAccountQuota("b", 1);

    expect(resolveCodexAccountForThread("account-threshold-off", config)).toBe("a");
  });

  test("a bound task uses its account threshold override for immediate re-evaluation", () => {
    const config = makeConfig({
      autoSwitchThreshold: 95,
      pool: { cacheAffinity: false },
      codexAccountAutoSwitchThresholds: { a: 50 },
    } as Partial<OcxConfig> & { codexAccountAutoSwitchThresholds: Record<string, number> });
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 5);
    expect(resolveCodexAccountForThread("account-threshold-bound", config, now)).toBe("a");

    updateAccountQuota("a", 60);
    expect(resolveCodexAccountForThread("account-threshold-bound", config, now + 1)).toBe("b");
  });

  test.each(["quota", "fill-first", "round-robin"] as const)(
    "%s zero account threshold preserves full-usage affinity but still avoids a cooled account",
    (strategy) => {
      const now = Date.now();
      const threadId = `zero-threshold-cooldown-${strategy}`;
      const config = makeConfig({
        accountPoolStrategy: strategy,
        accountPoolStickyLimit: 1,
        activeCodexAccountPinned: "a",
        autoSwitchThreshold: 50,
        codexAccountAutoSwitchThresholds: { a: 0 },
      });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 1);
      resetCodexRoutingForManualSelection("a");
      expect(resolveCodexAccountForThread(threadId, config, now)).toBe("a");

      updateAccountQuota("a", 100);
      const reevalAt = now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
      expect(previewCodexAccountForRequest(threadId, config, reevalAt)).toBe("a");
      expect(resolveCodexAccountForThread(threadId, config, reevalAt)).toBe("a");
      expect(resolveCodexAccountForThread(null, config, reevalAt)).toBe("a");
      expect(config.activeCodexAccountPinned).toBe("a");

      // Record health without rotating on the outcome: the selector itself must
      // reject the cooled account even though proactive switching is disabled.
      recordCodexUpstreamOutcome(config, "a", 429, {
        fixedAccount: true,
        retryAfter: "600",
        now: reevalAt,
      });
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
      expect(previewCodexAccountForRequest(threadId, config, reevalAt + 1)).toBe("b");
      expect(resolveCodexAccountForThread(threadId, config, reevalAt + 1)).toBe("b");
      expect(getCodexAccountCooldownUntil("a", reevalAt + 1)).toBe(reevalAt + 600_000);
    },
  );

  test.each((["quota", "fill-first", "round-robin"] as const)
    .flatMap(strategy => [99, 100].map(usage => [strategy, usage] as const)))(
    "%s zero account threshold preserves model-detour state unless cache affinity is exhausted at %s",
    (strategy, usage) => {
      const now = Date.now();
      const threadId = `zero-threshold-model-detour-${strategy}`;
      const modelId = "gpt-daybreak-blue-latest";
      const config = makeConfig({
        accountPoolStrategy: strategy,
        accountPoolStickyLimit: 1,
        activeCodexAccountPinned: "a",
        autoSwitchThreshold: 50,
        codexAccountAutoSwitchThresholds: { a: 0 },
      });
      updateAccountQuota("a", usage);
      updateAccountQuota("b", 1);
      resetCodexRoutingForManualSelection("a");
      expect(resolveCodexAccountForThread(threadId, config, now, "shared")).toBe("a");

      const selectionOptions = { modelEligibleAccountIds: new Set(["b"]) };
      expect(previewCodexAccountForRequest(
        threadId, config, now + 1, "shared", selectionOptions, modelId,
      )).toBe("b");
      const preserve = strategy !== "quota" || usage < 100;
      const expectedShared = preserve ? "a" : "b";
      expect(resolveCodexAccountForThreadDetailed(
        threadId, config, now + 1, "shared", selectionOptions, modelId,
      )).toEqual({ status: "selected", accountId: "b", affinity: preserve
        ? { move: "new_bind", reason: "healthy" } : { move: "rebound", reason: "unusable" } });
      expect(config.activeCodexAccountId).toBe(expectedShared);
      expect(config.activeCodexAccountPinned).toBe(preserve ? "a" : undefined);
      expect(getEffectiveActiveCodexAccountId(config)).toBe(expectedShared);
      expect(resolveCodexAccountForThread(threadId, config, now + 2, "shared")).toBe(expectedShared);
      expect(resolveCodexAccountForThread(null, config, now + 2, "shared")).toBe(expectedShared);
    },
  );

});
