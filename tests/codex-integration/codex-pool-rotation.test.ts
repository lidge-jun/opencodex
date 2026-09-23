// Reserve fixtures here exercise routing state only; they do not authorize or dispatch Reserve.
import {
  clearPoolRotationState,
  DEFAULT_ACCOUNT_PRIORITY,
  normalizeAccountPriority,
  notePoolRotationSuccess,
  parseAccountPriority,
  parseAccountPoolStrategy,
  parseCodexAccountPoolStrategy,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  selectPriorityTier,
} from "../../src/codex/pool-rotation";
import {
  clearCodexAccountPin,
  codexAccountPriorityLookup,
  forgetCodexAccountPriority,
  getCodexAccountPriority,
  setCodexAccountPriority,
} from "../../src/codex/account-priority";
import {
  clearCodexUpstreamHealth,
  clearCodexUpstreamHealthForAccount,
  clearThreadAccountMap,
  CODEX_TRANSIENT_SOFT_AVOID_MS,
  CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS,
  previewCodexAccountForRequest,
  getEffectiveActiveCodexAccountId,
  isCodexAccountInCooldown,
  pickAlternateCodexAccount,
  recordCodexUpstreamOutcome,
  reconcileCodexRoutingHealth,
  resetCodexRoutingForManualSelection,
  resolveCodexAccountForThread,
  resolveCodexAccountForThreadDetailed,
} from "../../src/codex/routing";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { setAccountQuotaFromParsed } from "../../src/codex/quota";
import { getConfigPath } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

/**
 * `reconcileCodexRoutingHealth` ignores a generation it has already seen, and the counter is
 * module state shared by every test in this file, so each call needs a strictly higher one.
 */
