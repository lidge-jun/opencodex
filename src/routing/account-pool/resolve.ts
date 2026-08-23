import {
  normalizeAccountPoolStickyLimit,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  pickRoundRobinAccount,
} from "../../codex/pool-rotation";
import {
  bindSessionAffinity,
  clearAffinityState,
  clearSessionAffinityForAccount,
  getSessionAffinity,
  normalizeAffinityComponent,
  touchSessionAffinity,
} from "./affinity";
import {
  clearCooldownState,
  isAccountPoolEligible,
  isRateLimitStickWait,
  recordPoolAccountCooldown,
  STICK_WAIT_MAX_MS,
} from "./cooldown";
import {
  ACCOUNT_POOL_MAX_FAILOVERS,
  type AccountPoolPickReason,
  type AccountPoolPlugin,
} from "./types";

const UNKNOWN_USAGE_SCORE = 100;
const DEFAULT_AUTO_SWITCH_THRESHOLD = 80;

const failoverCountByPool = new Map<string, Map<string, number>>();

function failoverKey(sessionKey: string | null): string {
  return normalizeAffinityComponent(sessionKey) || "__unbound__";
}

function getFailoverMap(poolKey: string): Map<string, number> {
  let map = failoverCountByPool.get(poolKey);
  if (!map) {
    map = new Map();
    failoverCountByPool.set(poolKey, map);
  }
  return map;
}

export function clearResolveState(poolKey?: string): void {
  if (poolKey === undefined) {
    failoverCountByPool.clear();
    return;
  }
  failoverCountByPool.delete(poolKey);
}

export function clearAccountPoolState(poolKey?: string): void {
  clearResolveState(poolKey);
  clearAffinityState(poolKey);
  clearCooldownState(poolKey);
}

function filterKernelEligible(
  plugin: AccountPoolPlugin,
  ids: readonly string[],
  now: number,
  stickWaitAccountId?: string,
): string[] {
  return ids.filter(id =>
    isAccountPoolEligible(plugin.poolKey, id, now, {
      allowStickWait: stickWaitAccountId === id,
    }),
  );
}

function usageScore(plugin: AccountPoolPlugin, accountId: string): number {
  const score = plugin.usageScore?.(accountId);
  if (typeof score !== "number" || !Number.isFinite(score)) return UNKNOWN_USAGE_SCORE;
  return Math.max(0, Math.min(100, score));
}

