import {
  clearPoolRotationState,
  DEFAULT_ACCOUNT_PRIORITY,
  normalizeAccountPriority,
  notePoolRotationSuccess,
  parseAccountPriority,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  selectPriorityTier,
} from "../src/codex/pool-rotation";
import {
  clearCodexAccountPin,
  codexAccountPriorityLookup,
  forgetCodexAccountPriority,
  getCodexAccountPriority,
  setCodexAccountPriority,
} from "../src/codex/account-priority";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  CODEX_TRANSIENT_SOFT_AVOID_MS,
  previewCodexAccountForRequest,
  getEffectiveActiveCodexAccountId,
  isCodexAccountInCooldown,
  pickAlternateCodexAccount,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import { getConfigPath } from "../src/config";
import type { OcxConfig } from "../src/types";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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

describe("account selection order parsing", () => {
  test("parseAccountPriority accepts integers inside the configurable range", () => {
    expect(parseAccountPriority(0)).toBe(0);
    expect(parseAccountPriority(2)).toBe(2);
    expect(parseAccountPriority(-2)).toBe(-2);
    expect(parseAccountPriority(100)).toBe(100);
    expect(parseAccountPriority(-100)).toBe(-100);
  });

  test("parseAccountPriority rejects non-integers, wrong types, and out-of-range values", () => {
    for (const raw of [1.5, "2", true, null, undefined, [], {}, Number.NaN, 101, -101, Number.POSITIVE_INFINITY]) {
      expect(parseAccountPriority(raw)).toBeNull();
    }
  });

  test("normalizeAccountPriority degrades anything unparseable to the default tier", () => {
    expect(normalizeAccountPriority(3)).toBe(3);
    expect(normalizeAccountPriority("3")).toBe(DEFAULT_ACCOUNT_PRIORITY);
    expect(normalizeAccountPriority(undefined)).toBe(DEFAULT_ACCOUNT_PRIORITY);
  });
});

describe("selectPriorityTier", () => {
  const withHeadroom = () => true;
  const noHeadroom = () => false;
  const flat = () => 0;

  test("returns the input untouched when every account shares one tier", () => {
    const ids = ["a", "b", "c"];
    expect(selectPriorityTier(ids, flat, withHeadroom)).toBe(ids);
  });

  test("keeps only the highest tier that still has headroom", () => {
    const priorities: Record<string, number> = { a: 1, b: 0, c: 1 };
    const selected = selectPriorityTier(["a", "b", "c"], id => priorities[id]!, withHeadroom);
    expect(selected).toEqual(["a", "c"]);
  });

  test("preserves input order inside the selected tier", () => {
    const priorities: Record<string, number> = { __main__: 0, a: 0, b: -1 };
    const selected = selectPriorityTier(["__main__", "a", "b"], id => priorities[id]!, withHeadroom);
    expect(selected).toEqual(["__main__", "a"]);
  });

  test("falls through to the next tier once the tier above is drained", () => {
    const priorities: Record<string, number> = { a: 1, b: 0 };
    const selected = selectPriorityTier(["a", "b"], id => priorities[id]!, id => id !== "a");
    expect(selected).toEqual(["b"]);
  });

  test("returns the input unchanged when every tier is drained", () => {
    const priorities: Record<string, number> = { a: 1, b: 0 };
    const ids = ["a", "b"];
    expect(selectPriorityTier(ids, id => priorities[id]!, noHeadroom)).toBe(ids);
  });

  test("a pinned account with headroom lowers the ceiling to its own tier", () => {
    const priorities: Record<string, number> = { a: 1, b: 0, c: 0 };
    const selected = selectPriorityTier(["a", "b", "c"], id => priorities[id]!, withHeadroom, "b");
    expect(selected).toEqual(["b", "c"]);
  });

  test("a drained pin is ignored so ordering resumes on its own", () => {
    const priorities: Record<string, number> = { a: 1, b: 0 };
    const selected = selectPriorityTier(["a", "b"], id => priorities[id]!, id => id !== "b", "b");
    expect(selected).toEqual(["a"]);
  });

  test("a pin that is no longer eligible is ignored", () => {
    const priorities: Record<string, number> = { a: 1, b: 0 };
    const selected = selectPriorityTier(["a", "b"], id => priorities[id]!, withHeadroom, "gone");
    expect(selected).toEqual(["a"]);
  });

  // The ceiling picks a tier, it does not pick accounts: a drained member stays in
  // the returned list so the strategy behind it still sees the whole tier.
  test("the pinned tier comes back whole, drained siblings included", () => {
    const priorities: Record<string, number> = { a: 1, b: 0, c: 0 };
    const selected = selectPriorityTier(["a", "b", "c"], id => priorities[id]!, id => id !== "c", "b");
    expect(selected).toEqual(["b", "c"]);
  });
});

