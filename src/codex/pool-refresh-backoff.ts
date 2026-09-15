
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
/**
 * Bumped whenever an account's failures are cleared because something proved them obsolete — a
 * successful refresh, or a replacement credential written by login/reauth. A refresh flight that
 * started before that moment is reporting on a grant that no longer exists, and its late failure
 * must not re-quarantine the credential that replaced it.
 */
const fenceByAccount = new Map<string, number>();
let nowOverride: number | undefined;

export function setCodexPoolRefreshFailureNowForTests(now?: number): void {
  nowOverride = now;
}

export function resetCodexPoolRefreshFailureBackoffForTests(): void {
  backoffByAccount.clear();
  fenceByAccount.clear();
  nowOverride = undefined;
}

/** The value a refresh flight captures before it starts, to be handed back on failure. */
export function codexPoolRefreshFence(accountId: string): number {
  return fenceByAccount.get(accountId) ?? 0;
}

export function clearCodexPoolRefreshFailure(accountId: string): void {
  backoffByAccount.delete(accountId);
  fenceByAccount.set(accountId, (fenceByAccount.get(accountId) ?? 0) + 1);
}

/**
 * Drop every remembered failure. Called when the routing layer discards its per-account state,
 * because a cooldown outliving the binding it was learned alongside would keep an account out of
 * selection for a roster the operator has already replaced.
 */
export function clearAllCodexPoolRefreshFailures(): void {
  backoffByAccount.clear();
}

function currentNow(now?: number): number {
  return now ?? nowOverride ?? Date.now();
}

function delayFor(consecutiveFailures: number): number {
  const index = Math.min(Math.max(consecutiveFailures, 1), CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS.length) - 1;
  return CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS[index]!;
}

/**
 * How many consecutive non-terminal failures must land before a refresh is WITHHELD.
 *
 * Withholding on the first failure was wrong twice over. A single token-endpoint blip is the
 * ordinary case that the very next attempt clears, and -- worse -- a withheld refresh never runs,
 * so an account whose grant is actually revoked can no longer discover that: the terminal 401 it
 * owes the operator turns into a retryable 503 that never resolves. The cooldown exists for the
 * account that keeps failing, not for the one that failed once.
 */
export const CODEX_POOL_REFRESH_COOLDOWN_AFTER_FAILURES = 3;

export function getCodexPoolRefreshCooldownUntil(accountId: string, now = currentNow()): number | null {
  const entry = backoffByAccount.get(accountId);
  if (!entry) return null;
  if (entry.consecutiveFailures < CODEX_POOL_REFRESH_COOLDOWN_AFTER_FAILURES) return null;
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
  fence?: number,
): { consecutiveFailures: number; cooldownUntil: number; openedWindow: boolean } {
  const existing = backoffByAccount.get(accountId);
  // A flight that started before the account's failures were cleared is speaking for a grant
  // that has since been replaced or proven healthy. Recording it would put the new credential
  // back in the quarantine its predecessor earned.
  if (fence !== undefined && fence !== codexPoolRefreshFence(accountId)) {
    return {
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      cooldownUntil: existing?.cooldownUntil ?? 0,
      openedWindow: false,
    };
  }
  // The "do not grow inside an open window" rule applies only once the window is actually
  // WITHHOLDING. Below the threshold no refresh is being withheld, so every failure is a real
  // attempt that really failed and must count -- otherwise a client retrying the 503 once a
  // second can never reach the threshold the cooldown is meant to protect against.
  const withholding = existing !== undefined
    && existing.consecutiveFailures >= CODEX_POOL_REFRESH_COOLDOWN_AFTER_FAILURES;
  if (existing && withholding && existing.cooldownUntil > now) {
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
