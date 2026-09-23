import { codexAccountPriorityFailbackEnabled, CODEX_PRIORITY_FAILBACK_REFRESH_MS } from "../../src/codex/account-priority";
import { configSchema } from "../../src/config/schema/config-schema";
import { getDefaultConfig } from "../../src/config/proxy-env";
import { codexQuotaHasFreshUsage } from "../../src/codex/quota-observation-freshness";
import { rememberActiveCodexAccount } from "../../src/codex/routing/active-account";
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
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

describe("codex priority failback boundaries", () => {
  beforeEach(() => {
    installRoutingScratchHome();
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearPoolRotationState();
    clearAccountNeedsReauth("a");
    clearAccountNeedsReauth("b");
    saveTestCredential("a");
    saveTestCredential("b");
  });

  afterEach(async () => {
    try {
      clearAccountQuota();
      clearCodexUpstreamHealth();
      clearThreadAccountMap();
      clearPoolRotationState();
      clearAccountNeedsReauth("a");
      clearAccountNeedsReauth("b");
    } finally {
      await removeRoutingScratchHome();
    }
  });

  /** `a` is ordered above `b`; the persisted operator selection is the lower tier. */
  function orderedConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
    return makeConfig({
      activeCodexAccountId: "b",
      codexAccountPriorities: { a: 1 },
      ...overrides,
    } as Partial<OcxConfig>);
  }

  test("opt-in moves the same task back after a five-hour quota recovery", () => {
    const config = orderedConfig({ codexAccountPriorityFailback: true, autoSwitchThreshold: 100 });
    const now = Date.now();
    updateAccountQuota("a", 4);
    updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("ongoing", config, now)).toBe("a");
    setAccountQuotaFromParsed("a", { weeklyPercent: 4, shortPercent: 100, shortResetAt: now / 1000 + 18000 });
    expect(resolveCodexAccountForThread("ongoing", config, now + 1)).toBe("b");
    setAccountQuotaFromParsed("a", { weeklyPercent: 4, shortPercent: 0, shortResetAt: now / 1000 + 36000 });
    expect(previewCodexAccountForRequest("ongoing", config, now + 2)).toBe("a");
    // Preview does not change the task or the active account.
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
    expect(resolveCodexAccountForThread("ongoing", config, now + 2)).toBe("a");
    expect(resolveCodexAccountForThread("ongoing", config, now + 3)).toBe("a");
  });

  test.each([undefined, false])("recovered priority does not move bound tasks by default (%s)", enabled => {
    const config = orderedConfig({ codexAccountPriorityFailback: enabled });
    updateAccountQuota("a", 100);
    updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("sticky", config)).toBe("b");
    updateAccountQuota("a", 0);
    expect(previewCodexAccountForRequest("sticky", config)).toBe("b");
    expect(resolveCodexAccountForThread("sticky", config)).toBe("b");
  });

  test("live failback in an independent quota scope leaves shared selection untouched", () => {
    const config = orderedConfig({ codexAccountPriorityFailback: true });
    updateAccountQuota("a", 100);
    updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("scoped-failback", config, Date.now(), "spark")).toBe("b");
    updateAccountQuota("a", 10);
    expect(previewCodexAccountForRequest("scoped-failback", config, Date.now(), "spark")).toBe("a");
    expect(resolveCodexAccountForThread("scoped-failback", config, Date.now(), "spark")).toBe("a");
    expect(config.activeCodexAccountId).toBe("b");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
  });

  test("live failback respects pins, model eligibility, cooldown and unknown quota", () => {
    const config = orderedConfig({ codexAccountPriorityFailback: true });
    const now = Date.now();
    updateAccountQuota("a", 100);
    updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("protected", config, now)).toBe("b");
    clearAccountQuota();
    updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("protected", config, now + 1)).toBe("b");
    updateAccountQuota("a", 0);
    config.activeCodexAccountPinned = "b";
    expect(resolveCodexAccountForThread("protected", config, now + 2)).toBe("b");
    delete config.activeCodexAccountPinned;
    expect(resolveCodexAccountForThreadDetailed("protected", config, now + 3, "shared",
      { modelEligibleAccountIds: new Set(["b"]) })).toMatchObject({ status: "selected", accountId: "b" });
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "600", now: now + 4, fixedAccount: true });
    expect(resolveCodexAccountForThread("protected", config, now + 5)).toBe("b");
  });

  test.each(["round-robin", "fill-first", "reset-first"] as const)("live failback leaves %s affinity unchanged", strategy => {
    const config = orderedConfig({ codexAccountPriorityFailback: true, accountPoolStrategy: strategy });
    updateAccountQuota("a", 100);
    updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("rotation", config)).toBe("b");
    updateAccountQuota("a", 0);
    expect(resolveCodexAccountForThread("rotation", config)).toBe("b");
  });

  test("stale priority evidence retains the warm task until a fresh observation arrives", () => {
    const config = orderedConfig({ codexAccountPriorityFailback: true });
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      for (const id of ["a", "b"]) {
        saveCodexAccountCredential(id, {
          ...readCodexAccountRecord(id)!.credential!, expiresAt: now + 3_600_000,
        });
      }
      updateAccountQuota("a", 100);
      updateAccountQuota("b", 2);
      expect(resolveCodexAccountForThread("stale-priority", config, now)).toBe("b");
      updateAccountQuota("a", 0);
      now += CODEX_PRIORITY_FAILBACK_REFRESH_MS + 1;
      expect(previewCodexAccountForRequest("stale-priority", config, now)).toBe("b");
      expect(resolveCodexAccountForThread("stale-priority", config, now)).toBe("b");
      updateAccountQuota("a", 0);
      expect(previewCodexAccountForRequest("stale-priority", config, now)).toBe("a");
      expect(config.activeCodexAccountId).toBe("b");
      expect(resolveCodexAccountForThread("stale-priority", config, now)).toBe("a");
      // Shared quota rebinding uses the existing persisted promotion path; preview does not.
      expect(config.activeCodexAccountId).toBe("a");
    } finally { clock.mockRestore(); }
  });

  test("a fresh same-tier account wins when the cooler sibling is stale", () => {
    const config = orderedConfig({ codexAccountPriorityFailback: true });
    config.codexAccounts!.push({ id: "c", email: "c@test", isMain: false });
    config.codexAccountPriorities = { a: 1, c: 1 };
    saveTestCredential("c");
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      for (const id of ["a", "b", "c"]) saveCodexAccountCredential(id, {
        ...readCodexAccountRecord(id)!.credential!, expiresAt: now + 3_600_000,
      });
      updateAccountQuota("a", 100);
      updateAccountQuota("c", 100);
      updateAccountQuota("b", 2);
      expect(resolveCodexAccountForThread("same-tier", config, now)).toBe("b");
      updateAccountQuota("a", 0);
      now += CODEX_PRIORITY_FAILBACK_REFRESH_MS + 1;
      updateAccountQuota("c", 10);
      expect(previewCodexAccountForRequest("same-tier", config, now)).toBe("c");
      expect(resolveCodexAccountForThread("same-tier", config, now)).toBe("c");
    } finally {
      clock.mockRestore();
      clearAccountNeedsReauth("c");
    }
  });

  test("threshold zero disables only the explicit live failback preference", () => {
    const config = orderedConfig({ codexAccountPriorityFailback: true });
    updateAccountQuota("a", 100);
    updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("zero-failback", config)).toBe("b");
    config.autoSwitchThreshold = 0;
    updateAccountQuota("a", 0);
    expect(codexAccountPriorityFailbackEnabled(config, "b")).toBe(false);
    expect(previewCodexAccountForRequest("zero-failback", config)).toBe("b");
    expect(resolveCodexAccountForThread("zero-failback", config)).toBe("b");
  });

  test.each([undefined, false, "true", 1])("invalid or absent failback does not enable it (%s)", value => {
    const parsed = configSchema.safeParse({ ...getDefaultConfig(), codexAccountPriorityFailback: value });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("optional preference discarded the configuration");
    expect(parsed.data.providers.openai).toEqual(getDefaultConfig().providers.openai);
    expect(codexAccountPriorityFailbackEnabled(parsed.data as OcxConfig, "b")).toBe(false);
  });

  test.each([
    { global: 80, source: 0, candidate: 80, usage: 1, expected: "b" },
    { global: 0, source: 40, candidate: undefined, usage: 20, expected: "a" },
    { global: 0, source: undefined, candidate: 80, usage: 1, expected: "b" },
    { global: 80, source: 80, candidate: 20, usage: 19, expected: "a" },
    { global: 80, source: 80, candidate: 20, usage: 20, expected: "b" },
    { global: 80, source: 30, candidate: 0, usage: 0, expected: "a" },
    { global: 80, source: 30, candidate: 0, usage: 99, expected: "a" },
    { global: 80, source: 30, candidate: 0, usage: 100, expected: "b" },
    { global: 80, source: undefined, candidate: undefined, usage: 80, expected: "b" },
  ])("effective source/candidate thresholds agree in preview and resolve: %j", scenario => {
    const config = orderedConfig({ codexAccountPriorityFailback: true });
    updateAccountQuota("a", 100); updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("effective", config)).toBe("b");
    config.autoSwitchThreshold = scenario.global;
    config.codexAccountAutoSwitchThresholds = {
      ...(scenario.source === undefined ? {} : { b: scenario.source }),
      ...(scenario.candidate === undefined ? {} : { a: scenario.candidate }),
    };
    updateAccountQuota("a", scenario.usage);
    const snapshot = JSON.stringify(config);
    expect(previewCodexAccountForRequest("effective", config)).toBe(scenario.expected);
    expect(JSON.stringify(config)).toBe(snapshot);
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
    expect(resolveCodexAccountForThread("effective", config)).toBe(scenario.expected);
  });

  test("fresh credits or a partial short update cannot rejuvenate retained long-window evidence", () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      for (const id of ["a", "b"]) saveCodexAccountCredential(id, {
        ...readCodexAccountRecord(id)!.credential!, expiresAt: now + 3_600_000,
      });
      const config = orderedConfig({ codexAccountPriorityFailback: true });
      updateAccountQuota("a", 100); updateAccountQuota("b", 2);
      expect(resolveCodexAccountForThread("retained", config, now)).toBe("b");
      config.codexAccountAutoSwitchThresholds = { a: 0 };
      setAccountQuotaFromParsed("a", { weeklyPercent: 10, shortPercent: 0 });
      now += CODEX_PRIORITY_FAILBACK_REFRESH_MS + 1;
      for (const partial of [{ resetCredits: 1 }, { shortPercent: 0 }]) {
        setAccountQuotaFromParsed("a", partial);
        expect(getAccountQuota("a")!.updatedAt).toBe(now);
        expect(previewCodexAccountForRequest("retained", config, now)).toBe("b");
        expect(resolveCodexAccountForThread("retained", config, now)).toBe("b");
      }
      setAccountQuotaFromParsed("a", { weeklyPercent: 10, shortPercent: 0 });
      expect(previewCodexAccountForRequest("retained", config, now)).toBe("a");
      expect(resolveCodexAccountForThread("retained", config, now)).toBe("a");
    } finally { clock.mockRestore(); }
  });

  test("hydrated-looking quota without live observation proof cannot trigger optional failback", () => {
    expect(codexQuotaHasFreshUsage({ weeklyPercent: 0, updatedAt: Date.now() }, "plus", Date.now(), 300_000)).toBe(false);
  });

  test("the bound source threshold wins over an unrelated runtime cursor", () => {
    const config = orderedConfig({ codexAccountPriorityFailback: true });
    updateAccountQuota("a", 100); updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("bound-source", config)).toBe("b");
    config.codexAccountAutoSwitchThresholds = { a: 80, b: 0 };
    updateAccountQuota("a", 1);
    rememberActiveCodexAccount(config, "a");
    expect(previewCodexAccountForRequest("bound-source", config)).toBe("b");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    expect(resolveCodexAccountForThread("bound-source", config)).toBe("b");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
  });

  test("candidate zero cannot bypass an observed exhausted short window", () => {
    const config = orderedConfig({ codexAccountPriorityFailback: true });
    updateAccountQuota("a", 100); updateAccountQuota("b", 2);
    expect(resolveCodexAccountForThread("short-full", config)).toBe("b");
    config.codexAccountAutoSwitchThresholds = { a: 0 };
    setAccountQuotaFromParsed("a", { weeklyPercent: 1, shortPercent: 100, shortResetAt: Date.now() / 1000 + 3600 });
    expect(previewCodexAccountForRequest("short-full", config)).toBe("b");
    expect(resolveCodexAccountForThread("short-full", config)).toBe("b");
  });
});
