import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  pickLowestUsageCodexAccount,
  previewCodexAccountForRequest,
  resolveCodexAccountForThread,
} from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const ACCOUNT_IDS = ["paid", "downgraded"];

let testDir = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "downgraded", email: "downgraded@test", isMain: false, plan: "free" },
      { id: "paid", email: "paid@test", isMain: false, plan: "plus" },
    ],
    activeCodexAccountId: "downgraded",
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

/**
 * A `free` plan is thirty-day-only, so its usage score reads the monthly window while `plus`
 * reads the weekly one. Recording both windows keeps these cases about the plan policy instead of
 * about which account happened to have an observed window.
 */
function recordUsage(id: string, percent: number): void {
  updateAccountQuota(id, percent, undefined, percent);
}

describe("codex pool plan exclusion", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-plan-exclusion-"));
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    process.env.OPENCODEX_HOME = testDir;
    process.env.CODEX_HOME = testDir;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearPoolRotationState();
    for (const id of ACCOUNT_IDS) clearAccountNeedsReauth(id);
    for (const id of ACCOUNT_IDS) saveTestCredential(id);
  });

  afterEach(async () => {
    const owned = testDir;
    testDir = "";
    try {
      clearAccountQuota();
      clearCodexUpstreamHealth();
      clearThreadAccountMap();
      clearPoolRotationState();
      for (const id of ACCOUNT_IDS) clearAccountNeedsReauth(id);
      await flushConfigDirHardeningForTests();
    } finally {
      setIcaclsRunnerForTests(null);
      setAsyncIcaclsRunnerForTests(null);
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (owned) removeTreeWithRetry(owned);
    }
  });

  test("no policy leaves rotation exactly as it was", () => {
    const config = makeConfig();
    recordUsage("downgraded", 10);
    recordUsage("paid", 20);
    expect(pickLowestUsageCodexAccount(config)).toBe("downgraded");
    expect(resolveCodexAccountForThread("no-policy", config)).toBe("downgraded");
  });

  test("an empty exclusion list is not a policy", () => {
    const config = makeConfig({ codexPool: { excludedPlans: [] } });
    recordUsage("downgraded", 10);
    recordUsage("paid", 20);
    expect(pickLowestUsageCodexAccount(config)).toBe("downgraded");
  });

  test("an excluded plan is skipped when routing picks a new account", () => {
    const config = makeConfig({ codexPool: { excludedPlans: ["free"] } });
    recordUsage("downgraded", 10);
    recordUsage("paid", 20);
    // Lower usage would otherwise win outright.
    expect(pickLowestUsageCodexAccount(config)).toBe("paid");
  });

  test("an account already serving a thread stops serving it once its plan is excluded", () => {
    // The reported case: the account was paid, took traffic, and was then downgraded. It is both
    // the active account and the affinity target, so the eligible list alone never sees it.
    const config = makeConfig();
    recordUsage("downgraded", 10);
    recordUsage("paid", 20);
    expect(resolveCodexAccountForThread("lapsed-subscription", config)).toBe("downgraded");

    config.codexPool = { excludedPlans: ["free"] };

    expect(resolveCodexAccountForThread("lapsed-subscription", config)).toBe("paid");
    expect(previewCodexAccountForRequest("lapsed-subscription", config)).toBe("paid");
  });

  test("plan matching ignores casing and surrounding whitespace on both sides", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "downgraded", email: "downgraded@test", isMain: false, plan: " Free " },
        { id: "paid", email: "paid@test", isMain: false, plan: "plus" },
      ],
      codexPool: { excludedPlans: ["FREE"] },
    } as Partial<OcxConfig>);
    recordUsage("downgraded", 10);
    recordUsage("paid", 20);
    expect(pickLowestUsageCodexAccount(config)).toBe("paid");
  });

  test("an account with no recorded plan is never excluded by a plan policy", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "downgraded", email: "downgraded@test", isMain: false },
        { id: "paid", email: "paid@test", isMain: false, plan: "plus" },
      ],
      codexPool: { excludedPlans: ["free"] },
    } as Partial<OcxConfig>);
    recordUsage("downgraded", 10);
    recordUsage("paid", 20);
    expect(pickLowestUsageCodexAccount(config)).toBe("downgraded");
  });

  test("a plan nobody holds excludes nobody", () => {
    const config = makeConfig({ codexPool: { excludedPlans: ["go"] } });
    recordUsage("downgraded", 10);
    recordUsage("paid", 20);
    expect(pickLowestUsageCodexAccount(config)).toBe("downgraded");
  });

  test("the last remaining account still serves rather than stranding the operator", () => {
    // Deliberately unlike pause. #4211 asks for a selection policy, not a hard block, so with no
    // unexcluded candidate left the excluded account keeps answering instead of failing closed.
    const config = makeConfig({
      codexAccounts: [{ id: "downgraded", email: "downgraded@test", isMain: false, plan: "free" }],
      codexPool: { excludedPlans: ["free"] },
    } as Partial<OcxConfig>);
    recordUsage("downgraded", 10);
    expect(pickLowestUsageCodexAccount(config)).toBeNull();
    expect(resolveCodexAccountForThread("last-account", config)).toBe("downgraded");
  });
});
