import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearPoolRotationState } from "../src/codex/pool-rotation";
import {
  ACCOUNT_POOL_MAX_FAILOVERS,
  AFFINITY_IDLE_TTL_MS,
  MAX_AFFINITY_ENTRIES,
  affinitySizeForTests,
  bindSessionAffinity,
  buildSessionKeyFromParts,
  classifyPoolHttpStatus,
  clearAccountPoolState,
  getSessionAffinity,
  isAccountInCooldown,
  recordPoolAccountCooldown,
  resolvePoolAccount,
  rotatePoolAccountOn429,
} from "../src/routing/account-pool";
import type { AccountPoolPlugin } from "../src/routing/account-pool";

const POOL_KEY = "test-pool";

function makePlugin(overrides: Partial<AccountPoolPlugin> & {
  eligible?: string[];
  usageScores?: Record<string, number>;
} = {}): AccountPoolPlugin {
  const eligible = overrides.eligible ?? ["acct-a", "acct-b", "acct-c"];
  return {
    poolKey: POOL_KEY,
    sessionKeyFromRequest(input) {
      return buildSessionKeyFromParts(input);
    },
    listEligibleAccountIds() {
      return overrides.eligible ?? eligible;
    },
    usageScore(accountId) {
      if (overrides.usageScores) return overrides.usageScores[accountId];
      return overrides.usageScore?.(accountId);
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearAccountPoolState();
  clearPoolRotationState(POOL_KEY);
});

afterEach(() => {
  clearAccountPoolState();
  clearPoolRotationState(POOL_KEY);
});

describe("buildSessionKeyFromParts", () => {
  test("prefers clientThreadId over cache key", () => {
    expect(buildSessionKeyFromParts({
      clientThreadId: "thread-1",
      promptCacheKey: "cache-1",
    })).toBe("thread-1");
  });

  test("ignores shared-cohort prompt_cache_key", () => {
    expect(buildSessionKeyFromParts({
      promptCacheKey: "shared-cohort",
      promptCacheKeyIsSharedCohort: true,
    })).toBeNull();
  });

  test("uses prompt_cache_key when no session id and not shared cohort", () => {
    expect(buildSessionKeyFromParts({
      promptCacheKey: "conv-cache-key",
      promptCacheKeyIsSharedCohort: false,
    })).toBe("conv-cache-key");
  });
});

describe("resolvePoolAccount affinity", () => {
  test("affinity hit returns bound account", () => {
    const plugin = makePlugin();
    const now = Date.now();
    bindSessionAffinity(POOL_KEY, "sess-1", "acct-b", now);

    const result = resolvePoolAccount(plugin, "sess-1", {
      strategy: "quota",
      enabled: true,
      activeAccountId: "acct-a",
    }, now);

    expect(result).toEqual({ accountId: "acct-b", reason: "affinity" });
  });

  test("TTL expiry drops stale affinity", () => {
    const plugin = makePlugin();
    const now = Date.now();
    bindSessionAffinity(POOL_KEY, "sess-1", "acct-b", now - AFFINITY_IDLE_TTL_MS - 1);

    const result = resolvePoolAccount(plugin, "sess-1", {
      strategy: "quota",
      enabled: true,
      activeAccountId: "acct-a",
      autoSwitchThreshold: 0,
    }, now);

    expect(result.accountId).not.toBe("acct-b");
    expect(result.reason).not.toBe("affinity");
  });

  test("cap eviction drops oldest affinity entries", () => {
    const plugin = makePlugin();
    const now = Date.now();
    for (let i = 0; i < MAX_AFFINITY_ENTRIES + 5; i++) {
      bindSessionAffinity(POOL_KEY, `sess-${i}`, `acct-${i % 3}`, now - (MAX_AFFINITY_ENTRIES + 5 - i));
    }
    expect(affinitySizeForTests(POOL_KEY)).toBeLessThanOrEqual(MAX_AFFINITY_ENTRIES);
    expect(getSessionAffinity(POOL_KEY, "sess-0", now)).toBeNull();
    expect(getSessionAffinity(POOL_KEY, `sess-${MAX_AFFINITY_ENTRIES + 4}`, now)?.accountId).toBeDefined();
  });
});

describe("resolvePoolAccount disabled", () => {
  test("returns active account when disabled", () => {
    const plugin = makePlugin();
    const result = resolvePoolAccount(plugin, "sess-1", {
      strategy: "quota",
      enabled: false,
      activeAccountId: "acct-a",
    });
    expect(result).toEqual({ accountId: "acct-a", reason: "disabled" });
  });

  test("returns none when disabled and no active", () => {
    const plugin = makePlugin({ eligible: [] });
    const result = resolvePoolAccount(plugin, null, {
      strategy: "quota",
      enabled: false,
    });
    expect(result).toEqual({ accountId: null, reason: "none" });
  });
});

describe("resolvePoolAccount all-cooled", () => {
  test("returns all-cooled when every account is in cooldown", () => {
    const plugin = makePlugin();
    const now = Date.now();
    recordPoolAccountCooldown(POOL_KEY, "acct-a", "rate_limit", "120", now);
    recordPoolAccountCooldown(POOL_KEY, "acct-b", "rate_limit", "120", now);
    recordPoolAccountCooldown(POOL_KEY, "acct-c", "rate_limit", "120", now);

    const result = resolvePoolAccount(plugin, "sess-1", {
      strategy: "quota",
      enabled: true,
      activeAccountId: "acct-a",
    }, now);

    expect(result).toEqual({ accountId: null, reason: "all-cooled" });
  });
});

describe("rotatePoolAccountOn429", () => {
  test("429 hop binds new account to the same session key only", () => {
    const plugin = makePlugin();
    const now = Date.now();
    bindSessionAffinity(POOL_KEY, "sess-a", "acct-a", now);
    bindSessionAffinity(POOL_KEY, "sess-b", "acct-b", now);

    const next = rotatePoolAccountOn429(plugin, "acct-a", "sess-a", "60", now);
    expect(next).not.toBeNull();
    expect(next).not.toBe("acct-a");
    expect(getSessionAffinity(POOL_KEY, "sess-a", now)?.accountId).toBe(next);
    expect(getSessionAffinity(POOL_KEY, "sess-b", now)?.accountId).toBe("acct-b");
  });

  test("failover cap stops after three hops", () => {
    const plugin = makePlugin({
      eligible: ["acct-a", "acct-b", "acct-c", "acct-d", "acct-e"],
    });
    const now = Date.now();
    bindSessionAffinity(POOL_KEY, "sess-1", "acct-a", now);

    let last: string | null = "acct-a";
    for (let i = 0; i < ACCOUNT_POOL_MAX_FAILOVERS; i++) {
      last = rotatePoolAccountOn429(plugin, last!, "sess-1", "60", now);
      expect(last).not.toBeNull();
    }
    const blocked = rotatePoolAccountOn429(plugin, last!, "sess-1", "60", now);
    expect(blocked).toBeNull();
  });

  test("rate_limited remaining ≤5s stick-wait does not hop", () => {
    const plugin = makePlugin();
    const now = Date.now();
    bindSessionAffinity(POOL_KEY, "sess-1", "acct-a", now);

    const next = rotatePoolAccountOn429(plugin, "acct-a", "sess-1", "3", now);
    expect(next).toBeNull();
    expect(getSessionAffinity(POOL_KEY, "sess-1", now)?.accountId).toBe("acct-a");
    expect(isAccountInCooldown(POOL_KEY, "acct-a", now)).not.toBeNull();
  });

  test("stick-wait affinity still resolves for bound session", () => {
    const plugin = makePlugin();
    const now = Date.now();
    bindSessionAffinity(POOL_KEY, "sess-1", "acct-a", now);
    recordPoolAccountCooldown(POOL_KEY, "acct-a", "rate_limit", "3", now);

    const result = resolvePoolAccount(plugin, "sess-1", {
      strategy: "quota",
      enabled: true,
      activeAccountId: "acct-b",
    }, now);

    expect(result).toEqual({ accountId: "acct-a", reason: "affinity" });
  });
});

describe("billing vs rate limit", () => {
  test("classifyPoolHttpStatus splits 429 and 402", () => {
    expect(classifyPoolHttpStatus(429)).toBe("rate_limit");
    expect(classifyPoolHttpStatus(402)).toBe("billing");
    expect(classifyPoolHttpStatus(500)).toBeNull();
  });

  test("402/billing does not hop", () => {
    const plugin = makePlugin();
    const now = Date.now();
    bindSessionAffinity(POOL_KEY, "sess-1", "acct-a", now);

    recordPoolAccountCooldown(POOL_KEY, "acct-a", "billing", null, now);

    expect(classifyPoolHttpStatus(402)).toBe("billing");
    expect(getSessionAffinity(POOL_KEY, "sess-1", now)?.accountId).toBe("acct-a");
  });
});

describe("resolvePoolAccount strategies", () => {
  test("round-robin picks across new sessions", () => {
    const plugin = makePlugin();
    const now = Date.now();
    const first = resolvePoolAccount(plugin, "sess-1", {
      strategy: "round-robin",
      enabled: true,
      activeAccountId: "acct-a",
    }, now);
    const second = resolvePoolAccount(plugin, "sess-2", {
      strategy: "round-robin",
      enabled: true,
      activeAccountId: "acct-a",
    }, now);
    expect(first.reason).toBe("round-robin");
    expect(second.reason).toBe("round-robin");
    expect(first.accountId).not.toBe(second.accountId);
  });

  test("quota picks lowest usage", () => {
    const plugin = makePlugin({
      usageScores: { "acct-a": 90, "acct-b": 20, "acct-c": 50 },
    });
    const result = resolvePoolAccount(plugin, "sess-new", {
      strategy: "quota",
      enabled: true,
      activeAccountId: "acct-a",
      autoSwitchThreshold: 80,
    });
    expect(result).toEqual({ accountId: "acct-b", reason: "lowest-usage" });
  });
});
