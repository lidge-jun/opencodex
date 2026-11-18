import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCodexUpstreamHealth, clearThreadAccountMap, resolveCodexAccountForThread } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/auth-api";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";

// Lives beside codex-routing.test.ts, which sits at its file-size cap (#7896).
// A pool account whose 5-hour window filled while its weekly window was known kept
// scoring 100 after that window's reset passed, so a lower-priority account served
// every request until something happened to re-probe WHAM.

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const NOW = 1_800_000_000_000;
let testDir = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function orderedConfig(): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "a", email: "a@test", isMain: false },
      { id: "b", email: "b@test", isMain: false },
    ],
    activeCodexAccountId: "b",
    codexAccountPriorities: { a: 1 },
    autoSwitchThreshold: 97,
  } as OcxConfig;
}

function saveTestCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: "access-" + id, refreshToken: "refresh-" + id,
    expiresAt: NOW + 5 * 60_000, chatgptAccountId: "acct-" + id,
  });
}

describe("priority after an elapsed 5-hour reset (#7896)", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-routing-elapsed-short-"));
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    process.env.OPENCODEX_HOME = testDir;
    process.env.CODEX_HOME = testDir;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearPoolRotationState();
    saveTestCredential("a");
    saveTestCredential("b");
  });

  afterEach(() => {
    try {
      clearAccountQuota();
      clearCodexUpstreamHealth();
      clearThreadAccountMap();
      clearPoolRotationState();
    } finally {
      setIcaclsRunnerForTests(null);
      setAsyncIcaclsRunnerForTests(null);
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      removeTreeWithRetry(testDir);
    }
  });

  test("the higher tier returns once its known short reset has passed, without a fresh probe", () => {
    const config = orderedConfig();
    setAccountQuotaFromParsed("a", { weeklyPercent: 20, shortPercent: 100, shortResetAt: NOW + 3_600_000 });
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread(null, config, NOW)).toBe("b");
    expect(resolveCodexAccountForThread(null, config, NOW + 3_601_000)).toBe("a");
  });

  test("a short reading without a reset still keeps the higher tier out", () => {
    const config = orderedConfig();
    setAccountQuotaFromParsed("a", { weeklyPercent: 20, shortPercent: 100 });
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread(null, config, NOW + 3_601_000)).toBe("b");
  });
});
