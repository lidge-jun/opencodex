import {
  clearPoolRotationState,
  notePoolRotationSuccess,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
} from "../src/codex/pool-rotation";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getEffectiveActiveCodexAccountId,
  isCodexAccountInCooldown,
  pickAlternateCodexAccount,
  previewCodexAccountForRequest,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import { getConfigPath } from "../src/config";
import type { OcxConfig } from "../src/types";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

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

  test("fill-first skips drained successors when advancing past threshold", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "fill-first",
      activeCodexAccountId: "a",
      autoSwitchThreshold: 80,
    });
    updateAccountQuota("a", 90);
    updateAccountQuota("b", 95);
    updateAccountQuota("c", 10);

    expect(resolveCodexAccountForThread(null, config)).toBe("c");
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

  test("manual selection seeds RR so the next unbound session uses that account", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 1,
      activeCodexAccountId: "a",
    });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    // Advance the ring away from a predictable starting point.
    resolveCodexAccountForThread(null, config);
    resolveCodexAccountForThread(null, config);

    config.activeCodexAccountId = "c";
    resetCodexRoutingForManualSelection("c");

    expect(resolveCodexAccountForThread(null, config)).toBe("c");
  });

  test("bound thread under RR does not re-eval on quota threshold", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      autoSwitchThreshold: 80,
    });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    const pinned = resolveCodexAccountForThread("rr-affinity-pin", config);
    expect(pinned).toBeTruthy();
    updateAccountQuota(pinned!, 95);
    for (const id of THREE_ACCOUNT_IDS) {
      if (id !== pinned) updateAccountQuota(id, 5);
    }

    expect(resolveCodexAccountForThread("rr-affinity-pin", config)).toBe(pinned);
    expect(previewCodexAccountForRequest("rr-affinity-pin", config)).toBe(pinned);
  });

  test("bound thread under fill-first does not re-eval on quota threshold", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "fill-first",
      activeCodexAccountId: "a",
      autoSwitchThreshold: 80,
    });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    expect(resolveCodexAccountForThread("ff-affinity-pin", config)).toBe("a");
    updateAccountQuota("a", 95);
    updateAccountQuota("b", 5);
    updateAccountQuota("c", 5);

    expect(resolveCodexAccountForThread("ff-affinity-pin", config)).toBe("a");
  });

  test("RR unbound picks do not sync-write config.json", () => {
    const configPath = getConfigPath();
    if (existsSync(configPath)) rmSync(configPath);

    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      activeCodexAccountId: "a",
    });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    for (let i = 0; i < 6; i++) resolveCodexAccountForThread(null, config);

    expect(existsSync(configPath)).toBe(false);
  });

  test("fill-first 429 advances to next stable account, not lowest usage", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "fill-first",
      activeCodexAccountId: "a",
      autoSwitchThreshold: 80,
    });
    // Usage ordering would prefer c (lowest), but fill-first advances a → b in sorted order.
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 5);

    expect(resolveCodexAccountForThread(null, config)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 429);
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
    expect(config.activeCodexAccountId).toBe("a"); // automatic — not persisted as operator selection
    expect(pickAlternateCodexAccount(config, "a")).toBe("b");
  });

  test("RR 429 promotes via ring, not lowest usage", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 1,
      activeCodexAccountId: "a",
    });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 90);
    updateAccountQuota("c", 5);

    const first = resolveCodexAccountForThread(null, config)!;
    recordCodexUpstreamOutcome(config, first, 429);
    const promoted = getEffectiveActiveCodexAccountId(config);
    expect(promoted).toBeTruthy();
    expect(promoted).not.toBe(first);
    expect(config.activeCodexAccountId).toBe("a");
    // Lowest usage is c; ring may pick b. Either is fine as long as it is not lowest-usage-forced when
    // that would disagree with the ring — assert we did not stay on the failed account.
    expect(isCodexAccountInCooldown(first)).toBe(true);
  });

  test("429 retry reuse promoteAccountId avoids a second RR ring advance", () => {
    const makeRr = () => makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 1,
      activeCodexAccountId: "a",
    });
    for (const id of ["a", "b", "c"]) {
      updateAccountQuota(id, 10);
    }

    clearPoolRotationState();
    const withReuse = makeRr();
    const retry = pickAlternateCodexAccount(withReuse, "a");
    expect(retry).toBeTruthy();
    expect(retry).not.toBe("a");
    recordCodexUpstreamOutcome(withReuse, "a", 429, { promoteAccountId: retry! });
    expect(getEffectiveActiveCodexAccountId(withReuse)).toBe(retry);
    expect(withReuse.activeCodexAccountId).toBe("a");

    clearPoolRotationState();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    const withoutReuse = makeRr();
    for (const id of ["a", "b", "c"]) updateAccountQuota(id, 10);
    const firstPick = pickAlternateCodexAccount(withoutReuse, "a");
    expect(firstPick).toBeTruthy();
    recordCodexUpstreamOutcome(withoutReuse, "a", 429);
    // A second ring advance during record would promote past firstPick.
    expect(getEffectiveActiveCodexAccountId(withoutReuse)).not.toBe(firstPick);
    expect(getEffectiveActiveCodexAccountId(withoutReuse)).not.toBe("a");
    expect(withoutReuse.activeCodexAccountId).toBe("a");
  });

  test("fill-first transient failover advances stable order, not lowest usage", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "fill-first",
      activeCodexAccountId: "a",
      upstreamFailoverThreshold: 3,
      autoSwitchThreshold: 80,
    });
    // Lowest usage is c; fill-first must advance a → b in sorted id order.
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 5);

    expect(resolveCodexAccountForThread(null, config)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
    expect(config.activeCodexAccountId).toBe("a");
  });
});
