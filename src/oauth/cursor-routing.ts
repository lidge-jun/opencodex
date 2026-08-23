/**
 * Opt-in Cursor OAuth account pool (shared account-pool kernel).
 *
 * Default OFF. When enabled with ≥2 eligible OAuth accounts:
 * - Sticky session affinity keyed by `_clientThreadId` (not prompt_cache_key)
 * - Bounded 429/auth failover (cap 3; pre-commit only in core.ts)
 * - No new-session spreading (failover-only, like Antigravity)
 *
 * Does not instantiate or wire `CursorCredentialRouter` weighted RR (#2334).
 * Kernel must not call setActiveAccount — callers bind `_cursorIdentityScope` only.
 */
import { fallbackCodexAccountLogLabel } from "../codex/account-label";
import {
  ACCOUNT_POOL_MAX_FAILOVERS,
  bindSessionAffinity,
  clearAccountPoolState,
  clearSessionAffinityForAccount,
  getSessionAffinity,
  isAccountPoolEligible,
  isRateLimitStickWait,
  normalizeAffinityComponent,
  recordPoolAccountCooldown,
  rotatePoolAccountOn429,
  rotatePoolAccountOnAuth,
  touchSessionAffinity,
  type AccountPoolPlugin,
} from "../routing/account-pool";
import type { OcxConfig } from "../types";
import { getAccountSet } from "./store";

export const POOL_KEY_CURSOR = "cursor";
export const CURSOR_POOL_MAX_FAILOVERS_PER_REQUEST = ACCOUNT_POOL_MAX_FAILOVERS;

export interface CursorAccountPoolConfig {
  enabled?: boolean;
}

const cursorPoolPlugin: AccountPoolPlugin = {
  poolKey: POOL_KEY_CURSOR,
  sessionKeyFromRequest: cursorSessionKeyFromParts,
  listEligibleAccountIds(now) {
    return getEligibleCursorAccountIds(now);
  },
};

export function cursorAccountPoolConfig(config: OcxConfig): CursorAccountPoolConfig {
  const raw = config.cursorAccountPool;
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

export function isCursorAccountPoolEnabled(config: OcxConfig): boolean {
  return cursorAccountPoolConfig(config).enabled === true;
}

/** Pool is active only when explicitly enabled and at least two OAuth accounts exist. */
export function isCursorAccountPoolActive(config: OcxConfig, _now = Date.now()): boolean {
  if (!isCursorAccountPoolEnabled(config)) return false;
  const set = getAccountSet(POOL_KEY_CURSOR);
  if (!set) return false;
  return set.accounts.filter(account => account.needsReauth !== true).length >= 2;
}

/**
 * Sticky key for Cursor OAuth pooling — `_clientThreadId` only (not prompt_cache_key).
 */
export function cursorSessionKeyFromParts(input: {
  clientThreadId?: string | null;
}): string | null {
  const key = normalizeAffinityComponent(input.clientThreadId);
  return key || null;
}

function isCursorAccountEligible(accountId: string, now: number): boolean {
  return isAccountPoolEligible(POOL_KEY_CURSOR, accountId, now, {
    allowStickWait: isRateLimitStickWait(POOL_KEY_CURSOR, accountId, now),
  });
}

function getEligibleCursorAccountIds(now: number): string[] {
  const set = getAccountSet(POOL_KEY_CURSOR);
  if (!set) return [];
  return set.accounts
    .filter(account => account.needsReauth !== true && isCursorAccountEligible(account.id, now))
    .map(account => account.id);
}

function nextCursorAccount(
  accountIds: readonly string[],
  afterId: string | undefined,
  now: number,
): string | undefined {
  if (accountIds.length === 0) return undefined;
  const activeIndex = afterId === undefined ? -1 : accountIds.indexOf(afterId);
  const startIndex = activeIndex < 0 ? 0 : activeIndex + 1;
  for (let offset = 0; offset < accountIds.length; offset += 1) {
    const accountId = accountIds[(startIndex + offset) % accountIds.length]!;
    if (afterId !== undefined && accountId === afterId) continue;
    if (isCursorAccountEligible(accountId, now)) return accountId;
  }
  return undefined;
}

function bindCursorAffinityIfPossible(
  sessionKey: string | null | undefined,
  accountId: string,
  now: number,
): void {
  bindSessionAffinity(POOL_KEY_CURSOR, sessionKey, accountId, now);
}

export type CursorAccountSelectionReason =
  | "affinity"
  | "active"
  | "failover"
  | "none"
  | "all-cooled"
  | "pool-disabled";

export interface CursorAccountSelection {
  accountId: string | null;
  reason: CursorAccountSelectionReason;
}

/**
 * Resolve which Cursor OAuth account should serve this session.
 * When the pool is inactive, returns the store active account.
 */
export function resolveCursorAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): CursorAccountSelection {
  const set = getAccountSet(POOL_KEY_CURSOR);
  if (!set || set.accounts.length === 0) return { accountId: null, reason: "none" };

  if (!isCursorAccountPoolActive(config, now)) {
    return { accountId: set.activeAccountId, reason: "pool-disabled" };
  }

  const accountIds = getEligibleCursorAccountIds(now);
  const activeId = set.activeAccountId;
  const key = normalizeAffinityComponent(sessionKey);

  if (key) {
    const affined = getSessionAffinity(POOL_KEY_CURSOR, key, now);
    if (affined && isCursorAccountEligible(affined.accountId, now)) {
      touchSessionAffinity(POOL_KEY_CURSOR, key, now);
      return { accountId: affined.accountId, reason: "affinity" };
    }
    if (affined) {
      const next = nextCursorAccount(accountIds, affined.accountId, now);
      if (next) {
        bindCursorAffinityIfPossible(sessionKey, next, now);
        return { accountId: next, reason: "failover" };
      }
      clearSessionAffinityForAccount(POOL_KEY_CURSOR, affined.accountId);
    }
  }

  if (activeId && accountIds.includes(activeId)) {
    bindCursorAffinityIfPossible(sessionKey, activeId, now);
    return { accountId: activeId, reason: "active" };
  }

  const next = nextCursorAccount(accountIds, activeId, now);
  if (next) {
    bindCursorAffinityIfPossible(sessionKey, next, now);
    return { accountId: next, reason: "failover" };
  }

  const anyCooled = set.accounts.some(account => !isCursorAccountEligible(account.id, now));
  return { accountId: null, reason: anyCooled ? "all-cooled" : "none" };
}

