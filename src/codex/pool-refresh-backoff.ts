
/**
 * Per-account cooldown for a stored Codex pool credential whose forced refresh
 * failed without proving the grant is dead.
 *
 * A token-endpoint 5xx, a generation CAS loss, or a network blip is transient
 * (#2887): it must not quarantine the account or drop its binding. Retrying the
 * same doomed refresh on every request, though, is how a single unhealthy
 * account pinned the pool at 503 while healthy siblings sat idle. Consecutive
 * non-terminal failures open a bounded growing cooldown; during that window no
 * new forced refresh starts, and selection prefers a sibling. The first
 * successful refresh clears it.
 */

import { fallbackCodexAccountLogLabel } from "./account-label";

export const CODEX_POOL_REFRESH_INCOMPLETE_LOG_REASON = "codex_pool_refresh_incomplete";

/** Growing delays between forced-refresh attempts for one account. */
export const CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

export class CodexPoolRefreshCooldownError extends Error {
  readonly retryable = true;
  readonly code = "CODEX_REFRESH_COOLING";

  constructor(message = "Codex credential refresh is cooling down") {
    super(message);
    this.name = "CodexPoolRefreshCooldownError";
  }
}

type RefreshFailureBackoff = {
  consecutiveFailures: number;
  cooldownUntil: number;
  reason: string;
};

const backoffByAccount = new Map<string, RefreshFailureBackoff>();
let nowOverride: number | undefined;

export function setCodexPoolRefreshFailureNowForTests(now?: number): void {
  nowOverride = now;
}

export function resetCodexPoolRefreshFailureBackoffForTests(): void {
  backoffByAccount.clear();
  nowOverride = undefined;
}

export function clearCodexPoolRefreshFailure(accountId: string): void {
  backoffByAccount.delete(accountId);
}

function currentNow(now?: number): number {
  return now ?? nowOverride ?? Date.now();
}

function delayFor(consecutiveFailures: number): number {
  const index = Math.min(Math.max(consecutiveFailures, 1), CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS.length) - 1;
  return CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS[index]!;
}

export function getCodexPoolRefreshCooldownUntil(accountId: string, now = currentNow()): number | null {
  const entry = backoffByAccount.get(accountId);
  if (!entry) return null;
  return entry.cooldownUntil > now ? entry.cooldownUntil : null;
}

export function isCodexPoolRefreshCooling(accountId: string, now = currentNow()): boolean {
  return getCodexPoolRefreshCooldownUntil(accountId, now) !== null;
}

/**
 * Record a non-terminal forced-refresh failure. Already-cooling accounts do not
 * grow the window: growth requires another real attempt after the previous one
 * expired. Logs the classified reason once per account per window, with the
 * durable hash label — never a token and never an email.
 */
export function noteCodexPoolRefreshFailure(
  accountId: string,
  reason: string,
  now = currentNow(),
): { consecutiveFailures: number; cooldownUntil: number; openedWindow: boolean } {
  const existing = backoffByAccount.get(accountId);
  if (existing && existing.cooldownUntil > now) {
    return {
      consecutiveFailures: existing.consecutiveFailures,
      cooldownUntil: existing.cooldownUntil,
      openedWindow: false,
    };
  }
  const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
  const cooldownUntil = now + delayFor(consecutiveFailures);
  backoffByAccount.set(accountId, { consecutiveFailures, cooldownUntil, reason });
  const label = fallbackCodexAccountLogLabel(accountId);
  console.warn(
    `[codex-auth] Codex pool account ${label} credential refresh failed (${reason})`,
  );
  return { consecutiveFailures, cooldownUntil, openedWindow: true };
}