function pickLowestUsage(
  plugin: AccountPoolPlugin,
  eligible: readonly string[],
  excludeId?: string,
): string | null {
  const candidates = excludeId ? eligible.filter(id => id !== excludeId) : [...eligible];
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestScore = usageScore(plugin, best);
  for (let i = 1; i < candidates.length; i++) {
    const id = candidates[i]!;
    const score = usageScore(plugin, id);
    if (score < bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

function pickFillFirst(
  eligible: readonly string[],
  activeAccountId: string | undefined,
): string | null {
  if (eligible.length === 0) return null;
  const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
  if (!activeAccountId || !ordered.includes(activeAccountId)) return ordered[0] ?? null;
  const startIdx = ordered.indexOf(activeAccountId);
  for (let step = 1; step <= ordered.length; step++) {
    const candidate = ordered[(startIdx + step) % ordered.length]!;
    if (eligible.includes(candidate)) return candidate;
  }
  return ordered[0] ?? null;
}

function anyCooled(plugin: AccountPoolPlugin, accountIds: readonly string[], now: number): boolean {
  return accountIds.some(id => !isAccountPoolEligible(plugin.poolKey, id, now));
}

function bindIfPossible(
  plugin: AccountPoolPlugin,
  sessionKey: string | null,
  accountId: string | null,
  now: number,
): void {
  if (!accountId) return;
  const key = normalizeAffinityComponent(sessionKey);
  if (!key || !normalizeAffinityComponent(accountId)) return;
  bindSessionAffinity(plugin.poolKey, key, accountId, now);
}

/**
 * Resolve which account should serve this session.
 * Does not call setActiveAccount — callers promote after a usable token.
 */
export function resolvePoolAccount(
  plugin: AccountPoolPlugin,
  sessionKey: string | null,
  opts: {
    strategy: "quota" | "round-robin" | "fill-first";
    enabled: boolean;
    activeAccountId?: string;
    stickyLimit?: number;
    autoSwitchThreshold?: number;
  },
  now = Date.now(),
): { accountId: string | null; reason: AccountPoolPickReason } {
  const allEligible = plugin.listEligibleAccountIds(now);
  if (allEligible.length === 0) {
    return { accountId: null, reason: "none" };
  }

  if (!opts.enabled) {
    const active = opts.activeAccountId;
    if (active && allEligible.includes(active)) {
      return { accountId: active, reason: "disabled" };
    }
    return { accountId: active ?? null, reason: active ? "disabled" : "none" };
  }

  const key = normalizeAffinityComponent(sessionKey);
  if (key) {
    const affined = getSessionAffinity(plugin.poolKey, key, now);
    if (affined) {
      const stickWait = isRateLimitStickWait(plugin.poolKey, affined.accountId, now);
      const eligible = filterKernelEligible(
        plugin,
        allEligible,
        now,
        stickWait ? affined.accountId : undefined,
      );
      if (eligible.includes(affined.accountId)) {
        touchSessionAffinity(plugin.poolKey, key, now);
        return { accountId: affined.accountId, reason: "affinity" };
      }
      clearSessionAffinityForAccount(plugin.poolKey, affined.accountId);
    }
  }

  const kernelEligible = filterKernelEligible(plugin, allEligible, now);
  if (kernelEligible.length === 0) {
    return { accountId: null, reason: anyCooled(plugin, allEligible, now) ? "all-cooled" : "none" };
  }

  const strategy = opts.strategy;
  const stickyLimit = normalizeAccountPoolStickyLimit(opts.stickyLimit);
  const threshold = opts.autoSwitchThreshold ?? DEFAULT_AUTO_SWITCH_THRESHOLD;
  const active = opts.activeAccountId;
  const activeOk = active !== undefined && kernelEligible.includes(active);

  if (strategy === "round-robin") {
    if (!key && activeOk) {
      return { accountId: active, reason: "active" };
    }
    const picked = pickRoundRobinAccount(plugin.poolKey, kernelEligible, stickyLimit);
    if (!picked) {
      return { accountId: null, reason: anyCooled(plugin, allEligible, now) ? "all-cooled" : "none" };
    }
    notePoolRotationSuccess(plugin.poolKey, picked, stickyLimit);
    bindIfPossible(plugin, sessionKey, picked, now);
    return { accountId: picked, reason: "round-robin" };
  }

  if (strategy === "fill-first") {
    if (!key && activeOk) {
      return { accountId: active, reason: "active" };
    }
    const picked = pickFillFirst(kernelEligible, active);
    if (!picked) {
      return { accountId: null, reason: anyCooled(plugin, allEligible, now) ? "all-cooled" : "none" };
    }
    bindIfPossible(plugin, sessionKey, picked, now);
    return { accountId: picked, reason: "fill-first" };
  }

  // quota strategy
  let accountId: string | null = null;
  let reason: AccountPoolPickReason = "none";

  if (plugin.usageScore && threshold > 0) {
    if (activeOk) {
      const activeScore = usageScore(plugin, active);
      const hasKnown = activeScore < UNKNOWN_USAGE_SCORE;
      if (!hasKnown || activeScore < threshold) {
        accountId = active;
        reason = "active";
      } else {
        const picked = pickLowestUsage(plugin, kernelEligible);
        if (picked) {
          accountId = picked;
          reason = activeOk && picked === active ? "active" : "lowest-usage";
        } else if (activeOk) {
          accountId = active;
          reason = "active";
        }
      }
    } else {
      const picked = pickLowestUsage(plugin, kernelEligible);
      if (picked) {
        accountId = picked;
        reason = "only-eligible";
      }
    }
  } else if (activeOk) {
    accountId = active;
    reason = "active";
  } else {
    const picked = pickLowestUsage(plugin, kernelEligible, active);
    if (picked) {
      accountId = picked;
      reason = "only-eligible";
    }
  }

  if (!accountId) {
    return { accountId: null, reason: anyCooled(plugin, allEligible, now) ? "all-cooled" : "none" };
  }

  bindIfPossible(plugin, sessionKey, accountId, now);
  return { accountId, reason };
}

/**
 * Record a rate-limit 429, cool the failed account, and pick a failover account.
 * Billing (402) must use recordPoolAccountCooldown with reason billing — not this path.
 * Does not call setActiveAccount.
 */
export function rotatePoolAccountOn429(
  plugin: AccountPoolPlugin,
  failedAccountId: string,
  sessionKey: string | null,
  retryAfterHeader: string | null,
  now = Date.now(),
): string | null {
  const session = failoverKey(sessionKey);
  const failoverMap = getFailoverMap(plugin.poolKey);
  const prior = failoverMap.get(session) ?? 0;
  if (prior >= ACCOUNT_POOL_MAX_FAILOVERS) return null;

  const cooldownMs = recordPoolAccountCooldown(
    plugin.poolKey,
    failedAccountId,
    "rate_limit",
    retryAfterHeader,
    now,
  );

  if (cooldownMs <= STICK_WAIT_MAX_MS) {
    return null;
  }

  clearSessionAffinityForAccount(plugin.poolKey, failedAccountId);
  notePoolRotationFailure(plugin.poolKey, failedAccountId);

  const eligible = filterKernelEligible(
    plugin,
    plugin.listEligibleAccountIds(now).filter(id => id !== failedAccountId),
    now,
  );
  if (eligible.length === 0) return null;

  const next = pickRoundRobinAccount(plugin.poolKey, eligible, 1) ?? eligible[0] ?? null;
  if (!next) return null;

  failoverMap.set(session, prior + 1);

  const affinityKey = normalizeAffinityComponent(sessionKey);
  if (affinityKey && normalizeAffinityComponent(next)) {
    bindSessionAffinity(plugin.poolKey, affinityKey, next, now);
  }

  return next;
}

export function resetPoolFailoverCount(
  plugin: AccountPoolPlugin,
  sessionKey: string | null,
): void {
  getFailoverMap(plugin.poolKey).delete(failoverKey(sessionKey));
}