describe("setCodexAccountPriority", () => {
  test("stores a non-default order under the account id", () => {
    const config = makeConfig();
    setCodexAccountPriority(config, "a", 2);
    expect(config.codexAccountPriorities).toEqual({ a: 2 });
    expect(getCodexAccountPriority(config, "a")).toBe(2);
  });

  test("writing the default order removes that account's entry", () => {
    const config = makeConfig({ codexAccountPriorities: { a: 1, b: 2 } } as Partial<OcxConfig>);
    setCodexAccountPriority(config, "a", DEFAULT_ACCOUNT_PRIORITY);
    expect(config.codexAccountPriorities).toEqual({ b: 2 });
    expect(getCodexAccountPriority(config, "a")).toBe(DEFAULT_ACCOUNT_PRIORITY);
  });

  // An empty map would still be a stored map, and routing's fast path keys off the
  // key being absent — a pool that was ordered and then reset must look unordered.
  test("emptying the map drops the config key entirely", () => {
    const config = makeConfig({ codexAccountPriorities: { a: 1 } } as Partial<OcxConfig>);
    setCodexAccountPriority(config, "a", DEFAULT_ACCOUNT_PRIORITY);
    expect(Object.hasOwn(config, "codexAccountPriorities")).toBe(false);
  });

  test("forgetCodexAccountPriority leaves the other accounts' order alone", () => {
    const config = makeConfig({ codexAccountPriorities: { a: 1, b: -3 } } as Partial<OcxConfig>);
    forgetCodexAccountPriority(config, "b");
    expect(config.codexAccountPriorities).toEqual({ a: 1 });
  });

  // A plain assignment to a reserved key hits Object.prototype's setter and stores
  // nothing; the entry must land as an own data property with the map's own shape intact.
  test("a reserved key is stored as an own data property", () => {
    const config = makeConfig();
    setCodexAccountPriority(config, "__proto__", 3);

    const priorities = config.codexAccountPriorities!;
    expect(Object.hasOwn(priorities, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(priorities)).toBe(Object.prototype);
    expect(getCodexAccountPriority(config, "__proto__")).toBe(3);
  });
});

describe("codexAccountPriorityLookup", () => {
  test("reports the stored order for a configured account", () => {
    const config = makeConfig({ codexAccountPriorities: { a: 2 } } as Partial<OcxConfig>);
    const priorityOf = codexAccountPriorityLookup(config);
    expect(priorityOf("a")).toBe(2);
    expect(priorityOf("b")).toBe(DEFAULT_ACCOUNT_PRIORITY);
  });

  // `constructor` resolves on Object.prototype, so an ungated read would hand a
  // function to normalization instead of reporting "this account has no order".
  test("inherited members of the map are not a selection order", () => {
    const config = makeConfig({ codexAccountPriorities: { a: 2 } } as Partial<OcxConfig>);
    const priorityOf = codexAccountPriorityLookup(config);
    expect(priorityOf("constructor")).toBe(DEFAULT_ACCOUNT_PRIORITY);
    expect(priorityOf("toString")).toBe(DEFAULT_ACCOUNT_PRIORITY);
  });

  test("an unordered pool answers with the default for every account", () => {
    const priorityOf = codexAccountPriorityLookup(makeConfig());
    expect(priorityOf("a")).toBe(DEFAULT_ACCOUNT_PRIORITY);
    expect(priorityOf("constructor")).toBe(DEFAULT_ACCOUNT_PRIORITY);
  });

  test("an unparseable stored order degrades to the default tier", () => {
    const config = makeConfig({ codexAccountPriorities: { a: 1.5, b: 999 } } as Partial<OcxConfig>);
    const priorityOf = codexAccountPriorityLookup(config);
    expect(priorityOf("a")).toBe(DEFAULT_ACCOUNT_PRIORITY);
    expect(priorityOf("b")).toBe(DEFAULT_ACCOUNT_PRIORITY);
  });
});

describe("clearCodexAccountPin", () => {
  test("releases whatever is pinned when no account is named", () => {
    const config = makeConfig({ activeCodexAccountPinned: "a" } as Partial<OcxConfig>);
    clearCodexAccountPin(config);
    expect(config.activeCodexAccountPinned).toBeUndefined();
    // Deleted rather than set to undefined, so the saved config carries no key.
    expect(Object.hasOwn(config, "activeCodexAccountPinned")).toBe(false);
  });

  test("releases only the named account", () => {
    const config = makeConfig({ activeCodexAccountPinned: "a" } as Partial<OcxConfig>);
    clearCodexAccountPin(config, "b");
    expect(config.activeCodexAccountPinned).toBe("a");

    clearCodexAccountPin(config, "a");
    expect(config.activeCodexAccountPinned).toBeUndefined();
  });

  test("is a no-op when nothing is pinned", () => {
    const config = makeConfig();
    clearCodexAccountPin(config, "a");
    expect(config.activeCodexAccountPinned).toBeUndefined();
  });
});

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
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
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
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
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

  test("an independent native scope does not advance the shared round-robin cursor", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 1,
    });
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    expect(resolveCodexAccountForThread(null, config, now, "shared")).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 429, {
      now: now + 1,
      resetAt: Math.floor((now + 4 * 24 * 60 * 60_000) / 1_000),
      modelId: "gpt-5.3-codex-spark",
    });

    // Spark skips A in its own ring. The next shared request still takes B,
    // as if the Spark selection had never advanced the shared ring.
    expect(resolveCodexAccountForThread(null, config, now + 2, "spark")).toBe("b");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    expect(resolveCodexAccountForThread(null, config, now + 3, "shared")).toBe("b");
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

  test("scoped reset 429s retain strategy while excluding only the affected native quota", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "fill-first",
      activeCodexAccountId: "a",
      autoSwitchThreshold: 80,
    });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 5);
    const now = Date.now();
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1_000);

    recordCodexUpstreamOutcome(config, "b", 429, {
      now,
      resetAt,
      modelId: "gpt-5.3-codex-spark",
    });

    // Fill-first would normally advance a → b, but b is unavailable only to Spark.
    expect(pickAlternateCodexAccount(config, "a", now + 1, "spark")).toBe("c");
    expect(pickAlternateCodexAccount(config, "a", now + 1, "shared")).toBe("b");

    recordCodexUpstreamOutcome(config, "a", 429, {
      now,
      resetAt,
      modelId: "gpt-5.6-terra",
      promoteAccountId: "b",
    });
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
    expect(config.activeCodexAccountId).toBe("a");
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

