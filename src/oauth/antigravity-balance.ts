import type { ProviderQuota } from "../providers/quota-types";

const MAX_QUOTA_AGE_MS = 5 * 60_000;
const BALANCE_BAND = 5;

export function antigravityQuotaFamily(modelId = ""): string {
  return /claude/i.test(modelId) ? "Cla" : /gemini/i.test(modelId) ? "Gem" : "all";
}

/** Percent USED, scoped to the requested model family. Stale/reset readings are unknown. */
export function antigravityBalanceUsage(quota: ProviderQuota | null | undefined, family: string, now: number): number | null {
  if (!quota || now - quota.updatedAt > MAX_QUOTA_AGE_MS) return null;
  const windows = (quota.customWindows ?? []).filter(w => family === "all" || w.label === family);
  const values = windows.length > 0
    ? windows.filter(w => !w.resetAt || w.resetAt > now).map(w => w.percent)
    : [quota.fiveHourResetAt && quota.fiveHourResetAt <= now ? undefined : quota.fiveHourPercent,
       quota.weeklyResetAt && quota.weeklyResetAt <= now ? undefined : quota.weeklyPercent];
  const valid = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return valid.length ? Math.max(0, Math.min(100, Math.max(...valid))) : null;
}

/** Request reservations break ties immediately, including concurrent dispatches. */
export class AntigravityBalancer {
  private sequence = 0;
  private lastPicked = new Map<string, number>();

  clear(): void { this.sequence = 0; this.lastPicked.clear(); }

  pick(candidates: readonly { id: string; usage: number | null }[], family: string): string | null {
    const known = candidates.flatMap(c => c.usage === null ? [] : [c.usage]);
    const minimum = known.length ? Math.min(...known) : 0;
    // Unknown accounts must get sampled, not be permanently starved by measured ones.
    const eligible = candidates.filter(c => c.usage === null || (c.usage < 100 && c.usage <= minimum + BALANCE_BAND));
    const pool = eligible.length ? eligible : candidates;
    let best: string | null = null;
    let oldest = Infinity;
    for (const c of pool) {
      const order = this.lastPicked.get(`${family}:${c.id}`) ?? 0;
      if (order < oldest) { best = c.id; oldest = order; }
    }
    if (best) this.lastPicked.set(`${family}:${best}`, ++this.sequence);
    // Bound state to the current roster; three family slots per account.
    const ids = new Set(candidates.map(c => c.id));
    for (const key of this.lastPicked.keys()) {
      if (!ids.has(key.slice(key.indexOf(":") + 1))) this.lastPicked.delete(key);
    }
    return best;
  }
}
