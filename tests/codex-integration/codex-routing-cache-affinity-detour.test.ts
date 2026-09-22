import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getEffectiveActiveCodexAccountId,
  resolveCodexAccountForThread,
  resolveCodexAccountForThreadDetailed,
} from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  updateAccountQuota,
} from "../../src/codex/auth-api";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";

// These cases moved out of codex-routing.test.ts, which sits at its file-size
// cap. They cover the cache-affinity boundary between a proactive quota-switch
// threshold crossing (a hint) and genuine 100% exhaustion (evidence) for a
// shared binding during a model-scoped detour.

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
  try {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
  } finally {
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
    accessToken: "access-" + id,
    refreshToken: "refresh-" + id,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: "acct-" + id,
  });
}

describe("cache affinity across model detours", () => {
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

  /** \`a\` is ordered above \`b\`; the persisted operator selection is the lower tier. */
  function orderedConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
    return makeConfig({
      activeCodexAccountId: "b",
      codexAccountPriorities: { a: 1 },
      ...overrides,
    } as Partial<OcxConfig>);
  }

  test("cache affinity preserves an over-threshold shared binding across a model detour", () => {
    const config = orderedConfig({
      accountPoolStrategy: "quota",
      activeCodexAccountId: "a",
      activeCodexAccountPinned: "a",
      autoSwitchThreshold: 80,
      pool: { cacheAffinity: true },
    });
    const now = Date.now();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);

    expect(resolveCodexAccountForThread("cache-affine-model-detour", config, now, "shared")).toBe("a");
    updateAccountQuota("a", 90);
    expect(resolveCodexAccountForThreadDetailed(
      "cache-affine-model-detour",
      config,
      now + 1,
      "shared",
      { modelEligibleAccountIds: new Set(["b"]) },
    )).toMatchObject({ status: "selected", accountId: "b" });

    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    expect(resolveCodexAccountForThread("cache-affine-model-detour", config, now + 2, "shared")).toBe("a");
  });

  test("cache affinity releases a fully exhausted shared binding across a model detour", () => {
    const config = orderedConfig({
      accountPoolStrategy: "quota",
      activeCodexAccountId: "a",
      activeCodexAccountPinned: "a",
      autoSwitchThreshold: 80,
      pool: { cacheAffinity: true },
    });
    const now = Date.now();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);

    expect(resolveCodexAccountForThread("cache-affine-exhausted-detour", config, now, "shared")).toBe("a");
    updateAccountQuota("a", 100);
    expect(resolveCodexAccountForThreadDetailed(
      "cache-affine-exhausted-detour",
      config,
      now + 1,
      "shared",
      { modelEligibleAccountIds: new Set(["b"]) },
    )).toMatchObject({ status: "selected", accountId: "b" });

    // Genuine exhaustion is the live-binding bar: the shared cursor follows the account
    // that actually served instead of staying parked on the drained one.
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
    expect(resolveCodexAccountForThread("cache-affine-exhausted-detour", config, now + 2, "shared")).toBe("b");
  });

  test("cache affinity releases an exhausted shared binding even with quota switching disabled", () => {
    const config = orderedConfig({
      accountPoolStrategy: "quota",
      activeCodexAccountId: "a",
      activeCodexAccountPinned: "a",
      autoSwitchThreshold: 0,
      pool: { cacheAffinity: true },
    });
    const now = Date.now();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);

    expect(resolveCodexAccountForThread("cache-affine-disabled-detour", config, now, "shared")).toBe("a");
    updateAccountQuota("a", 100);
    expect(resolveCodexAccountForThreadDetailed(
      "cache-affine-disabled-detour",
      config,
      now + 1,
      "shared",
      { modelEligibleAccountIds: new Set(["b"]) },
    )).toMatchObject({ status: "selected", accountId: "b" });

    // Genuine exhaustion drops the binding even when threshold switching is disabled --
    // the same >=100% boundary a live binding gets -- and the shared selection follows
    // the account that actually served.
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
    expect(resolveCodexAccountForThread("cache-affine-disabled-detour", config, now + 2, "shared")).toBe("b");
  });
});