let sweepGeneration = 9_000_000;
function generationContext(codexAccountIds: ReadonlySet<string>) {
  sweepGeneration += 1;
  return {
    generation: sweepGeneration,
    providerNames: new Set<string>(),
    comboIds: new Set<string>(),
    comboTargets: new Set<string>(),
    codexAccountIds,
    oauthAccountKeys: new Set<string>(),
    configRoots: new Set<string>(),
  };
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

  test("reset-first is accepted only by the Codex strategy parser", () => {
    expect(parseCodexAccountPoolStrategy("reset-first")).toBe("reset-first");
    expect(parseAccountPoolStrategy("reset-first")).toBeNull();
    expect(parseCodexAccountPoolStrategy("invalid")).toBeNull();
  });

  test("reset-first compares both windows, previews without writes, and uses the same failover order", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "reset-first" });
    const now = Date.now();
    const seconds = now / 1000;
    setAccountQuotaFromParsed("a", { weeklyPercent: 10, weeklyResetAt: seconds + 600, shortPercent: 10, shortResetAt: seconds + 300 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 60, weeklyResetAt: seconds + 100, shortPercent: 20, shortResetAt: seconds + 500 });
    setAccountQuotaFromParsed("c", { weeklyPercent: 20, weeklyResetAt: seconds + 900, shortPercent: 30, shortResetAt: seconds + 200 });
    expect(previewCodexAccountForRequest("reset-task", config, now)).toBe("b");
    expect(config.activeCodexAccountId).toBe("a");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    expect(resolveCodexAccountForThread("reset-task", config, now)).toBe("b");
    expect(config.activeCodexAccountId).toBe("a");
    expect(pickAlternateCodexAccount(config, "b", now)).toBe("c");
  });

  test("reset-first compares seconds and milliseconds in the same clock", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "reset-first" });
    const now = Date.now();
    setAccountQuotaFromParsed("a", { weeklyPercent: 10, weeklyResetAt: now + 30_000 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 20, weeklyResetAt: now / 1000 + 60 });
    setAccountQuotaFromParsed("c", { weeklyPercent: 30, weeklyResetAt: now - 1 });
    expect(previewCodexAccountForRequest(null, config, now)).toBe("a");
    expect(resolveCodexAccountForThread(null, config, now)).toBe("a");
  });

  test("reset-first falls back to quota behavior for independent model windows", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "reset-first" });
    const now = Date.now();
    setAccountQuotaFromParsed("a", { weeklyPercent: 10, weeklyResetAt: now / 1000 + 300 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 60, weeklyResetAt: now / 1000 + 10 });
    setAccountQuotaFromParsed("c", { weeklyPercent: 20, weeklyResetAt: now / 1000 + 200 });
    expect(previewCodexAccountForRequest("independent", config, now, "spark")).toBe("a");
    expect(resolveCodexAccountForThread("independent", config, now, "spark")).toBe("a");
    expect(resolveCodexAccountForThread(null, config, now, "shared")).toBe("b");
    expect(resolveCodexAccountForThread("independent", config, now, "spark")).toBe("a");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
    recordCodexUpstreamOutcome(config, "a", 429, { now, resetAt: now / 1000 + 100, modelId: "gpt-5.3-codex-spark" });
    expect(pickAlternateCodexAccount(config, "a", now + 1, "spark")).toBe("c");
    expect(getEffectiveActiveCodexAccountId(config)).toBe("b");
    expect(config.accountPoolStrategy).toBe("reset-first");
  });

  test.each([false, true])("reset-first respects cacheAffinity=%s for bound tasks", cacheAffinity => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "reset-first", pool: { cacheAffinity } });
    const now = Date.now();
    setAccountQuotaFromParsed("a", { weeklyPercent: 10, weeklyResetAt: now / 1000 + 30 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 20, weeklyResetAt: now / 1000 + 60 });
    setAccountQuotaFromParsed("c", { weeklyPercent: 30, weeklyResetAt: now / 1000 + 90 });
    expect(resolveCodexAccountForThread("cached-reset", config, now)).toBe("a");
    setAccountQuotaFromParsed("a", { weeklyPercent: 90 });
    expect(previewCodexAccountForRequest("cached-reset", config, now + 1)).toBe(cacheAffinity ? "a" : "b");
    expect(resolveCodexAccountForThread("cached-reset", config, now + 1)).toBe(cacheAffinity ? "a" : "b");
  });

  test.each([false, true])("reset-first threshold zero retains a spent binding with cacheAffinity=%s", cacheAffinity => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "reset-first", autoSwitchThreshold: 0, pool: { cacheAffinity } });
    const now = Date.now();
    setAccountQuotaFromParsed("a", { weeklyPercent: 10, weeklyResetAt: now / 1000 + 10 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 20, weeklyResetAt: now / 1000 + 20 });
    setAccountQuotaFromParsed("c", { weeklyPercent: 30, weeklyResetAt: now / 1000 + 30 });
    expect(resolveCodexAccountForThread("zero-reset", config, now)).toBe("a");
    for (const id of ["a", "b", "c"]) setAccountQuotaFromParsed(id, { weeklyPercent: 100 });
    for (const later of [now + 1, now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1]) {
      expect(previewCodexAccountForRequest("zero-reset", config, later)).toBe("a");
      expect(resolveCodexAccountForThread("zero-reset", config, later)).toBe("a");
    }
    recordCodexUpstreamOutcome(config, "a", 429, { now: now + 2, resetAt: now / 1000 + 300 });
    expect(pickAlternateCodexAccount(config, "a", now + 3)).toBe("b");
  });

  test("reset-first keeps affinity until either window reaches the threshold", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "reset-first", pool: { cacheAffinity: false } });
    const now = Date.now();
    const seconds = now / 1000;
    setAccountQuotaFromParsed("a", { weeklyPercent: 10, weeklyResetAt: seconds + 100 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 20, weeklyResetAt: seconds + 200 });
    setAccountQuotaFromParsed("c", { weeklyPercent: 30, weeklyResetAt: seconds + 300 });
    expect(resolveCodexAccountForThread("bound", config, now)).toBe("a");
    setAccountQuotaFromParsed("b", { weeklyPercent: 20, weeklyResetAt: seconds + 50 });
    expect(resolveCodexAccountForThread("bound", config, now)).toBe("a");
    expect(resolveCodexAccountForThread("new", config, now)).toBe("b");
    setAccountQuotaFromParsed("a", { weeklyPercent: 10, shortPercent: 80, shortResetAt: seconds + 10 });
    expect(previewCodexAccountForRequest("bound", config, now)).toBe("b");
    expect(resolveCodexAccountForThread("bound", config, now)).toBe("b");
    setAccountQuotaFromParsed("b", { weeklyPercent: 80 });
    expect(resolveCodexAccountForThread("bound", config, now)).toBe("c");
  });

  test.each([false, true])("reset-first account override zero preserves affinity but not cooldown eligibility with cacheAffinity=%s", cacheAffinity => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "reset-first",
      autoSwitchThreshold: 80,
      codexAccountAutoSwitchThresholds: { a: 0 },
      pool: { cacheAffinity },
    });
    const now = Date.now();
    for (const [index, id] of THREE_ACCOUNT_IDS.entries()) {
      setAccountQuotaFromParsed(id, { weeklyPercent: 10 + index * 10, weeklyResetAt: now / 1000 + 300 * (index + 1) });
    }
    expect(resolveCodexAccountForThread("account-zero-reset", config, now)).toBe("a");
    setAccountQuotaFromParsed("a", { weeklyPercent: 100 });
    for (const later of [now + 1, now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1]) {
      expect(previewCodexAccountForRequest("account-zero-reset", config, later)).toBe("a");
      expect(resolveCodexAccountForThread("account-zero-reset", config, later)).toBe("a");
    }
    const failedAt = now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 2;
    recordCodexUpstreamOutcome(config, "a", 429, { now: failedAt, retryAfter: "60" });
    expect(previewCodexAccountForRequest("account-zero-reset", config, failedAt + 1)).toBe("b");
    expect(resolveCodexAccountForThread("account-zero-reset", config, failedAt + 1)).toBe("b");
  });

  test.each([
    { global: 0, scope: undefined },
    { global: 95, scope: undefined },
    { global: 0, scope: "reserve" as const },
    { global: 95, scope: "reserve" as const },
  ])("reset-first account override controls affinity with global=$global scope=$scope", ({ global, scope }) => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "reset-first",
      pool: { cacheAffinity: false },
      autoSwitchThreshold: global,
      codexAccountAutoSwitchThresholds: { a: 60 },
    });
    const now = Date.now();
    for (const [index, id] of THREE_ACCOUNT_IDS.entries()) {
      setAccountQuotaFromParsed(id, { weeklyPercent: 10 + index * 10, weeklyResetAt: now / 1000 + 300 * (index + 1) });
    }
    expect(resolveCodexAccountForThread("account-override-reset", config, now, scope)).toBe("a");
    setAccountQuotaFromParsed("a", { weeklyPercent: 70 });
    expect(previewCodexAccountForRequest("account-override-reset", config, now + 1, scope)).toBe("b");
    expect(resolveCodexAccountForThread("account-override-reset", config, now + 1, scope)).toBe("b");
  });

  test("reset-first ignores past/missing resets and breaks ties by usage", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "reset-first" });
    const now = Date.now();
    setAccountQuotaFromParsed("a", { weeklyPercent: 10, weeklyResetAt: now / 1000 - 1 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 30, weeklyResetAt: now / 1000 + 20 });
    setAccountQuotaFromParsed("c", { weeklyPercent: 20, shortPercent: 10, shortResetAt: now / 1000 + 20 });
    expect(resolveCodexAccountForThread(null, config, now)).toBe("c");
    expect(resolveCodexAccountForThread(null, config, now + 20_000)).toBe("a");
    clearAccountQuota();
    expect(resolveCodexAccountForThread(null, config, now)).toBe("a");
  });

  test("reset-first preserves priority and availability and honors disabled thresholds", () => {
    const config = makeThreeAccountConfig({ accountPoolStrategy: "reset-first" });
    const now = Date.now();
    setAccountQuotaFromParsed("a", { weeklyPercent: 90, weeklyResetAt: now / 1000 + 10 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 20, weeklyResetAt: now / 1000 + 20 });
    setAccountQuotaFromParsed("c", { weeklyPercent: 10, weeklyResetAt: now / 1000 + 30 });
    expect(resolveCodexAccountForThread(null, config, now)).toBe("b");
    config.autoSwitchThreshold = 0;
    expect(resolveCodexAccountForThread(null, config, now)).toBe("a");
    config.autoSwitchThreshold = 80;
    setCodexAccountPriority(config, "c", 2);
    expect(resolveCodexAccountForThread(null, config, now)).toBe("c");
    expect(pickAlternateCodexAccount(config, "c", now)).toBe("b");
    setAccountQuotaFromParsed("b", { weeklyPercent: 95 });
    setAccountQuotaFromParsed("c", { weeklyPercent: 99 });
    expect(resolveCodexAccountForThread(null, config, now)).toBe("a");
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
      modelId: "gpt-reserve",
    });

    // Reserve skips A in its own ring. The next shared request still takes B,
    // as if the Reserve selection had never advanced the shared ring.
    expect(resolveCodexAccountForThread(null, config, now + 2, "reserve")).toBe("b");
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
      modelId: "gpt-reserve",
    });

    // Fill-first would normally advance a → b, but b is unavailable only to Reserve.
    expect(pickAlternateCodexAccount(config, "a", now + 1, "reserve")).toBe("c");
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
      modelId: "gpt-reserve",
    });

    expect(resolveCodexAccountForThread(null, config, now + 2, "reserve")).toBe("b");
    expect(resolveCodexAccountForThread(null, config, now + 3, "shared")).toBe("a");
  });

  test("preemption inside an independent scope leaves the shared cursor alone", () => {
    const config = makeThreeAccountConfig({
      activeCodexAccountId: "b",
      codexAccountPriorities: { a: 1 },
    } as Partial<OcxConfig>);
    const now = 1_800_000_000_000;
    primeAllQuota();

    expect(resolveCodexAccountForThread(null, config, now, "reserve")).toBe("a");
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

    expect(resolveCodexAccountForThread(null, config, Date.now(), "reserve")).toBe("b");
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
      modelId: "gpt-reserve",
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
      modelId: "gpt-reserve",
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
      modelId: "gpt-reserve",
      now: failedAt,
    });

    // Past the 30s soft avoid, inside the 5-minute failure window.
    const afterSoftAvoid = failedAt + CODEX_TRANSIENT_SOFT_AVOID_MS + 1_000;
    const routed = resolveCodexAccountForThread(null, config, afterSoftAvoid, "reserve");

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

  describe("an operator selection outranks the pool cursor", () => {

  test.each([true, false])(
    "cache affinity outranks quota when the flag is %s",
    (cacheAffinity) => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "quota",
        autoSwitchThreshold: 80,
        activeCodexAccountId: "a",
        pool: { cacheAffinity },
      } as Partial<OcxConfig>);
      const threadId = "cache-affine-thread";
      // Bind the thread while "a" is the natural quota pick, which is how a real conversation
      // acquires its affinity in the first place.
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 50);
      updateAccountQuota("c", 50);
      expect(resolveCodexAccountForThread(threadId, config)).toBe("a");
      // Now "a" is past the threshold but NOT spent, and the siblings have far more room.
      updateAccountQuota("a", 90);
      updateAccountQuota("b", 10);
      updateAccountQuota("c", 10);

      const later = Date.now() + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
      const served = resolveCodexAccountForThread(threadId, config, later);
      if (cacheAffinity) {
        // c-4: the cache-affine account is chosen over the higher-headroom one. The prompt
        // cache lives on "a"; crossing a threshold is a hint, not evidence "a" cannot serve.
        expect(served).toBe("a");
      } else {
        // Flag off is byte-identical to today: the thread moves at the threshold.
        expect(served).not.toBe("a");
      }
    },
  );

  test("a bound thread still leaves an account that is genuinely spent", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      pool: { cacheAffinity: true },
    } as Partial<OcxConfig>);
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);

    const threadId = "spent-account-thread";
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");

    // Fully spent, not merely busy. This is the half that keeps the change a REORDERING rather
    // than a pin: affinity outranks quota, it does not outrank exhaustion.
    updateAccountQuota("a", 100);
    const later = Date.now() + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread(threadId, config, later)).not.toBe("a");
  });

  test("preview and resolve agree under cache affinity", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      pool: { cacheAffinity: true },
    } as Partial<OcxConfig>);
    const threadId = "preview-agrees-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 50);
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");
    updateAccountQuota("a", 90);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);
    const later = Date.now() + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    // Two copies of the same rule live in this file; a preview that disagreed with the final
    // answer would hand subagent fallback a different account than the request actually uses.
    expect(previewCodexAccountForRequest(threadId, config, later)).toBe("a");
    expect(resolveCodexAccountForThread(threadId, config, later)).toBe("a");
  });

  // #4546: under quota strategy with no cacheAffinity, a live binding may only
  // move to an account that has genuine headroom AND is strictly cooler. These
  // cases share the bind-then-re-eval harness with the cache-affinity tests
  // above; they pin the narrowed preference, not a pin.
  test("a bound thread does not ping-pong among over-threshold accounts", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
    });
    const threadId = "cache-safe-death-spiral";
    // Bind the thread while "a" is the natural quota pick, which is how a real conversation
    // acquires its affinity in the first place.
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 50);
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");

    // Every account is now in the 80–100% band, and the scores are unequal on
    // purpose: before the fix, each of these resolves handed the thread to
    // whichever account was one point cooler, discarding the account-isolated
    // prompt cache. Equal scores would not move even before the fix, so the
    // case would pass for the wrong reason.
    updateAccountQuota("a", 95);
    updateAccountQuota("b", 90);
    updateAccountQuota("c", 97);

    const now = Date.now();
    for (const later of [
      now,
      now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1,
      now + 2 * CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 2,
    ]) {
      // Two copies of the same rule live in this file; a preview that disagreed with the
      // final answer would hand subagent fallback a different account than the request uses.
      expect(previewCodexAccountForRequest(threadId, config, later)).toBe("a");
      expect(resolveCodexAccountForThread(threadId, config, later)).toBe("a");
    }
  });

  test("a bound thread still moves once onto an account with genuine headroom", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      // This case is about WHERE a threshold-driven move may land, so it states the
      // capacity-first setting explicitly (#4546). Under the default a bound thread does
      // not move on a threshold crossing at all, and the destination rule never runs.
      pool: { cacheAffinity: false },
    } as Partial<OcxConfig>);
    const threadId = "cache-safe-real-improvement";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 50);
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");

    // "a" crossed the threshold; "b" still has headroom. The fix narrowed the
    // replacement rule, it did not pin the thread.
    updateAccountQuota("a", 95);
    updateAccountQuota("b", 5);
    updateAccountQuota("c", 50);

    const movedAt = Date.now();
    expect(previewCodexAccountForRequest(threadId, config, movedAt)).toBe("b");
    expect(resolveCodexAccountForThread(threadId, config, movedAt)).toBe("b");

    // "b" is under the threshold, so a later re-eval has nothing to move toward.
    const later = movedAt + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(previewCodexAccountForRequest(threadId, config, later)).toBe("b");
    expect(resolveCodexAccountForThread(threadId, config, later)).toBe("b");
  });

  test("a 429 still releases a binding the preference rule would have kept", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
    });
    const threadId = "cache-safe-429-release";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 50);
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");

    // Same all-hot band as the ping-pong case: the preference rule has no legal
    // destination, so without the refusal the thread would stay on "a". The 429
    // is the stronger signal and must still win. Resolve at the refusal instant
    // so "a" is still in its default cooldown and is not a selectable destination;
    // "b" is then the only remaining account that is both selectable and
    // unambiguously coolest.
    updateAccountQuota("a", 95);
    updateAccountQuota("b", 90);
    updateAccountQuota("c", 97);
    const now = Date.now();
    recordCodexUpstreamOutcome(config, "a", 429, { now });
    expect(previewCodexAccountForRequest(threadId, config, now)).toBe("b");
    expect(resolveCodexAccountForThread(threadId, config, now)).toBe("b");
  });

  test("a fully spent bound account still moves to a sibling with headroom", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
    });
    const threadId = "cache-safe-exhausted-with-headroom";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 10);
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");

    // 100% is exhaustion, not a pin. With cacheAffinity off, a 100 score without a
    // 429/402 does not drop the binding by itself — stickiness-until-refusal is
    // intended — but a sibling with genuine headroom is a real improvement and
    // must still be taken. (An all-hot pool would keep the thread on "a".)
    updateAccountQuota("a", 100);
    updateAccountQuota("b", 5);
    updateAccountQuota("c", 50);
    const later = Date.now() + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(previewCodexAccountForRequest(threadId, config, later)).toBe("b");
    expect(resolveCodexAccountForThread(threadId, config, later)).toBe("b");
  });

  test("an install that never configured pool keeps a bound thread on its account (#4546)", () => {
    // No pool key at all. This is the case the incident was reported from: the operator had
    // never heard of cacheAffinity, so the protection has to be the default or it is not
    // protection.
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
    });
    const threadId = "default-affinity-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 50);
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");

    updateAccountQuota("a", 90);
    updateAccountQuota("b", 5);
    updateAccountQuota("c", 5);
    const later = Date.now() + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread(threadId, config, later)).toBe("a");
    expect(previewCodexAccountForRequest(threadId, config, later)).toBe("a");
  });

  test("capacity-first refuses a destination with no headroom (#4546 ping-pong)", () => {
    // The reported spiral, reproduced with the historical rule explicitly restored: every
    // account is over the threshold, so every turn found a "cooler" account and moved again.
    // A move now has to be worth making, so the thread stays and keeps its prefix.
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      pool: { cacheAffinity: false },
    } as Partial<OcxConfig>);
    const threadId = "hot-pool-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 50);
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");

    updateAccountQuota("a", 95);
    updateAccountQuota("b", 90);
    updateAccountQuota("c", 85);
    let at = Date.now() + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread(threadId, config, at)).toBe("a");
    at += CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread(threadId, config, at)).toBe("a");
    expect(previewCodexAccountForRequest(threadId, config, at)).toBe("a");
  });

  test("capacity-first still moves a bound thread to an account that has headroom", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      pool: { cacheAffinity: false },
    } as Partial<OcxConfig>);
    const threadId = "capacity-first-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 50);
    updateAccountQuota("c", 50);
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");

    updateAccountQuota("a", 95);
    updateAccountQuota("b", 10);
    updateAccountQuota("c", 50);
    const later = Date.now() + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread(threadId, config, later)).toBe("b");
  });

  test("a transient streak detours the request and keeps the binding (#4546)", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      upstreamFailoverThreshold: 3,
    });
    const threadId = "transient-hold-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    expect(resolveCodexAccountForThread(threadId, config)).toBe("a");

    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);

    // Served elsewhere, because "a" cannot take this request right now.
    const served = resolveCodexAccountForThread(threadId, config);
    expect(served).not.toBe("a");
    // Preview agrees once the request path has chosen a detour, so subagent fallback scores
    // the account that will actually serve.
    expect(previewCodexAccountForRequest(threadId, config)).toBe(served);

    // The binding was never surrendered: past the soft-avoid window and the failure window,
    // the thread is home again with its prefix intact. A deleted binding could not do this.
    const recovered = Date.now() + 6 * 60_000;
    expect(resolveCodexAccountForThread(threadId, config, recovered)).toBe("a");
  });

  test("preview names the same detour as resolve before any detour is recorded", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      upstreamFailoverThreshold: 3,
    });
    const threadId = "preview-first-detour-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const start = Date.now();
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("a");

    recordCodexUpstreamOutcome(config, "a", 503, { now: start });
    recordCodexUpstreamOutcome(config, "a", 503, { now: start });
    recordCodexUpstreamOutcome(config, "a", 503, { now: start });

    // Preview FIRST, before any detour exists. Subagent fallback scores this account's usage to
    // decide whether a model is still reachable, so a preview that named the bound account here
    // would retire a model over usage the request was never going to touch.
    const previewed = previewCodexAccountForRequest(threadId, config, start);
    const served = resolveCodexAccountForThread(threadId, config, start);
    expect(previewed).toBe(served);
    expect(served).not.toBe("a");
  });

  test("every binding decision records what happened and why (#4546)", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      upstreamFailoverThreshold: 3,
    });
    const threadId = "affinity-reason-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const start = Date.now();

    // A thread with no binding yet is a placement, not a move.
    expect(resolveCodexAccountForThreadDetailed(threadId, config, start)).toMatchObject({
      accountId: "a",
      affinity: { move: "new_bind", reason: "healthy" },
    });
    // Served by its own healthy account.
    expect(resolveCodexAccountForThreadDetailed(threadId, config, start)).toMatchObject({
      affinity: { move: "reused", reason: "healthy" },
    });

    // A transient streak sends this request elsewhere while the binding stays put.
    recordCodexUpstreamOutcome(config, "a", 503, { now: start });
    recordCodexUpstreamOutcome(config, "a", 503, { now: start });
    recordCodexUpstreamOutcome(config, "a", 503, { now: start });
    expect(resolveCodexAccountForThreadDetailed(threadId, config, start)).toMatchObject({
      accountId: "b",
      affinity: { move: "detour", reason: "transient" },
    });

    // A quota refusal is the account telling this thread it cannot serve, so the binding goes
    // and the record names which cause fired instead of leaving it to be inferred.
    recordCodexUpstreamOutcome(config, "a", 429, { now: start });
    expect(resolveCodexAccountForThreadDetailed(threadId, config, start).affinity)
      .toMatchObject({ move: "rebound", reason: "quota_refusal" });
  });

  test("a release names the guard that fired, not a quota fallback (#4598)", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
    });
    const threadId = "paused-release-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const start = Date.now();
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("a");

    // The operator paused the bound account. That is why the binding goes, and a quota fallback
    // here would name a cause routing never used.
    config.pausedCodexAccountIds = ["a"];
    const moved = resolveCodexAccountForThreadDetailed(threadId, config, start);
    expect(moved.status).toBe("selected");
    expect(moved.affinity).toMatchObject({ move: "rebound", reason: "paused" });
  });

  test("a release survives a resolve that produced no account (#4598)", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
    });
    const threadId = "no-account-release-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const start = Date.now();
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("a");

    // Everything is paused, so the binding is released and nothing takes it. A no-account result
    // reaches no auth context and therefore no usage entry, so the reason has to survive.
    config.pausedCodexAccountIds = ["a", "b", "c"];
    const none = resolveCodexAccountForThreadDetailed(threadId, config, start);
    expect(none.status).toBe("none");
    expect(none.affinity).toMatchObject({ move: "cleared", reason: "paused" });

    // The pool recovers. The rebind is still attributable to the pause rather than reported as a
    // fresh healthy bind that erases why this conversation left its account.
    config.pausedCodexAccountIds = ["a"];
    const recovered = resolveCodexAccountForThreadDetailed(threadId, config, start);
    expect(recovered.status).toBe("selected");
    expect(recovered.affinity).toMatchObject({ move: "rebound", reason: "paused" });
  });

  test("a transient block with nowhere to detour keeps the binding", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      upstreamFailoverThreshold: 3,
    });
    const threadId = "provider-wide-outage-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const start = Date.now();
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("a");

    // A provider-wide 503 hits every account, so every sibling is soft-avoided too and the
    // detour has nowhere to go. Losing the binding here would rebuild the cold prefix somewhere
    // else for exactly the failure the hold exists to survive.
    for (const id of ["a", "b", "c"]) {
      recordCodexUpstreamOutcome(config, id, 503, { now: start });
      recordCodexUpstreamOutcome(config, id, 503, { now: start });
      recordCodexUpstreamOutcome(config, id, 503, { now: start });
    }
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("a");
    expect(previewCodexAccountForRequest(threadId, config, start)).toBe("a");

    // Once the outage clears the thread is still on its own warm account, with no rebind.
    const recovered = start + 6 * 60_000;
    expect(resolveCodexAccountForThread(threadId, config, recovered)).toBe("a");
  });

  test("a transient hold that outlives its window releases the binding", () => {
    const config = makeThreeAccountConfig({
      accountPoolStrategy: "quota",
      autoSwitchThreshold: 80,
      activeCodexAccountId: "a",
      upstreamFailoverThreshold: 3,
    });
    const threadId = "transient-hold-expiry-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const start = Date.now();
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("a");

    recordCodexUpstreamOutcome(config, "a", 503, { now: start });
    recordCodexUpstreamOutcome(config, "a", 503, { now: start });
    recordCodexUpstreamOutcome(config, "a", 503, { now: start });
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("b");

    // Still failing eleven minutes later: a hold is a grace period, not a pin, so the binding
    // is released and the thread rebinds to whatever can actually serve it.
    const late = start + 11 * 60_000;
    recordCodexUpstreamOutcome(config, "a", 503, { now: late });
    recordCodexUpstreamOutcome(config, "a", 503, { now: late });
    recordCodexUpstreamOutcome(config, "a", 503, { now: late });
    expect(resolveCodexAccountForThread(threadId, config, late)).toBe("b");

    // "a" is healthy again, and the thread does NOT return: it lives on "b" now, which is the
    // difference between a released binding and a held one.
    const healthy = late + 6 * 60_000;
    expect(resolveCodexAccountForThread(threadId, config, healthy)).toBe("b");
  });

    test("the pool moves, then a manual pick wins the next unbound dispatch", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "round-robin",
        accountPoolStickyLimit: 1,
        activeCodexAccountId: "a",
      });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 20);
      updateAccountQuota("c", 30);

      // Let the pool move the runtime cursor off the operator account.
      const first = resolveCodexAccountForThread(null, config)!;
      recordCodexUpstreamOutcome(config, first, 429);
      const promoted = getEffectiveActiveCodexAccountId(config);
      expect(promoted).not.toBe(first);

      // The operator now selects the third account, one the pool did not choose and that
      // carries no cooldown. Before this feature the runtime cursor kept winning and the
      // next dispatch still served the pool account, which is the defect this phase fixes.
      const chosen = ["a", "b", "c"].find(id => id !== first && id !== promoted)!;
      config.activeCodexAccountId = chosen;
      resetCodexRoutingForManualSelection(chosen);

      expect(getEffectiveActiveCodexAccountId(config)).toBe(chosen);
      expect(resolveCodexAccountForThread(null, config)).toBe(chosen);
    });

    // The three tests below are the ones that carry the feature. Each was driven red against
    // the parent branch first: an assertion that passes with the production change reverted
    // proves nothing, and the first draft of this block was exactly that — three tests that
    // all passed without the guard, because they only re-asserted what
    // resetCodexRoutingForManualSelection and the exempt failover promote already did.
    test("an over-threshold operator account is served around, not replaced", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "fill-first",
        activeCodexAccountId: "a",
        autoSwitchThreshold: 80,
      });
      // The operator's account is past the switch threshold, so fill-first advances off it.
      // This is the ordinary case the report was about: the account the operator chose is
      // temporarily spent, not wrong.
      updateAccountQuota("a", 90);
      updateAccountQuota("b", 10);
      updateAccountQuota("c", 10);
      resetCodexRoutingForManualSelection("a");

      const served = resolveCodexAccountForThread(null, config)!;
      expect(served).not.toBe("a");

      // Serving the request from another account is the pool doing its job. Writing that
      // account over the operator's selection is not: when a's window rolls over there
      // would be nothing left pointing back at it. Without the guard this reads `served`.
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    });

    test("a successful dispatch spends the one-shot so the pool may move again", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "fill-first",
        activeCodexAccountId: "a",
        autoSwitchThreshold: 80,
      });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 10);
      updateAccountQuota("c", 10);
      resetCodexRoutingForManualSelection("a");
      expect(resolveCodexAccountForThread(null, config)).toBe("a");

      // The operator got what they asked for, so the hold is released. Without a consume
      // site the preference is permanent and the cursor could never move again — measured:
      // guard without consume fails 15 of the 69 rotation tests in this file.
      recordCodexUpstreamOutcome(config, "a", 200);

      updateAccountQuota("a", 90);
      const served = resolveCodexAccountForThread(null, config)!;
      expect(served).not.toBe("a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe(served);
    });

    test("deleting the preferred account releases the hold", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "round-robin",
        accountPoolStickyLimit: 1,
        activeCodexAccountId: "a",
      });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 20);
      updateAccountQuota("c", 30);
      resetCodexRoutingForManualSelection("a");

      // Delete is the operator exit with no reconcile behind it: the account can never
      // succeed again, so nothing else would ever spend the one-shot. The account-lifecycle
      // delete path reaches routing through exactly this call.
      config.codexAccounts = config.codexAccounts!.filter(account => account.id !== "a");
      config.activeCodexAccountId = undefined;
      clearCodexUpstreamHealthForAccount("a");

      const served = resolveCodexAccountForThread(null, config)!;
      expect(served).not.toBe("a");
      // Without the revocation the preference outlives its account and blocks every write,
      // so the effective active stays empty and the pool can never commit a replacement.
      expect(getEffectiveActiveCodexAccountId(config)).toBe(served);
    });

    test("the generation sweep drops a preference whose account is gone", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "fill-first",
        activeCodexAccountId: "a",
        autoSwitchThreshold: 80,
      });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 10);
      updateAccountQuota("c", 10);
      resetCodexRoutingForManualSelection("a");

      // The other removal path: an account edited out of the config by something the runtime
      // never observed, so no delete call ever reached routing. The sweep is the only thing
      // standing between that and a preference that can never be spent.
      reconcileCodexRoutingHealth(generationContext(new Set(["b", "c"])));

      config.codexAccounts = config.codexAccounts!.filter(account => account.id !== "a");
      config.activeCodexAccountId = undefined;
      const served = resolveCodexAccountForThread(null, config)!;
      expect(served).not.toBe("a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe(served);
    });

    test("the generation sweep keeps a preference whose account is still live", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "fill-first",
        activeCodexAccountId: "a",
        autoSwitchThreshold: 80,
      });
      updateAccountQuota("a", 90);
      updateAccountQuota("b", 10);
      updateAccountQuota("c", 10);
      resetCodexRoutingForManualSelection("a");

      // The half that makes the sweep a sweep rather than a reset: "a" is over threshold and
      // is about to be routed around, but it is still in the roster, so the operator's
      // selection has to survive.
      reconcileCodexRoutingHealth(generationContext(new Set(["a", "b", "c"])));

      const served = resolveCodexAccountForThread(null, config)!;
      expect(served).not.toBe("a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    });

    test("a 429 on the preferred account still promotes away from it", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "round-robin",
        accountPoolStickyLimit: 1,
        activeCodexAccountId: "a",
      });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 20);
      updateAccountQuota("c", 30);
      resetCodexRoutingForManualSelection("a");

      // The failover promote is exempt from the preference guard on purpose: it only runs
      // because the account in use just failed, so it is never an automatic pick competing
      // with the operator. Guarding it would trap routing on a cooled account.
      recordCodexUpstreamOutcome(config, "a", 429);
      expect(isCodexAccountInCooldown("a")).toBe(true);
      expect(getEffectiveActiveCodexAccountId(config)).not.toBe("a");
    });
  });
});
