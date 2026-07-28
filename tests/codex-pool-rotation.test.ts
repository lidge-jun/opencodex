import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  clearPoolRotationState,
  notePoolRotationSuccess,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
} from "../src/codex/pool-rotation";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  previewCodexAccountForRequest,
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

const THREE_ACCOUNT_IDS = ["a", "b", "c"] as const;

function countPicks(picks: Array<string | null>, ids: readonly string[]): Record<string, number> {
  const counts = Object.fromEntries(ids.map(id => [id, 0]));
  for (const pick of picks) {
    if (pick && pick in counts) counts[pick]! += 1;
  }
  return counts;
}

function shareSpreadPercent(counts: Record<string, number>, total: number): number {
  const shares = Object.values(counts).map(n => (n / total) * 100);
  return Math.max(...shares) - Math.min(...shares);
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

  test("peek matches next pick without advancing ring weights", () => {
    const ids = ["a", "b", "c"];
    const peek1 = peekRoundRobinAccount("codex", ids, 1);
    const peek2 = peekRoundRobinAccount("codex", ids, 1);
    expect(peek2).toBe(peek1);
    const picked = pickRoundRobinAccount("codex", ids, 1);
    expect(picked).toBe(peek1);
    const peekAfter = peekRoundRobinAccount("codex", ids, 1);
    expect(peekAfter).not.toBe(picked);
    expect(pickRoundRobinAccount("codex", ids, 1)).toBe(peekAfter);
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

  test(
    "round-robin histogram: 99 unbound picks at stickyLimit 1 split 33/33/33",
    () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "round-robin",
        accountPoolStickyLimit: 1,
      });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 10);
      updateAccountQuota("c", 10);

      const picks = Array.from({ length: 99 }, () => resolveCodexAccountForThread(null, config));
      const counts = countPicks(picks, THREE_ACCOUNT_IDS);
      expect(counts).toEqual({ a: 33, b: 33, c: 33 });
      expect(shareSpreadPercent(counts, 99)).toBe(0);
    },
    20_000,
  );

  test("quota baseline histogram: 100 unbound picks stay on active account", () => {
    const config = makeThreeAccountConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    const picks = Array.from({ length: 100 }, () => resolveCodexAccountForThread(null, config));
    const counts = countPicks(picks, THREE_ACCOUNT_IDS);
    expect(counts).toEqual({ a: 100, b: 0, c: 0 });
    expect(shareSpreadPercent(counts, 100)).toBe(100);
  });

  test("round-robin affinity zero-flip on bound thread reuse", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "round-robin" });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    const pinned = resolveCodexAccountForThread("thread-zero-flip", config);
    expect(pinned).toBeTruthy();
    config.activeCodexAccountId = pinned === "a" ? "b" : "a";

    let flips = 0;
    let previous = pinned;
    for (let i = 0; i < 50; i++) {
      const next = resolveCodexAccountForThread("thread-zero-flip", config);
      if (next !== previous) flips += 1;
      previous = next;
    }
    expect(flips).toBe(0);
    expect(previous).toBe(pinned);
  });

  test("fill-first keeps active account for unbound sessions under threshold", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "fill-first",
      activeCodexAccountId: "a",
    });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    const picks = Array.from({ length: 10 }, () => resolveCodexAccountForThread(null, config));
    expect(picks.every(pick => pick === "a")).toBe(true);
  });

  test("fill-first advances when active crosses threshold", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "fill-first",
      activeCodexAccountId: "a",
      autoSwitchThreshold: 80,
    });
    updateAccountQuota("a", 90);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    const pick = resolveCodexAccountForThread(null, config);
    expect(pick).not.toBe("a");
    expect(THREE_ACCOUNT_IDS).toContain(pick);
  });

  test("RR preview(null) matches next resolve(null) without advancing until resolve", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "round-robin" });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    const preview1 = previewCodexAccountForRequest(null, config);
    const preview2 = previewCodexAccountForRequest(null, config);
    expect(preview2).toBe(preview1);

    const resolve1 = resolveCodexAccountForThread(null, config);
    expect(resolve1).toBe(preview1);

    const previewAfter = previewCodexAccountForRequest(null, config);
    const resolve2 = resolveCodexAccountForThread(null, config);
    expect(resolve2).toBe(previewAfter);
    expect(resolve2).not.toBe(resolve1);
  });

  test("invalid on-disk strategy defaults to quota like Anthropic", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "weighted" as OcxConfig["accountPoolStrategy"],
    });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    const picks = Array.from({ length: 5 }, () => resolveCodexAccountForThread(null, config));
    expect(picks.every(pick => pick === "a")).toBe(true);
  });
});
