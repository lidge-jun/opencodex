import { resetAtToMs, type StoredAccountQuota } from "../quota-types";

// Частичные ответы не должны бесконечно продлевать доказательство short-only.
const SHORT_ONLY_EVIDENCE_TTL_MS = 6 * 60 * 60_000;

function futureReset(reset: number | undefined, now: number): number {
  if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0) return Infinity;
  const millis = resetAtToMs(reset);
  return millis > now ? millis : Infinity;
}

function longestWindow(quota: StoredAccountQuota | null, now: number): { tier: number; reset: number } {
  if (!quota) return { tier: 3, reset: Infinity };
  if (quota.monthlyPercent !== undefined || quota.monthlyResetAt !== undefined) {
    return { tier: 2, reset: futureReset(quota.monthlyResetAt, now) };
  }
  if (quota.weeklyPercent !== undefined || quota.weeklyResetAt !== undefined) {
    return { tier: 1, reset: futureReset(quota.weeklyResetAt, now) };
  }
  const observed = quota.shortOnlyObservedAt;
  if (!quota.customWindows?.length && typeof observed === "number" && Number.isFinite(observed)
    && observed <= now && now - observed <= SHORT_ONLY_EVIDENCE_TTL_MS
    && (quota.shortPercent !== undefined || quota.shortWindowSeconds !== undefined)) {
    return { tier: 0, reset: futureReset(quota.shortResetAt, now) };
  }
  return { tier: 3, reset: Infinity };
}

/** Возвращает стабильный shortlist; окончательный usage tie-break остаётся общим. */
export function preserveLongQuotaCandidates(
  ids: readonly string[], quotaFor: (id: string) => StoredAccountQuota | null, now: number,
): string[] {
  const ranked = ids.map(id => ({ id, ...longestWindow(quotaFor(id), now) }));
  const tier = Math.min(...ranked.map(row => row.tier));
  const sameTier = ranked.filter(row => row.tier === tier);
  const reset = Math.min(...sameTier.map(row => row.reset));
  let candidates = sameTier.filter(row => row.reset === reset).map(row => row.id);
  // Попарное «сравнивать только при наличии обоих» нетранзитивно при трёх аккаунтах.
  const shorts = candidates.map(id => futureReset(quotaFor(id)?.shortResetAt, now));
  if (shorts.every(Number.isFinite)) {
    const shortReset = Math.min(...shorts);
    candidates = candidates.filter((_, index) => shorts[index] === shortReset);
  }
  return candidates;
}
