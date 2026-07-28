import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  clearPoolRotationState,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
} from "../src/codex/pool-rotation";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-pool-rotation-test");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [],
    activeCodexAccountId: undefined,
    autoSwitchThreshold: 80,
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

function makeThreeAccountConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  const ids = ["a", "b", "c"];
  for (const id of ids) saveTestCredential(id);
  return makeConfig({
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, isMain: false })),
    ...overrides,
  });
}

describe("pickRoundRobinAccount", () => {
  beforeEach(() => clearPoolRotationState());

  test("spreads successive picks across eligible accounts", () => {
    const ids = ["a", "b", "c"];
    const picks = [
      pickRoundRobinAccount("codex", ids, 1),
      pickRoundRobinAccount("codex", ids, 1),
      pickRoundRobinAccount("codex", ids, 1),
    ];
    expect(new Set(picks).size).toBe(3);
  });

  test("stickyLimit holds the same account across success batches", () => {
    const ids = ["a", "b"];
    const first = pickRoundRobinAccount("codex", ids, 2);
    notePoolRotationSuccess("codex", first!, 2);
    const second = pickRoundRobinAccount("codex", ids, 2);
    expect(second).toBe(first);
    notePoolRotationSuccess("codex", first!, 2);
    const third = pickRoundRobinAccount("codex", ids, 2);
    expect(third).not.toBe(first);
  });

  test("skips ids not in the eligible list mid-ring", () => {
    const a = pickRoundRobinAccount("codex", ["a", "b"], 1);
    expect(a).toBeTruthy();
    const next = pickRoundRobinAccount("codex", ["b"], 1);
    expect(next).toBe("b");
  });
});

describe("accountPoolStrategy new-session routing", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearPoolRotationState();
  });

  afterEach(() => {
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearPoolRotationState();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("round-robin strategy rotates unbound new sessions", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "round-robin" });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    const picks = [
      resolveCodexAccountForThread(null, config),
      resolveCodexAccountForThread(null, config),
      resolveCodexAccountForThread(null, config),
    ];
    expect(new Set(picks).size).toBe(3);
  });

  test("affinity still wins over round-robin", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "round-robin" });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    expect(resolveCodexAccountForThread("T", config)).toBe("a");
    config.activeCodexAccountId = "b";
    expect(resolveCodexAccountForThread("T", config)).toBe("a");
    expect(resolveCodexAccountForThread("T", config)).toBe("a");
  });

  test("omitted strategy preserves quota / active behaviour", () => {
    const config = makeThreeAccountConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    expect(resolveCodexAccountForThread(null, config)).toBe("a");
    expect(resolveCodexAccountForThread("new-thread", config)).toBe("a");
  });
});
