import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { DEFAULT_ACCOUNT_PRIORITY, normalizeAccountPriority } from "./pool-rotation";
import type { OcxConfig } from "../types";

/**
 * Which ids may carry a selection order: any pool account, plus the synthetic
 * `__main__` Desktop login. Owned here rather than by the config schema because
 * every writer needs it — the schema rejects a bad key on load, but the management
 * API has to reject one before `setCodexAccountPriority` persists it as an own
 * property that the schema would then reject, degrading the whole map.
 */
export function isCodexAccountPriorityKey(key: unknown): key is string {
  return key === MAIN_CODEX_ACCOUNT_ID || isValidCodexAccountId(key);
}

/**
 * Persisted selection order for one account: higher numbers are used earlier.
 * Stored as a config sidecar rather than a `codexAccounts` row field because the
 * Codex Desktop login (`__main__`) has no row and must be orderable too.
 */
export function getCodexAccountPriority(config: OcxConfig, accountId: string): number {
  return codexAccountPriorityLookup(config)(accountId);
}

/**
 * Write one account's selection order. The default is stored as absence, so a
 * pool that was never ordered keeps no map at all and routing takes its fast path.
 * Entries are rebuilt through `Object.fromEntries` so a reserved key such as
 * `__proto__` becomes an own data property instead of invoking a prototype setter.
 */
export function setCodexAccountPriority(config: OcxConfig, accountId: string, priority: number): void {
  const entries = new Map(Object.entries(config.codexAccountPriorities ?? {}));
  if (priority === DEFAULT_ACCOUNT_PRIORITY) entries.delete(accountId);
  else entries.set(accountId, priority);

  if (entries.size > 0) config.codexAccountPriorities = Object.fromEntries(entries);
  else delete config.codexAccountPriorities;
}

export function forgetCodexAccountPriority(config: OcxConfig, accountId: string): void {
  setCodexAccountPriority(config, accountId, DEFAULT_ACCOUNT_PRIORITY);
}

/**
 * Stable lookup for one selection pass. Routing calls this once per pick and
 * hands the closure to `selectPriorityTier`, so a pool without stored order pays
 * a single map read rather than one per candidate.
 */
export function codexAccountPriorityLookup(config: OcxConfig): (accountId: string) => number {
  const priorities = config.codexAccountPriorities;
  if (!priorities) return () => DEFAULT_ACCOUNT_PRIORITY;
  return accountId => (
    Object.hasOwn(priorities, accountId)
      ? normalizeAccountPriority(priorities[accountId])
      : DEFAULT_ACCOUNT_PRIORITY
  );
}

/**
 * The account an operator most recently selected by hand. While pinned, priority
 * never preempts upward: the pin is a tier *ceiling* for round-robin/fill-first --
 * `selectPriorityTier` skips every tier above the pinned account's, so higher-ordered
 * accounts are suppressed rather than the pinned one being guaranteed -- and a veto in
 * the quota path, until the account crosses the auto-switch threshold.
 */
export function pinnedCodexAccountId(config: OcxConfig): string | undefined {
  return config.activeCodexAccountPinned;
}

export function isCodexAccountPinned(config: OcxConfig, accountId: string): boolean {
  return config.activeCodexAccountPinned === accountId;
}

export function setCodexAccountPin(config: OcxConfig, accountId: string): void {
  config.activeCodexAccountPinned = accountId;
}

/** Release the pin. With `accountId` given, only when it is the pinned account. */
export function clearCodexAccountPin(config: OcxConfig, accountId?: string): void {
  if (accountId === undefined || config.activeCodexAccountPinned === accountId) {
    delete config.activeCodexAccountPinned;
  }
}
