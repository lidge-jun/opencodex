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
import { codexAccountBlockReason } from "../../src/codex/routing/selection";
import {
  codexAccountUsesCreditsAfterLimit,
  forgetCodexAccountCreditUse,
  isCodexUsageLimitReached,
  setAllCodexAccountsCreditsAfterLimit,
  setCodexAccountCreditsAfterLimit,
} from "../../src/codex/account-credit-use";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, handleCodexAuthAPI, updateAccountQuota } from "../../src/codex/auth-api";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import type { OcxConfig } from "../../src/types";
import { configSchema } from "../../src/config/schema/config-schema";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const ACCOUNT_IDS = ["spender", "saver"];
const DAY_MS = 24 * 60 * 60_000;

let testDir = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

/**
 * Threshold 0 is the configuration #6334 came from: usage never moves an account off, so an
 * account that upstream keeps serving from credits stays selected until something else stops it.
 */
function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "spender", email: "spender@test", isMain: false, plan: "pro" },
      { id: "saver", email: "saver@test", isMain: false, plan: "pro" },
    ],
    activeCodexAccountId: "spender",
    autoSwitchThreshold: 0,
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

function recordWeekly(id: string, percent: number, resetAt?: number): void {
  updateAccountQuota(id, percent, resetAt);
}

async function putCredits(config: OcxConfig, body: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/codex-auth/accounts/credits", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
  if (!resp) throw new Error("route not handled");
  return resp;
}

