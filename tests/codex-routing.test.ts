import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  computeCodexUsageScore,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../src/codex-routing";
import { saveCodexAccountCredential } from "../src/codex-account-store";
import { clearAccountQuota, handleCodexAuthAPI, parseUsageQuota, updateAccountQuota } from "../src/codex-auth-api";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-routing-test");
let previousOpencodexHome: string | undefined;

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
    expiresAt: Date.now() + 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

describe("codex routing", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    saveTestCredential("a");
    saveTestCredential("b");
  });

  afterEach(() => {
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("usage score uses the hottest known quota window", () => {
    expect(computeCodexUsageScore({ weeklyPercent: 15, fiveHourPercent: 81 })).toBe(81);
    expect(computeCodexUsageScore({ weeklyPercent: 15, fiveHourPercent: 20, monthlyPercent: 91 })).toBe(91);
    expect(computeCodexUsageScore({ weeklyPercent: 15 })).toBe(15);
  });

  test("5h threshold breach switches new threads even when weekly is low", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10, 85);
    updateAccountQuota("b", 20, 5);
    expect(resolveCodexAccountForThread("new-thread", config)).toBe("b");
  });

  test("three consecutive non-200 responses fail over future new threads", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10, 5);
    updateAccountQuota("b", 20, 10);
    expect(resolveCodexAccountForThread("existing", config)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(resolveCodexAccountForThread("existing", config)).toBe("a");
    expect(resolveCodexAccountForThread("next", config)).toBe("b");
  });

  test("2xx responses reset the failure streak", () => {
    const config = makeConfig();
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 200);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(resolveCodexAccountForThread("next", config)).toBe("a");
  });

  test("failure failover can be disabled independently from quota switching", () => {
    const config = makeConfig({ upstreamFailoverThreshold: 0 });
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(resolveCodexAccountForThread("next", config)).toBe("a");
  });

  test("failover threshold API validates and mutates runtime config", async () => {
    const config = makeConfig();
    const badReq = new Request("http://localhost/api/codex-auth/failover", {
      method: "PUT",
      body: JSON.stringify({ threshold: 21 }),
    });
    expect((await handleCodexAuthAPI(badReq, new URL(badReq.url), config))!.status).toBe(400);
    const req = new Request("http://localhost/api/codex-auth/failover", {
      method: "PUT",
      body: JSON.stringify({ threshold: 4 }),
    });
    expect((await handleCodexAuthAPI(req, new URL(req.url), config))!.status).toBe(200);
    expect(config.upstreamFailoverThreshold).toBe(4);
  });

  test("WHAM tertiary window parses as optional 30d quota", () => {
    const quota = parseUsageQuota({
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1 },
        secondary_window: { used_percent: 20, reset_at: 2 },
        tertiary_window: { used_percent: 30, reset_at: 3 },
      },
    });
    expect(quota).toMatchObject({
      fiveHourPercent: 10,
      weeklyPercent: 20,
      monthlyPercent: 30,
      fiveHourResetAt: 1,
      weeklyResetAt: 2,
      monthlyResetAt: 3,
    });
  });
});
