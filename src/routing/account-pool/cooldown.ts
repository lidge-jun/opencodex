import type { CooldownRegistry } from "./types";

export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
export const MAX_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
export const DEFAULT_BILLING_COOLDOWN_MS = 24 * 60 * 60_000;
export const STICK_WAIT_MAX_MS = 5_000;

export type PoolCooldownReason = "rate_limit" | "billing";

interface CooldownEntry {
  until: number;
  source?: string;
  reason?: string;
}

function createRegistry(): CooldownRegistry & { entries: Map<string, CooldownEntry> } {
  const entries = new Map<string, CooldownEntry>();
  return {
    entries,
    set(accountId, until, meta) {
      entries.set(accountId, { until, source: meta?.source, reason: meta?.reason });
    },
    get(accountId, now = Date.now()) {
      const entry = entries.get(accountId);
      if (!entry) return null;
      if (entry.until <= now) {
        entries.delete(accountId);
        return null;
      }
      return { until: entry.until, reason: entry.reason, source: entry.source };
    },
    clear(accountId) {
      entries.delete(accountId);
    },
    sweep(now = Date.now()) {
      let removed = 0;
      for (const [accountId, entry] of entries) {
        if (entry.until > now) continue;
        entries.delete(accountId);
        removed += 1;
      }
      return removed;
    },
  };
}

const registryByPool = new Map<string, CooldownRegistry>();

export function getPoolCooldownRegistry(poolKey: string): CooldownRegistry {
  let registry = registryByPool.get(poolKey);
  if (!registry) {
    registry = createRegistry();
    registryByPool.set(poolKey, registry);
  }
  return registry;
}

export function clearCooldownState(poolKey?: string): void {
  if (poolKey === undefined) {
    registryByPool.clear();
    return;
  }
  registryByPool.delete(poolKey);
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_RATE_LIMIT_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_RATE_LIMIT_COOLDOWN_MS) : undefined;
}

/** Classify HTTP status for account-pool cooldown (billing never enters the 429 hop). */
export function classifyPoolHttpStatus(status: number): PoolCooldownReason | null {
  if (status === 429) return "rate_limit";
  if (status === 402) return "billing";
  return null;
}

function cooldownDurationMs(reason: PoolCooldownReason, retryAfterMs: number | undefined): number {
  if (reason === "billing") {
    return retryAfterMs ?? DEFAULT_BILLING_COOLDOWN_MS;
  }
  return retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

export function recordPoolAccountCooldown(
  poolKey: string,
  accountId: string,
  reason: PoolCooldownReason,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
): number {
  const parsedRetry = reason === "rate_limit" ? parseRetryAfterMs(retryAfterHeader, now) : undefined;
  const cooldownMs = cooldownDurationMs(reason, parsedRetry);
  const registry = getPoolCooldownRegistry(poolKey);
  registry.set(accountId, now + cooldownMs, {
    source: parsedRetry ? "retry-after" : "default",
    reason,
  });
  return cooldownMs;
}

export function isAccountInCooldown(
  poolKey: string,
  accountId: string,
  now = Date.now(),
): { until: number; reason?: string } | null {
  return getPoolCooldownRegistry(poolKey).get(accountId, now);
}

export function isRateLimitStickWait(
  poolKey: string,
  accountId: string,
  now = Date.now(),
): boolean {
  const entry = isAccountInCooldown(poolKey, accountId, now);
  if (!entry || entry.reason !== "rate_limit") return false;
  return entry.until - now <= STICK_WAIT_MAX_MS;
}

export function isAccountPoolEligible(
  poolKey: string,
  accountId: string,
  now: number,
  options?: { allowStickWait?: boolean },
): boolean {
  const entry = isAccountInCooldown(poolKey, accountId, now);
  if (!entry) return true;
  if (options?.allowStickWait && entry.reason === "rate_limit" && entry.until - now <= STICK_WAIT_MAX_MS) {
    return true;
  }
  return false;
}
