import { saveConfigPreservingClaudeCode } from "../../config";
import { clearCodexAccountPin, pinnedCodexAccountId } from "../account-priority";
import {
  POOL_KEY_CODEX,
  normalizeCodexAccountPoolStrategy,
  seedPoolRotationAccount,
} from "../pool-rotation";
import type { OcxConfig } from "../../types";
import { clearThreadAccountMap } from "./thread-affinity";
import {
  NATIVE_MODEL_QUOTA_SCOPES,
  codexPoolKeyForScope,
  deleteAccountHealth,
  deleteScopedHealth,
  getAccountHealth,
  isIndependentCodexQuotaScope,
  listScopedHealthEntries,
  preservedCooldownFields,
  setAccountHealth,
  setScopedHealth,
  type CodexUpstreamHealth,
} from "./health-store";

/**
 * Process-local cursor for automatic RR/fill-first (and quota-429 when not
 * sync-writing) picks. Keeps unrelated `saveConfig` from persisting transient
 * rotation as the operator's `activeCodexAccountId`. Manual selection clears it
 * so disk/`config.activeCodexAccountId` remains authoritative.
 */
let runtimeActiveCodexAccountId: string | undefined;

/** Manual selection resets transient routing evidence without bypassing a real 429 cooldown. */
export function resetCodexRoutingForManualSelection(accountId: string): void {
  clearThreadAccountMap();
  // Manual selection is the operator source of truth — drop any automatic runtime cursor.
  runtimeActiveCodexAccountId = undefined;
  // Record the pick as an unspent one-shot on the SHARED scope only. An independent scope
  // gets no entry on purpose: every write site the guard protects is already skipped for
  // independent scopes, so an entry there would be state nothing reads — and state nothing
  // reads is what the next reader mistakes for a rule.
  //
  // Seeding happens ONLY here. A pool-driven promote must never create or move a preference,
  // or the pool would manufacture an operator intent nobody expressed.
  manualPreference.set(POOL_KEY_CODEX, accountId);
  // Seed the RR ring so the next unbound new session honors the manually selected account
  // under round-robin (affinity-cleared threads / null threadId). Fill-first already follows
  // config.activeCodexAccountId, which the caller persists before invoking this.
  seedPoolRotationAccount(POOL_KEY_CODEX, accountId);
  for (const scope of new Set(Object.values(NATIVE_MODEL_QUOTA_SCOPES))) {
    if (isIndependentCodexQuotaScope(scope)) {
      seedPoolRotationAccount(codexPoolKeyForScope(scope), accountId);
    }
  }
  // Quota avoidance is a preference, like the soft avoid dropped above, and an operator naming
  // this account has overruled it. The hard cooldown is the part that survives.
  const overrule = (health: CodexUpstreamHealth) => {
    const { quotaAvoidUntil: _avoid, ...retained } = preservedCooldownFields(health);
    return retained;
  };
  const current = getAccountHealth(accountId);
  if (current) {
    const retained = overrule(current);
    if (Object.keys(retained).length === 0) deleteAccountHealth(accountId);
    else setAccountHealth(accountId, { consecutiveFailures: 0, ...retained });
  }
  // A reset-derived refusal records its avoidance on the SCOPED map and returns before the
  // account-wide entry is written, so naming the account has to reach that map too. Stopping
  // at `upstreamHealth` — and returning early when it holds nothing — overruled nothing in
  // the case that produces the avoidance this function exists to overrule.
  for (const [scope, health] of [...(listScopedHealthEntries(accountId))]) {
    const retained = overrule(health);
    if (Object.keys(retained).length === 0) deleteScopedHealth(accountId, scope);
    else setScopedHealth(accountId, scope, { consecutiveFailures: 0, ...retained });
  }
}

/** Effective active: automatic runtime cursor, else operator/persisted selection. */
/**
 * Unspent operator selections, keyed by pool scope.
 *
 * Codex has no account-side equivalent of the Anthropic `selectionRevision`, so staleness
 * cannot be detected by comparing values: a pool-driven promote legitimately moves the
 * persisted active account, and reading that as staleness would silently spend the
 * operator's one-shot. Invalidation is keyed to the OPERATOR path instead — another manual
 * selection, the account leaving the pool, or a successful dispatch on it.
 */
const manualPreference = new Map<string, string>();