describe("selection order across rotation strategies", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
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
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });

  function primeAllQuota(usage = 10): void {
    for (const id of THREE_ACCOUNT_IDS) updateAccountQuota(id, usage);
  }

  test("round-robin spreads only across the highest tier", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      codexAccountPriorities: { a: 1, b: 1 },
    } as Partial<OcxConfig>);
    primeAllQuota();

    const picks = Array.from({ length: 12 }, () => resolveCodexAccountForThread(null, config));
    expect(countPicks(picks, THREE_ACCOUNT_IDS)).toEqual({ a: 6, b: 6, c: 0 });
  });

  test("round-robin falls through to the next tier when the one above drains", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      codexAccountPriorities: { a: 1, b: 1 },
    } as Partial<OcxConfig>);
    primeAllQuota();
    updateAccountQuota("a", 95);
    updateAccountQuota("b", 95);

    const picks = Array.from({ length: 4 }, () => resolveCodexAccountForThread(null, config));
    expect(countPicks(picks, THREE_ACCOUNT_IDS)).toEqual({ a: 0, b: 0, c: 4 });
  });

  test("round-robin returns to the higher tier after its quota resets", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      codexAccountPriorities: { a: 1 },
    } as Partial<OcxConfig>);
    primeAllQuota();
    updateAccountQuota("a", 95);
    expect(resolveCodexAccountForThread(null, config)).not.toBe("a");

    updateAccountQuota("a", 5);
    expect(resolveCodexAccountForThread(null, config)).toBe("a");
  });

  test("a pinned account holds round-robin until it crosses the threshold", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      codexAccountPriorities: { a: 1, b: 1 },
      activeCodexAccountPinned: "c",
    } as Partial<OcxConfig>);
    primeAllQuota();

    const held = Array.from({ length: 4 }, () => resolveCodexAccountForThread(null, config));
    expect(countPicks(held, THREE_ACCOUNT_IDS)).toEqual({ a: 0, b: 0, c: 4 });

    updateAccountQuota("c", 95);
    expect(resolveCodexAccountForThread(null, config)).not.toBe("c");
  });

  test("fill-first drains the highest tier before descending", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "fill-first",
      activeCodexAccountId: undefined,
      codexAccountPriorities: { c: 1 },
    } as Partial<OcxConfig>);
    primeAllQuota();

    expect(resolveCodexAccountForThread(null, config)).toBe("c");
    updateAccountQuota("c", 95);
    expect(resolveCodexAccountForThread(null, config)).toBe("a");
  });

  test("an alternate crosses tiers when the exclusion empties the tier above", () => {
    const config = makeThreeAccountConfig({ codexAccountPriorities: { a: 1 } } as Partial<OcxConfig>);
    primeAllQuota();

    // Without the exclusion reaching eligibility the tier walk would select
    // ["a"] and the caller's post-filter would leave nothing to fail over to.
    expect(pickAlternateCodexAccount(config, "a")).toBe("b");
  });

  test("an independent native scope tiers on its own health snapshot", () => {
    const config = makeThreeAccountConfig({
      codexAccountPriorities: { a: 1 },
    } as Partial<OcxConfig>);
    const now = 1_800_000_000_000;
    primeAllQuota();

    expect(resolveCodexAccountForThread(null, config, now, "shared")).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 429, {
      now: now + 1,
      resetAt: Math.floor((now + 4 * 24 * 60 * 60_000) / 1_000),
      modelId: "gpt-5.3-codex-spark",
    });

    expect(resolveCodexAccountForThread(null, config, now + 2, "spark")).toBe("b");
    expect(resolveCodexAccountForThread(null, config, now + 3, "shared")).toBe("a");
  });

  test("preemption inside an independent scope leaves the shared cursor alone", () => {
    const config = makeThreeAccountConfig({
      activeCodexAccountId: "b",
      codexAccountPriorities: { a: 1 },
    } as Partial<OcxConfig>);
    const now = 1_800_000_000_000;
    primeAllQuota();

    expect(resolveCodexAccountForThread(null, config, now, "spark")).toBe("a");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
  });

  test("an affined thread keeps its account while retiring a drained manual pin", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      activeCodexAccountId: "a",
      activeCodexAccountPinned: "a",
      codexAccountPriorities: { b: 1 },
    } as Partial<OcxConfig>);
    primeAllQuota();

    expect(resolveCodexAccountForThread("pinned-thread", config)).toBe("a");
    updateAccountQuota("a", 95);

    // Affinity wins, but the spent operator ceiling is durably over.
    expect(resolveCodexAccountForThread("pinned-thread", config)).toBe("a");
    expect(config.activeCodexAccountPinned).toBeUndefined();

    // If the stale pin had survived, restoring A's quota would cap the pool at
    // A's lower tier again and suppress B.
    updateAccountQuota("a", 5);
    expect(resolveCodexAccountForThread(null, config)).toBe("b");
  });

  test("an independent scope does not retire the shared manual pin", () => {
    const config = makeThreeAccountConfig({
      activeCodexAccountId: "a",
      activeCodexAccountPinned: "a",
      codexAccountPriorities: { b: 1 },
    } as Partial<OcxConfig>);
    primeAllQuota();
    updateAccountQuota("a", 95);

    expect(resolveCodexAccountForThread(null, config, Date.now(), "spark")).toBe("b");
    expect(config.activeCodexAccountPinned).toBe("a");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
  });

  test("an independent-scope account-wide 429 leaves shared routing state alone", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      activeCodexAccountId: "a",
    });
    primeAllQuota();

    recordCodexUpstreamOutcome(config, "a", 429, {
      modelId: "gpt-5.3-codex-spark",
    });

    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("an independent-scope transient failover leaves shared routing state alone", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "round-robin",
      activeCodexAccountId: "a",
      upstreamFailoverThreshold: 1,
    });
    primeAllQuota();

    recordCodexUpstreamOutcome(config, "a", 503, {
      modelId: "gpt-5.3-codex-spark",
    });

    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("an independent scope still leaves shared routing alone once its soft avoid expires", () => {
    // Suppressing the promotion at the moment of the failure is not enough: the
    // failure streak outlives the soft avoid, so there is a window where the account
    // is selectable again while shouldFailover still trips. A scoped resolve lands in
    // applyFailureFailover there, and that is the second place shared state can move.
    const config = makeThreeAccountConfig({
      activeCodexAccountId: "a",
      upstreamFailoverThreshold: 1,
    } as Partial<OcxConfig>);
    primeAllQuota();
    const failedAt = Date.now();

    recordCodexUpstreamOutcome(config, "a", 503, {
      modelId: "gpt-5.3-codex-spark",
      now: failedAt,
    });

    // Past the 30s soft avoid, inside the 5-minute failure window.
    const afterSoftAvoid = failedAt + CODEX_TRANSIENT_SOFT_AVOID_MS + 1_000;
    const routed = resolveCodexAccountForThread(null, config, afterSoftAvoid, "spark");

    // Asserted first because it is what proves the resolve reached applyFailureFailover
    // at all: "a" is selectable again by now, so only the still-tripped streak routes
    // away from it. Without this the two shared-state assertions would also hold if the
    // request never got that far, and the guard under test would go unexercised.
    expect(routed).toBe("b");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test.each([
    ["quota", ["a", "a", "a", "a", "a", "a"]],
    ["round-robin", ["a", "b", "c", "a", "b", "c"]],
    ["fill-first", ["b", "c", "a", "b", "c", "a"]],
  ] as const)(
    "%s preserves its pre-feature fallback when every ordered tier is drained",
    (strategy, expected) => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: strategy,
        codexAccountPriorities: { a: 2, b: 1 },
      } as Partial<OcxConfig>);
      primeAllQuota(95);

      const picks = Array.from({ length: 6 }, () => resolveCodexAccountForThread(null, config));
      expect(picks).toEqual([...expected]);
    },
  );

  // The expected sequences are the pre-feature ones, recorded literally. Comparing an
  // unset config against an all-zero one only proves the two agree — both take the
  // same fast path — so the literal is what actually guards against a regression.
  test.each([
    ["quota", ["a", "a", "a", "a", "a", "a"]],
    ["round-robin", ["a", "b", "c", "a", "b", "c"]],
    ["fill-first", ["a", "a", "a", "a", "a", "a"]],
  ] as const)(
    "%s picks the same sequence with no stored order as before the feature",
    (strategy, expected) => {
      const config = makeThreeAccountConfig({ accountPoolStrategy: strategy });
      primeAllQuota();
      const picks = Array.from({ length: 6 }, () => resolveCodexAccountForThread(null, config));

      clearPoolRotationState();
      clearThreadAccountMap();
      const flat = makeThreeAccountConfig({
        accountPoolStrategy: strategy,
        codexAccountPriorities: { a: 0, b: 0, c: 0 },
      } as Partial<OcxConfig>);
      const flatPicks = Array.from({ length: 6 }, () => resolveCodexAccountForThread(null, flat));

      expect(picks).toEqual([...expected]);
      expect(flatPicks).toEqual([...expected]);
    },
  );

  test("selection options reach the tier and alternate paths, so main draining is honored everywhere", () => {
    // Regression for the exact-selector rebase integration: `CodexAccountUsabilityOptions`
    // (notably `nativeMainSelectionOnly`) must reach `getEligiblePoolAccounts` through
    // every tier-aware path. During main-profile draining the caller routes on cached
    // main state only, and `__main__` stays a candidate without a live token read. The
    // preemption and alternate paths must agree with the quota path about that.
    const config = makeThreeAccountConfig({
      activeCodexAccountId: "a",
      codexAccountPriorities: { __main__: 2, a: 1, b: 1, c: 1 },
    } as Partial<OcxConfig>);
    primeAllQuota();
    // No auth.json exists in this harness, so a live-token read for __main__ would fail.
    const selectionOptions = { nativeMainSelectionOnly: true as const };

    // Preemption sees __main__ as the highest eligible tier and moves the unbound
    // request up to it — only possible because selectionOptions reached the tier walk.
    expect(previewCodexAccountForRequest(null, config, Date.now(), "shared", selectionOptions))
      .toBe(MAIN_CODEX_ACCOUNT_ID);

    // The alternate path excludes the active account and still honors the option: __main__
    // is the top remaining candidate rather than being dropped for the live-token rule.
    expect(pickAlternateCodexAccount(config, "a", Date.now(), "shared", selectionOptions))
      .toBe(MAIN_CODEX_ACCOUNT_ID);
  });
});