export function bindCursorSessionAffinity(
  sessionKey: string | null | undefined,
  accountId: string,
  now = Date.now(),
): void {
  bindCursorAffinityIfPossible(sessionKey, accountId, now);
}

export function rotateCursorAccountOn429(
  config: OcxConfig,
  failedAccountId: string,
  retryAfterHeader: string | null | undefined,
  sessionKey?: string | null,
  now = Date.now(),
): string | null {
  if (!isCursorAccountPoolActive(config, now)) return null;
  const next = rotatePoolAccountOn429(
    cursorPoolPlugin,
    failedAccountId,
    sessionKey ?? null,
    retryAfterHeader ?? null,
    now,
  );
  if (next) {
    console.warn(
      `[cursor-pool] 429 on ${formatCursorAccountOrdinal(failedAccountId)}; failing over to ${formatCursorAccountOrdinal(next)}`,
    );
  }
  return next;
}

export function rotateCursorAccountOnAuth(
  config: OcxConfig,
  failedAccountId: string,
  sessionKey: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!isCursorAccountPoolActive(config, now)) return null;
  const next = rotatePoolAccountOnAuth(
    cursorPoolPlugin,
    failedAccountId,
    sessionKey ?? null,
    now,
  );
  if (next) {
    console.warn(
      `[cursor-pool] auth failure on ${formatCursorAccountOrdinal(failedAccountId)}; failing over to ${formatCursorAccountOrdinal(next)}`,
    );
  }
  return next;
}

/** Billing exhaustion — long cooldown; must not enter the 429 hop carousel. */
export function recordCursorAccountBillingCooldown(
  accountId: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
): void {
  recordPoolAccountCooldown(POOL_KEY_CURSOR, accountId, "billing", retryAfterHeader, now);
}

/** Test / logout helper. */
export function clearCursorAccountPoolState(): void {
  clearAccountPoolState(POOL_KEY_CURSOR);
}

export function formatCursorAccountOrdinal(accountId: string): string {
  return fallbackCodexAccountLogLabel(accountId);
}

export function formatCursorProviderForLog(
  providerName: string,
  accountId: string | null | undefined,
): string {
  if (!accountId) return providerName;
  return `${providerName}-${formatCursorAccountOrdinal(accountId)}`;
}