/**
 * Spend the one-shot for a pool scope once a dispatch on that account actually succeeded.
 * This is the Codex analogue of `commitAnthropicSelectionRouting`, which Codex lacks.
 *
 * Wiring this BEFORE the guard below is not a style choice. Measured: with the guard in
 * place and no consume site, the first manual selection freezes the automatic cursor
 * permanently and 15 of 69 rotation tests fail.
 */
export function consumeManualPreference(accountId: string, poolKey: string): void {
  if (manualPreference.get(poolKey) === accountId) manualPreference.delete(poolKey);
}

/**
 * Drop an account's preference in every scope. Pause and exclusion do not route through
 * `resetCodexRoutingForManualSelection`, so without this a preference could outlive the
 * account it names and keep suppressing the automatic cursor.
 */
export function forgetManualPreference(accountId: string): void {
  for (const [poolKey, preferred] of manualPreference) {
    if (preferred === accountId) manualPreference.delete(poolKey);
  }
}

/**
 * True while an unspent operator selection for this scope names a DIFFERENT account than
 * the automatic pick about to be recorded.
 *
 * Callers pass their own scope: an independent quota scope keeps its own entry and must
 * never read the shared one. The failover promote does NOT consult this — see its call
 * site for why.
 */
export function manualPreferenceBlocks(poolKey: string, accountId: string): boolean {
  const preferred = manualPreference.get(poolKey);
  return preferred !== undefined && preferred !== accountId;
}

export function getEffectiveActiveCodexAccountId(config: OcxConfig): string | undefined {
  return runtimeActiveCodexAccountId ?? config.activeCodexAccountId;
}

/**
 * Whether the account routing is currently on is there because an operator asked
 * for it, rather than because a strategy landed on it. Surfaces read this instead
 * of comparing the stored pin themselves, which would report a pin that a later
 * automatic pick has already moved past.
 */
export function isEffectiveCodexAccountPinned(config: OcxConfig): boolean {
  const pinned = pinnedCodexAccountId(config);
  return pinned !== undefined && pinned === getEffectiveActiveCodexAccountId(config);
}

/**
 * Automatic strategy / failover cursor only — never mutates `config.activeCodexAccountId`
 * so an unrelated `saveConfig` cannot persist transient rotation as operator selection.
 */
export function rememberActiveCodexAccount(_config: OcxConfig, accountId: string): void {
  runtimeActiveCodexAccountId = accountId;
}

/**
 * End the manual pin when routing moves to a different account. Returns whether
 * the pin changed so the caller can fold it into a write it was already making.
 */
function releaseCodexAccountPinFor(config: OcxConfig, accountId: string): boolean {
  const pinned = pinnedCodexAccountId(config);
  if (pinned === undefined || pinned === accountId) return false;
  clearCodexAccountPin(config);
  return true;
}

/** Persist operator (or quota-strategy) active selection to config + disk. */
export function setActiveCodexAccount(config: OcxConfig, accountId: string): void {
  runtimeActiveCodexAccountId = undefined;
  const releasedPin = releaseCodexAccountPinFor(config, accountId);
  if (config.activeCodexAccountId === accountId && !releasedPin) return;
  config.activeCodexAccountId = accountId;
  saveConfigPreservingClaudeCode(config);
}

/** Quota strategy persists; RR/fill-first keep a process-local cursor only. */
export function promoteActiveCodexAccount(config: OcxConfig, accountId: string): void {
  if (normalizeCodexAccountPoolStrategy(config.accountPoolStrategy) === "quota") {
    setActiveCodexAccount(config, accountId);
    return;
  }
  // Runtime-only, like the cursor itself: a caller that persists (pause, delete)
  // saves this release with its own write; a transient failover does not, so the
  // pin survives a restart that also clears the failure history behind it.
  releaseCodexAccountPinFor(config, accountId);
  rememberActiveCodexAccount(config, accountId);
}

export function clearAllManualPreferences(): void {
  manualPreference.clear();
}

export function forgetRuntimeActiveCodexAccount(): void {
  runtimeActiveCodexAccountId = undefined;
}

export function forgetRoutingPreferencesOutside(codexAccountIds: ReadonlySet<string>): void {
  for (const [poolKey, preferred] of manualPreference) {
    if (codexAccountIds.has(preferred)) continue;
    manualPreference.delete(poolKey);
  }
}
