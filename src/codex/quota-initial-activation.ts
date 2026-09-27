import { mutatePersistedConfig } from "../config";
import { normalizeResetAt } from "../providers/quota-wire";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { providerCodexAccountMode } from "../providers/registry";
import type { OcxConfig } from "../types";
import { isSelectableCodexPoolAccount, MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import type { StoredAccountQuota } from "./quota-types";
import { initialWindowObservations, type InitialWindow } from "./quota-auto-refresh-state";

export const INITIAL_ACTIVATION_RETRY_MS = 300_000;
const PROBE_MS = 60_000;
const MIN_MOVEMENT_MS = 30_000;
const RESET_SLOP_MS = 3_000;
const DURATIONS = { fiveHour: 18_000_000, weekly: 604_800_000 } as const;

export function initialActivationRetryBlocked(config: OcxConfig, accountId: string, now: number): boolean {
  const last = normalizeResetAt(config.codexQuotaAutoRefresh?.[accountId]?.lastInitialActivationAttemptAt);
  return last !== undefined && now - last < INITIAL_ACTIVATION_RETRY_MS;
}

/** Two fresh zero-use snapshots must move together; 0% alone does not prove an idle window. */
export function inspectInitialQuotaActivation(
  config: OcxConfig, accountId: string, quota: StoredAccountQuota | null, binding: string, now: number,
): { probe: boolean; windows: InitialWindow[] } {
  const empty = { probe: false, windows: [] as InitialWindow[] };
  const setting = config.codexQuotaAutoRefresh?.[accountId];
  if (!setting || !binding || !quota || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(quota.updatedAt) || now < quota.updatedAt
    || now - quota.updatedAt > INITIAL_ACTIVATION_RETRY_MS
    || initialActivationRetryBlocked(config, accountId, now)) {
    initialWindowObservations.delete(accountId);
    return empty;
  }
  const previous = initialWindowObservations.get(accountId);
  const prior = previous?.binding === binding ? previous : undefined;
  const next: NonNullable<typeof prior> = { binding, observedAt: now,
    probeAfter: prior?.probeAfter ?? now + PROBE_MS, windows: {} };
  for (const name of ["fiveHour", "weekly"] as const) {
    const percent = name === "fiveHour" ? quota.shortPercent : quota.weeklyPercent;
    const observedAt = name === "fiveHour" ? quota.shortObservedAt ?? quota.updatedAt : quota.updatedAt;
    const resetAt = normalizeResetAt(name === "fiveHour" ? quota.shortResetAt : quota.weeklyResetAt);
    if (setting[name] !== true || percent !== 0 || resetAt === undefined
      || (name === "fiveHour" && quota.shortWindowSeconds !== 18_000)
      || !Number.isSafeInteger(observedAt) || now < observedAt
      || now - observedAt > INITIAL_ACTIVATION_RETRY_MS
      || Math.abs(resetAt - observedAt - DURATIONS[name]) > RESET_SLOP_MS) continue;
    const old = prior?.windows[name];
    const elapsed = old ? observedAt - old.observedAt : 0;
    const ready = !!old && (observedAt === old.observedAt && resetAt === old.resetAt ? old.ready
      : elapsed >= MIN_MOVEMENT_MS && elapsed <= INITIAL_ACTIVATION_RETRY_MS
        && Math.abs((resetAt - old.resetAt) - elapsed) <= RESET_SLOP_MS);
    next.windows[name] = { observedAt, resetAt, ready };
  }
  const names = Object.keys(next.windows) as InitialWindow[];
  if (names.length === 0) { initialWindowObservations.delete(accountId); return empty; }
  initialWindowObservations.set(accountId, next);
  return { probe: now >= next.probeAfter, windows: names.filter(name => next.windows[name]!.ready) };
}

/** A failed observation never becomes a busy polling loop. */
export function noteInitialQuotaProbe(accountId: string, now: number): void {
  const observed = initialWindowObservations.get(accountId);
  if (observed) observed.probeAfter = now + PROBE_MS;
}

/** Persist intent before inference, so a restart cannot immediately repeat an uncertain attempt. */
export function reserveInitialQuotaActivation(
  config: OcxConfig, accountId: string, windows: readonly InitialWindow[], now: number,
): boolean {
  if (!windows.length || !Number.isSafeInteger(now) || now < 0) return false;
  try {
    const result = mutatePersistedConfig(persisted => {
      const current = persisted.codexQuotaAutoRefresh?.[accountId];
      const provider = persisted.providers[OPENAI_CODEX_PROVIDER_ID];
      const last = normalizeResetAt(current?.lastInitialActivationAttemptAt);
      if (!current || !windows.some(name => current[name] === true)
        || !provider || provider.disabled === true || !isCanonicalOpenAiForwardProvider(provider)
        || providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, provider) !== "pool"
        || persisted.pausedCodexAccountIds?.includes(accountId)
        || (accountId !== MAIN_CODEX_ACCOUNT_ID && !persisted.codexAccounts?.some(account => account.id === accountId && isSelectableCodexPoolAccount(account)))
        || (last !== undefined && now - last < INITIAL_ACTIVATION_RETRY_MS)) return { changed: false, value: null };
      const updated = { ...current, lastInitialActivationAttemptAt: now };
      persisted.codexQuotaAutoRefresh = { ...persisted.codexQuotaAutoRefresh, [accountId]: updated };
      return { changed: true, value: updated };
    });
    if (result.status === "unavailable" || !result.value) return false;
    config.codexQuotaAutoRefresh = { ...config.codexQuotaAutoRefresh, [accountId]: result.value };
    initialWindowObservations.delete(accountId);
    return true;
  } catch { return false; }
}