describe("codex credits after the usage limit", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-credits-after-limit-"));
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

  test("by default an account at 100% is skipped and the pool moves on", () => {
    const config = makeConfig();
    recordWeekly("spender", 100, Date.now() + DAY_MS);
    recordWeekly("saver", 40, Date.now() + DAY_MS);
    expect(codexAccountUsesCreditsAfterLimit(config, "spender")).toBe(false);
    expect(resolveCodexAccountForThread("default", config)).toBe("saver");
    expect(previewCodexAccountForRequest("default", config)).toBe("saver");
    expect(codexAccountBlockReason(config, "spender", Date.now())).toBe("credits_off");
  });

  test("an account allowed to use credits keeps serving at 100%", () => {
    const config = makeConfig();
    setCodexAccountCreditsAfterLimit(config, "spender", true);
    recordWeekly("spender", 100, Date.now() + DAY_MS);
    recordWeekly("saver", 40, Date.now() + DAY_MS);
    expect(resolveCodexAccountForThread("credits-on", config)).toBe("spender");
    expect(codexAccountBlockReason(config, "spender", Date.now())).toBeUndefined();
  });

  test("a thread already served by the account leaves it once credits are turned off", () => {
    // The active, bound account is served without passing through the eligible list, which is
    // exactly the account that would otherwise keep spending.
    const config = makeConfig();
    setCodexAccountCreditsAfterLimit(config, "spender", true);
    recordWeekly("spender", 100, Date.now() + DAY_MS);
    recordWeekly("saver", 40, Date.now() + DAY_MS);
    expect(resolveCodexAccountForThread("bound", config)).toBe("spender");

    setCodexAccountCreditsAfterLimit(config, "spender", false);

    expect(resolveCodexAccountForThread("bound", config)).toBe("saver");
  });

  test("below 100% the default changes nothing", () => {
    const config = makeConfig();
    recordWeekly("spender", 99, Date.now() + DAY_MS);
    recordWeekly("saver", 40, Date.now() + DAY_MS);
    expect(resolveCodexAccountForThread("below-limit", config)).toBe("spender");
    expect(codexAccountBlockReason(config, "spender", Date.now())).toBeUndefined();
  });

  test("an elapsed reset releases the account without a new observation", () => {
    // A held account receives no traffic, so nothing else would ever replace the 100% reading.
    const config = makeConfig();
    recordWeekly("spender", 100, Date.now() - 60_000);
    recordWeekly("saver", 40, Date.now() + DAY_MS);
    expect(resolveCodexAccountForThread("after-reset", config)).toBe("spender");
  });

  test("a full reading without a reset time does not hold the account", () => {
    const config = makeConfig();
    recordWeekly("spender", 100);
    recordWeekly("saver", 40, Date.now() + DAY_MS);
    expect(resolveCodexAccountForThread("no-reset", config)).toBe("spender");
  });

  test("automatic routing finds no account rather than spend credits on the last one", () => {
    const config = makeConfig({
      codexAccounts: [{ id: "spender", email: "spender@test", isMain: false, plan: "pro" }],
    } as Partial<OcxConfig>);
    recordWeekly("spender", 100, Date.now() + DAY_MS);
    expect(pickLowestUsageCodexAccount(config)).toBeNull();
    expect(resolveCodexAccountForThread("last-account", config)).toBeNull();
    expect(previewCodexAccountForRequest("last-account", config)).toBeNull();
  });

  test("only the accounts allowed to use credits are stored, the main login included", () => {
    const config = makeConfig();
    setCodexAccountCreditsAfterLimit(config, "spender", true);
    setCodexAccountCreditsAfterLimit(config, "__main__", true);
    expect(config.creditCodexAccountIds).toEqual(["spender", "__main__"]);
    expect(codexAccountUsesCreditsAfterLimit(config, "__main__")).toBe(true);
    expect(codexAccountUsesCreditsAfterLimit(config, "saver")).toBe(false);
    forgetCodexAccountCreditUse(config, "spender");
    expect(config.creditCodexAccountIds).toEqual(["__main__"]);
    setCodexAccountCreditsAfterLimit(config, "__main__", false);
    expect(config.creditCodexAccountIds).toBeUndefined();
  });

  test("the global switch lists every given account and clears them all", () => {
    const config = makeConfig();
    setAllCodexAccountsCreditsAfterLimit(config, ["__main__", "spender", "saver"], true);
    expect(config.creditCodexAccountIds).toEqual(["__main__", "spender", "saver"]);
    setAllCodexAccountsCreditsAfterLimit(config, ["__main__", "spender", "saver"], false);
    expect(config.creditCodexAccountIds).toBeUndefined();
  });

  describe("which windows count as full", () => {
    const now = Date.UTC(2026, 9, 2, 12);
    const future = now + DAY_MS;

    test("the weekly window, with its reset in milliseconds or seconds", () => {
      expect(isCodexUsageLimitReached({ weeklyPercent: 100, weeklyResetAt: future, updatedAt: now }, "pro", now)).toBe(true);
      expect(isCodexUsageLimitReached({ weeklyPercent: 100, weeklyResetAt: Math.floor(future / 1000), updatedAt: now }, "pro", now)).toBe(true);
      expect(isCodexUsageLimitReached({ weeklyPercent: 100, weeklyResetAt: now - 1, updatedAt: now }, "pro", now)).toBe(false);
    });

    test("a thirty-day plan reads its monthly window and ignores a weekly one", () => {
      expect(isCodexUsageLimitReached({ weeklyPercent: 100, weeklyResetAt: future, monthlyPercent: 50, monthlyResetAt: future, updatedAt: now }, "free", now)).toBe(false);
      expect(isCodexUsageLimitReached({ monthlyPercent: 100, monthlyResetAt: future, updatedAt: now }, "free", now)).toBe(true);
    });

    test("a full burst window counts while its reset is ahead", () => {
      expect(isCodexUsageLimitReached({ weeklyPercent: 20, weeklyResetAt: future, shortPercent: 100, shortResetAt: now + 60_000, updatedAt: now }, "pro", now)).toBe(true);
      expect(isCodexUsageLimitReached({ weeklyPercent: 20, weeklyResetAt: future, shortPercent: 100, shortResetAt: now - 60_000, updatedAt: now }, "pro", now)).toBe(false);
    });

    test("no quota is not a full window", () => {
      expect(isCodexUsageLimitReached(null, "pro", now)).toBe(false);
    });
  });

  describe("PUT /api/codex-auth/accounts/credits", () => {
    test("turns credits on and off for a pool account and applies to the next request", async () => {
      const config = makeConfig();
      recordWeekly("spender", 100, Date.now() + DAY_MS);
      recordWeekly("saver", 40, Date.now() + DAY_MS);

      const on = await putCredits(config, { id: "spender", creditsAfterLimit: true });
      expect(on.status).toBe(200);
      expect(await on.json()).toEqual({ ok: true, id: "spender", creditsAfterLimit: true });
      expect(config.creditCodexAccountIds).toEqual(["spender"]);
      expect(resolveCodexAccountForThread("api", config)).toBe("spender");

      const off = await putCredits(config, { id: "spender", creditsAfterLimit: false });
      expect(off.status).toBe(200);
      expect(config.creditCodexAccountIds).toBeUndefined();
      expect(resolveCodexAccountForThread("api", config)).toBe("saver");
    });

    test("accepts the main login", async () => {
      const config = makeConfig();
      const resp = await putCredits(config, { id: "__main__", creditsAfterLimit: true });
      expect(resp.status).toBe(200);
      expect(config.creditCodexAccountIds).toEqual(["__main__"]);
    });

    test("all: true lists the main login and every pool account, all: false clears the list", async () => {
      const config = makeConfig();
      const on = await putCredits(config, { all: true });
      expect(on.status).toBe(200);
      expect(await on.json()).toEqual({ ok: true, all: true, ids: ["__main__", "spender", "saver"] });
      expect(config.creditCodexAccountIds).toEqual(["__main__", "spender", "saver"]);

      const off = await putCredits(config, { all: false });
      expect(off.status).toBe(200);
      expect(config.creditCodexAccountIds).toBeUndefined();
      expect((await putCredits(config, { all: "yes" })).status).toBe(400);
    });

    test("refuses bad ids, unknown accounts and non-boolean values", async () => {
      const config = makeConfig();
      expect((await putCredits(config, { id: "../etc", creditsAfterLimit: true })).status).toBe(400);
      expect((await putCredits(config, { id: "missing", creditsAfterLimit: true })).status).toBe(404);
      expect((await putCredits(config, { id: "spender", creditsAfterLimit: "yes" })).status).toBe(400);
      expect((await putCredits(config, null)).status).toBe(400);
      expect((await putCredits(config, [true])).status).toBe(400);
      expect(config.creditCodexAccountIds).toBeUndefined();
    });
  });
});

describe("creditCodexAccountIds in the config file", () => {
  test("a malformed list on load degrades to no account spending, without failing the parse", () => {
    expect(configSchema.shape.creditCodexAccountIds.parse(["bad id!"])).toBeUndefined();
    expect(configSchema.shape.creditCodexAccountIds.parse("side-pro")).toBeUndefined();
    expect(configSchema.shape.creditCodexAccountIds.parse(["side-pro", "__main__"])).toEqual(["side-pro", "__main__"]);
  });

  test("a write with a malformed list is rejected", () => {
    const result = validateConfigCandidate({ ...makeConfig(), creditCodexAccountIds: ["bad id!"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("creditCodexAccountIds");
    const valid = validateConfigCandidate({ ...makeConfig(), creditCodexAccountIds: ["spender"] });
    expect(valid.ok ? "" : valid.error).not.toContain("creditCodexAccountIds");
  });
});
