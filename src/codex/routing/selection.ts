import { isCodexAccountPaused } from "../account-pause";
import { codexAccountPriorityLookup, pinnedCodexAccountId } from "../account-priority";
import { isSelectableCodexPoolAccount } from "../account-id";
import { isAccountNeedsReauth } from "../account-runtime-state";
import { isCodexAccountUsable, type CodexAccountUsabilityOptions } from "../account-usability";
import { isCodexPoolRefreshCooling } from "../pool-refresh-backoff";
import {
  normalizeAccountPoolStickyLimit,
  normalizeCodexAccountPoolStrategy,
  notePoolRotationSuccess,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  selectPriorityTier,
} from "../pool-rotation";
import { CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota, resetAtToMs } from "../quota";
import { codexPlanKey } from "../plan";
import { MAIN_CODEX_ACCOUNT_ID, getMainAccountPlan, hasMainAccountRefreshGrant } from "../main-account";
import type { OcxConfig } from "../../types";
import { CODEX_FAILURE_WINDOW_MS, computeCodexUsageScore } from "./cooldown-math";
import {
  codexPoolKeyForScope,
  dropSpentCredentialFailure,
  getAccountHealth,
  getCodexQuotaHealthSnapshot,
  hasUnrecoveredCodexQuotaRefusal,
  isCodexAccountSoftAvoided,
  isCodexQuotaAvoided,
  isIndependentCodexQuotaScope,
  type CodexQuotaScope,
} from "./health-store";
import { bindThreadAffinity, type CodexAffinityReason } from "./thread-affinity";
import {
  getEffectiveActiveCodexAccountId,
  manualPreferenceBlocks,
  promoteActiveCodexAccount,
  rememberActiveCodexAccount,
  setActiveCodexAccount,
} from "./active-account";

/**
 * Plan keys the operator excluded from automatic rotation. Absent or empty means no policy, so an
 * existing install rotates exactly as before. Compared with `codexPlanKey` because the stored plan
 * is an unrestricted provider string whose casing this repository does not control.
 */
function excludedCodexPoolPlanKeys(config: OcxConfig): ReadonlySet<string> | undefined {
  const configured = config.codexPool?.excludedPlans;
  if (!configured?.length) return undefined;
  const keys = configured
    .map(plan => codexPlanKey(plan))
    .filter((key): key is string => key !== undefined);
  return keys.length > 0 ? new Set(keys) : undefined;
}

/**
 * Whether the operator's plan policy removes this account from automatic selection.
 *
 * Modelled on pause rather than usability: an excluded account keeps its credential, quota history,
 * and affinity, stays visible on the account surface, and is still reachable by explicit account
 * selection. Only automatic rotation skips it, which is the distinction #4211 asked for.
 *
 * It is checked in the same two places pause is checked, and that is not redundancy. The eligible
 * list is consulted only when routing picks a NEW account; an already-active or already-affined
 * account is served straight from {@link isCodexAccountSelectable}. A lapsed subscription leaves
 * behind exactly that account, so a policy that filtered only the eligible list would miss the case
 * it exists for.
 *
 * `__main__` is exempt. {@link getPoolAccountPlanForSelection} withholds the main plan during a
 * selection-only drain so routing never reads the fenced native credential for it, so a rule that
 * covered main would disagree with itself between drain and ordinary routing.
 */
export function isCodexAccountPlanExcluded(
  config: OcxConfig,
  accountId: string,
  precomputed?: ReadonlySet<string>,
): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return false;
  // Callers that test a whole list pass the set once rather than rebuilding it per row.
  const excluded = precomputed ?? excludedCodexPoolPlanKeys(config);
  if (!excluded) return false;
  const plan = codexPlanKey(getPoolAccountPlan(config, accountId));
  return plan !== undefined && excluded.has(plan);
}

export function isCodexAccountSelectable(
  config: OcxConfig,
  accountId: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): boolean {
  return !isCodexAccountPaused(config, accountId)
    && !isCodexAccountPlanExcluded(config, accountId)
    && getCodexQuotaHealthSnapshot(accountId, quotaScope, now) === null
    && !isCodexQuotaAvoided(accountId, quotaScope, now)
    && !isCodexAccountSoftAvoided(accountId, now)
    && !isCodexPoolRefreshCooling(accountId, now)
    && isCodexAccountUsable(config, accountId, selectionOptions);
}

/**
 * Which guard in {@link isCodexAccountSelectable} refused this account, if any.
 *
 * Deliberately the same predicates in the same order as that function, because the point is to
 * REPORT the guard that actually fired rather than to re-derive a plausible-looking cause. An
 * earlier version of the release reason checked only a subset and let a paused, plan-excluded,
 * cooled-down or quota-avoided release fall through to a quota fallback, which named something
 * routing never used -- a diagnostic that is confidently wrong in exactly the cases an operator
 * would consult it for (#4598).
 */
export function codexAccountBlockReason(
  config: OcxConfig,
  accountId: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): CodexAffinityReason | undefined {
  if (isCodexAccountPaused(config, accountId)) return "paused";
  if (isCodexAccountPlanExcluded(config, accountId)) return "plan_excluded";
  if (getCodexQuotaHealthSnapshot(accountId, quotaScope, now) !== null) return "cooldown";
  if (isCodexQuotaAvoided(accountId, quotaScope, now)) return "quota_avoided";
  if (isCodexAccountSoftAvoided(accountId, now)) return "transient";
  if (isCodexPoolRefreshCooling(accountId, now)) return "transient";
  if (!isCodexAccountUsable(config, accountId, selectionOptions)) return "unusable";
  return undefined;
}

/**
 * Drop accounts a confirmed roster says cannot serve this model, unless that leaves nothing.
 *
 * The restore-on-empty is the whole safety argument, not a defensive afterthought. Roster
 * evidence can be wrong in the direction that matters: a shard that has not caught up reports a
 * denial for a model the account genuinely owns, and #3022 is what happens when absence is
 * allowed to remove a model outright. Because this can only ever return a non-empty subset of a
 * list the caller already computed, no pool that would have found a working account can be left
 * without one — the worst case is the selection that ships today.
 *
 * It is an ordering rule rather than an eligibility one for the same reason. Nothing below
 * reports `model_not_entitled`, nothing refuses before dispatch, and the existing bounded
 * alternate-account retry on an exact unsupported-model 400 stays exactly where it is as the
 * safety net. This only stops the pool from CHOOSING an account that has already told us it
 * cannot serve the model (#4768).
 *
 * An operator's manual pin is never dropped. Roster evidence orders the pool's own discretion;
 * it does not overrule an explicit human choice, and removing the pinned account here would do
 * more than demote it -- `selectPriorityTier` reads the pin to lower the tier ceiling, so a pin
 * filtered out beforehand stops acting as a ceiling at all and silently re-enables tiers the
 * operator had excluded. An operator who pins an account upstream will refuse still gets the
 * alternate-account retry; what they do not get is the pool quietly deciding they were wrong.
 */
export function withoutModelDeniedAccounts(
  ids: readonly string[],
  denied: ReadonlySet<string> | undefined,
  pinned?: string,
): readonly string[] {
  if (denied === undefined || ids.length === 0) return ids;
  const remaining = ids.filter(id => !denied.has(id) || id === pinned);
  return remaining.length > 0 ? remaining : ids;
}

export function getEligiblePoolAccounts(
  config: OcxConfig,
  excludeId?: string,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  skipFailoverReadyCandidates = false,
): readonly string[] {
  const excludedPlans = excludedCodexPoolPlanKeys(config);
  const ids = (config.codexAccounts ?? [])
    .filter(account => isSelectableCodexPoolAccount(account)
      && account.id !== excludeId
      && !isCodexAccountPaused(config, account.id)
      && !isCodexAccountPlanExcluded(config, account.id, excludedPlans)
      && !isAccountNeedsReauth(account.id)
      && (!skipFailoverReadyCandidates || !shouldFailover(config, account.id, now)))
    .filter(account => getCodexQuotaHealthSnapshot(account.id, quotaScope, now) === null)
    .filter(account => !isCodexAccountSoftAvoided(account.id, now))
    .filter(account => !isCodexQuotaAvoided(account.id, quotaScope, now))
    .filter(account => !isCodexPoolRefreshCooling(account.id, now))
    .filter(account => isCodexAccountUsable(config, account.id, selectionOptions))
    .map(account => account.id);
  // The main Codex account is not stored in config.codexAccounts; include it as a
  // first-class rotation candidate when its read-only token is usable (Option A).
  if (
    excludeId !== MAIN_CODEX_ACCOUNT_ID
    && !isCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID)
    && (!isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID) || hasMainAccountRefreshGrant())
    && getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, quotaScope, now) === null
    && !isCodexAccountSoftAvoided(MAIN_CODEX_ACCOUNT_ID, now)
    // The main login is not in `config.codexAccounts`, so it never passes through the
    // filters above and this is the only place an avoidance window can exclude it. Without
    // this the window a refusal announced applies to the pool but not to the account that
    // earned it: the cooldown caps at fifteen minutes, the window runs up to six hours, and
    // in between the main account returns as a first-class candidate.
    && !isCodexQuotaAvoided(MAIN_CODEX_ACCOUNT_ID, quotaScope, now)
    && !isCodexPoolRefreshCooling(MAIN_CODEX_ACCOUNT_ID, now)
    && (!skipFailoverReadyCandidates || !shouldFailover(config, MAIN_CODEX_ACCOUNT_ID, now))
    && isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID, selectionOptions)
  ) {
    ids.unshift(MAIN_CODEX_ACCOUNT_ID);
  }
  // Single choke point for selection order: every strategy, failover, and preview
  // reaches the pool through here, so tiering applies once rather than per picker.
  // Eligibility above is unchanged — this only narrows an already-eligible list.
  //
  // Model entitlement is applied BEFORE the priority tier, because a tier is a quota-ordering
  // question and an account that cannot serve the model at all should not be the reason a tier
  // is selected. Both steps narrow an already-eligible list and neither can empty it.
  const pinned = pinnedCodexAccountId(config);
  return selectPriorityTier(
    withoutModelDeniedAccounts(ids, selectionOptions?.deniedModelAccountIds, pinned),
    codexAccountPriorityLookup(config),
    id => hasCodexQuotaHeadroom(config, id, selectionOptions, now),
    pinned,
  );
}

function listEligibleCodexAccountIds(
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): readonly string[] {
  return getEligiblePoolAccounts(config, undefined, now, quotaScope, selectionOptions);
}

/** Shared reset timestamps are not evidence for independent model-quota groups. */
export function accountPoolStrategyForScope(config: OcxConfig, quotaScope?: CodexQuotaScope) {
  const strategy = normalizeCodexAccountPoolStrategy(config.accountPoolStrategy);
  return strategy === "reset-first" && isIndependentCodexQuotaScope(quotaScope) ? "quota" : strategy;
}

function stickyLimitForConfig(config: OcxConfig): number {
  return normalizeAccountPoolStickyLimit(config.accountPoolStickyLimit);
}

/**
 * Whether an account still has quota to give under the auto-switch threshold.
 *
 * Fill-first and the priority tier filter share this predicate, and share both of
 * its escape hatches. A disabled threshold means only health, pause, and reauth
 * may drain an account; unknown usage is a guess, so it must neither force
 * fill-first off the active account nor drain a tier that was simply never
 * primed. A genuinely exhausted account 429s into cooldown and leaves
 * eligibility on its own.
 */
export function hasCodexQuotaHeadroom(
  config: OcxConfig,
  accountId: string,
  selectionOptions?: CodexAccountUsabilityOptions,
  now: number = Date.now(),
): boolean {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return true;
  const usage = computeCodexUsageScore(
    getAccountQuota(accountId),
    getPoolAccountPlanForSelection(config, accountId, selectionOptions),
    now,
  );
  if (isUnknownUsage(usage)) return true;
  return usage < threshold;
}

/**
 * Is a live binding held for its prompt cache?
 *
 * Unset means yes. Cache affinity shipped as an opt-in flag (#4292) and then #4546 measured
 * what the default costs: a pool whose accounts all sit in the 80-99% band hands a bound
 * conversation from account to account, and because provider prompt caches are account-isolated
 * every hop re-sends the entire prefix. An install that has never heard of this flag is exactly
 * the install that gets hurt by it, so the protection cannot be something you have to find.
 *
 * `false` restores capacity-first routing byte-for-byte. It is a real choice -- a pinned thread
 * on a busy account pays latency -- and it stays available; it is just no longer the default.
 */
export function isCacheAffinityEnabled(config: OcxConfig): boolean {
  return config.pool?.cacheAffinity !== false;
}

/**
 * Whether quota may retire shared state while cache affinity is active.
 *
 * A threshold crossing is a hint that an account is getting busy, not evidence it cannot
 * serve — the same bar {@link mayRebindAffinityForQuota} applies to a live binding. Shared
 * state held across a model detour gets that exhaustion boundary for the same reason: the
 * detour is request-scoped, so retiring the binding over a hint pays a cold prefix for
 * nothing. New/unbound selection still reads {@link hasCodexQuotaHeadroom}; only
 * preservation of an existing shared selection or thread binding qualifies here. Like the
 * live-binding rule, the configured threshold plays no role once retention applies: a
 * genuinely exhausted (>=100%) account releases even with threshold switching disabled,
 * while the fallback above keeps a disabled threshold's "never drained on quota alone".
 */
export function hasCodexSharedStateQuotaHeadroom(
  config: OcxConfig,
  accountId: string,
  quotaScope: CodexQuotaScope | undefined,
  selectionOptions?: CodexAccountUsabilityOptions,
  now: number = Date.now(),
): boolean {
  if (
    !isCacheAffinityEnabled(config)
    || accountPoolStrategyForScope(config, quotaScope) !== "quota"
  ) {
    return hasCodexQuotaHeadroom(config, accountId, selectionOptions, now);
  }
  const usage = computeCodexUsageScore(
    getAccountQuota(accountId),
    getPoolAccountPlanForSelection(config, accountId, selectionOptions),
    now,
  );
  return isUnknownUsage(usage) || usage < 100;
}

/** Earliest future shared short/weekly reset; missing evidence and ties use usage order. */
export function pickResetFirstCodexAccount(
  config: OcxConfig,
  ids: readonly string[],
  now: number,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const available = ids.filter(id => hasCodexQuotaHeadroom(config, id, selectionOptions, now));
  if (available.length === 0) return pickLowestUsageAmong(config, ids, selectionOptions, now);
  let earliest = Number.POSITIVE_INFINITY;
  let candidates: string[] = [];
  for (const id of available) {
    const quota = getAccountQuota(id);
    const resets = [quota?.shortResetAt, quota?.weeklyResetAt]
      .filter((reset): reset is number => typeof reset === "number" && Number.isFinite(reset))
      .map(resetAtToMs)
      .filter(reset => reset > now);
    const next = Math.min(...resets);
    if (next < earliest) {
      earliest = next;
      candidates = [id];
    } else if (next === earliest) candidates.push(id);
  }
  return pickLowestUsageAmong(config, candidates, selectionOptions, now);
}

/**
 * Fill-first: keep selectable active under threshold; otherwise advance to the next
 * eligible id in stable sorted order after the current active (wrapping).
 */
function pickFillFirstCodexAccount(
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const eligible = listEligibleCodexAccountIds(config, now, quotaScope, selectionOptions);
  if (eligible.length === 0) return null;

  const active = getEffectiveActiveCodexAccountId(config);
  if (active && eligible.includes(active) && hasCodexQuotaHeadroom(config, active, selectionOptions, now)) {
    return active;
  }

  return pickNextFillFirstCodexAccount(config, active ?? null, eligible, now, selectionOptions);
}

/** Next eligible account in stable order after `afterId` (wrapping). */
function pickNextFillFirstCodexAccount(
  config: OcxConfig,
  afterId: string | null,
  eligible: readonly string[] = listEligibleCodexAccountIds(config, Date.now()),
  now = Date.now(),
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  if (eligible.length === 0) return null;
  const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
  if (!afterId) {
    // Prefer an under-threshold account when starting with no active cursor.
    for (const id of ordered) {
      if (hasCodexQuotaHeadroom(config, id, selectionOptions, now)) return id;
    }
    return ordered[0] ?? null;
  }

  const allConfigured = [
    ...(isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID, selectionOptions) || afterId === MAIN_CODEX_ACCOUNT_ID
      ? [MAIN_CODEX_ACCOUNT_ID]
      : []),
    ...(config.codexAccounts ?? []).filter(account => !account.isMain).map(account => account.id),
  ];
  const stableAll = [...new Set(allConfigured)].sort((a, b) => a.localeCompare(b));
  const startIdx = stableAll.indexOf(afterId);
  if (startIdx < 0) {
    for (const id of ordered) {
      if (hasCodexQuotaHeadroom(config, id, selectionOptions, now)) return id;
    }
    return ordered[0] ?? null;
  }

  // Skip successors that are also at/above threshold (known drained usage).
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(startIdx + step) % stableAll.length]!;
    if (!eligible.includes(candidate)) continue;
    if (!fallback) fallback = candidate;
    if (hasCodexQuotaHeadroom(config, candidate, selectionOptions, now)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

/**
 * Unbound new-session pick for round-robin / fill-first. Returns null to fall through
 * to the legacy quota path (or when the strategy is quota).
 *
 * When `commit` is true (resolve path), advances RR state. `commitSharedActive`
 * and `commitAffinity` independently control the two cross-request side effects:
 * model-scoped entitlement selection can bind a new task without replacing an
 * existing task binding or global active choice. Preview remains a dry-run peek.
 *
 * Automatic strategy picks never sync-write config; only manual selection persists active.
 *
 * Known limitation (follow-up): when a subagent preview peeks an RR account and the request
 * then falls back to a non-Codex provider, the ring is not reserved/committed. Prefer seeding
 * the peeked account if that path becomes load-bearing.
 */
export function pickUnboundStrategyAccount(
  config: OcxConfig,
  threadId: string | null,
  now: number,
  commit: boolean,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  commitSharedActive = commit,
  commitAffinity = commit,
): string | null {
  const strategy = accountPoolStrategyForScope(config, quotaScope);
  if (strategy === "quota") return null;
  const poolKey = codexPoolKeyForScope(quotaScope);

  let picked: string | null = null;
  if (strategy === "round-robin") {
    const eligible = listEligibleCodexAccountIds(config, now, quotaScope, selectionOptions);
    const limit = stickyLimitForConfig(config);
    if (!commit) {
      return peekRoundRobinAccount(poolKey, eligible, limit);
    }
    picked = pickRoundRobinAccount(poolKey, eligible, limit);
    if (!picked) return null;
    if (commitSharedActive) {
      if (!isIndependentCodexQuotaScope(quotaScope)
        && !manualPreferenceBlocks(codexPoolKeyForScope(quotaScope), picked)) {
        rememberActiveCodexAccount(config, picked);
      }
    }
    if (commitAffinity && threadId) bindThreadAffinity(threadId, picked, now, quotaScope);
    notePoolRotationSuccess(poolKey, picked, limit);
    return picked;
  }

  if (strategy === "fill-first" || strategy === "reset-first") {
    picked = strategy === "reset-first"
      ? pickResetFirstCodexAccount(config, listEligibleCodexAccountIds(config, now, quotaScope, selectionOptions), now, selectionOptions)
      : pickFillFirstCodexAccount(config, now, quotaScope, selectionOptions);
    if (!picked) return null;
    if (commitSharedActive) {
      if (!isIndependentCodexQuotaScope(quotaScope)
        && !manualPreferenceBlocks(codexPoolKeyForScope(quotaScope), picked)) {
        rememberActiveCodexAccount(config, picked);
      }
    }
    if (commitAffinity && threadId) bindThreadAffinity(threadId, picked, now, quotaScope);
    return picked;
  }

  return null;
}

export function getPoolAccountPlan(config: OcxConfig, accountId: string): string | undefined {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return getMainAccountPlan();
  return (config.codexAccounts ?? [])
    .find(account => isSelectableCodexPoolAccount(account) && account.id === accountId)?.plan;
}

/** Selection-only main routing must not lazily read the fenced native credential for its plan. */
export function getPoolAccountPlanForSelection(
  config: OcxConfig,
  accountId: string,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | undefined {
  if (accountId === MAIN_CODEX_ACCOUNT_ID && selectionOptions?.nativeMainSelectionOnly === true) {
    return undefined;
  }
  return getPoolAccountPlan(config, accountId);
}

/** Shared routing state must ignore a request-scoped entitlement roster. */
export function sharedStateSelectionOptions(
  selectionOptions?: CodexAccountUsabilityOptions,
): Pick<
  CodexAccountUsabilityOptions,
  "nativeMainSelectionOnly" | "isMainAccountTokenLive"
> | undefined {
  if (!selectionOptions) return undefined;
  return {
    ...(selectionOptions.nativeMainSelectionOnly !== undefined
      ? { nativeMainSelectionOnly: selectionOptions.nativeMainSelectionOnly }
      : {}),
    ...(selectionOptions.isMainAccountTokenLive
      ? { isMainAccountTokenLive: selectionOptions.isMainAccountTokenLive }
      : {}),
  };
}

export function pickLowerUsageAccount(
  config: OcxConfig,
  active: string,
  activeUsage: number,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  skipFailoverReadyCandidates = false,
): string {
  let best = active;
  let bestUsage = activeUsage;
  for (const id of getEligiblePoolAccounts(
    config,
    active,
    now,
    quotaScope,
    selectionOptions,
    skipFailoverReadyCandidates,
  )) {
    const usage = computeCodexUsageScore(
      getAccountQuota(id),
      getPoolAccountPlanForSelection(config, id, selectionOptions),
      now,
    );
    if (usage < bestUsage) {
      best = id;
      bestUsage = usage;
    }
  }
  return best;
}

/** Coolest account in an already-selected candidate list; first index wins ties. */
export function pickLowestUsageAmong(
  config: OcxConfig,
  ids: readonly string[],
  selectionOptions?: CodexAccountUsabilityOptions,
  now: number = Date.now(),
): string | null {
  let best: string | null = null;
  let bestUsage = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const usage = computeCodexUsageScore(
      getAccountQuota(id),
      getPoolAccountPlanForSelection(config, id, selectionOptions),
      now,
    );
    if (usage < bestUsage) {
      best = id;
      bestUsage = usage;
    }
  }
  return best;
}

export function pickLowestUsageCodexAccount(
  config: OcxConfig,
  excludeId?: string,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  return pickLowestUsageAmong(
    config,
    getEligiblePoolAccounts(config, excludeId, now, quotaScope, selectionOptions),
    selectionOptions,
    now,
  );
}

/**
 * Strategy-aware alternate after a cooled/excluded account (same-request 429 retry
 * and active promotion). Quota keeps lowest-usage; fill-first advances stable order;
 * round-robin takes the next ring pick (caller should have noted the failure).
 */
export function pickAlternateCodexAccount(
  config: OcxConfig,
  excludeId: string,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const strategy = accountPoolStrategyForScope(config, quotaScope);
  // The exclusion is passed into eligibility rather than post-filtered off its
  // result: when the excluded account is the only healthy member of the top
  // tier, the tier walk must be free to descend instead of selecting that tier
  // and then handing back an empty list.
  if (strategy === "round-robin") {
    const eligible = getEligiblePoolAccounts(config, excludeId, now, quotaScope, selectionOptions);
    return pickRoundRobinAccount(codexPoolKeyForScope(quotaScope), eligible, stickyLimitForConfig(config));
  }
  if (strategy === "fill-first") {
    const eligible = getEligiblePoolAccounts(config, excludeId, now, quotaScope, selectionOptions);
    return pickNextFillFirstCodexAccount(config, excludeId, eligible, now, selectionOptions);
  }
  if (strategy === "reset-first") {
    return pickResetFirstCodexAccount(config, getEligiblePoolAccounts(config, excludeId, now, quotaScope, selectionOptions), now, selectionOptions);
  }
  return pickLowestUsageCodexAccount(config, excludeId, now, quotaScope, selectionOptions);
}

/**
 * The account {@link pickAlternateCodexAccount} WOULD return, without returning it.
 *
 * Only the round-robin branch has a side effect -- `pickRoundRobinAccount` commits the pick and
 * advances the ring -- so every other strategy delegates rather than growing a second copy of
 * the selection rule that could drift from it.
 *
 * This exists because preview and resolve have to agree on the FIRST transient detour, not just
 * on later ones. Preview feeds subagent model-availability scoring, so a preview that reported
 * the bound account while resolve was about to serve from a cool sibling could retire a model
 * over usage the request would never have touched.
 */
export function peekAlternateCodexAccount(
  config: OcxConfig,
  excludeId: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  if (accountPoolStrategyForScope(config, quotaScope) === "round-robin") {
    const eligible = getEligiblePoolAccounts(config, excludeId, now, quotaScope, selectionOptions);
    return peekRoundRobinAccount(codexPoolKeyForScope(quotaScope), eligible, stickyLimitForConfig(config));
  }
  return pickAlternateCodexAccount(config, excludeId, now, quotaScope, selectionOptions);
}

export function isUnknownUsage(usage: number): boolean {
  return usage >= CODEX_UNKNOWN_USAGE_SCORE;
}

/**
 * Correct a shared cursor that names an account this model's own roster denies (#4768).
 *
 * {@link getEligiblePoolAccounts} is not the only door into selection. An account that is already
 * ACTIVE is served straight from {@link isCodexAccountSelectable} and never passes through the
 * eligible list, so ordering that list alone left the exact case the issue reports: once the Free
 * account becomes the cursor, every Sol/Astra request keeps going to it and keeps taking the
 * upstream unsupported-model 400. {@link pickPriorityPreemption} does not cover it either -- it
 * refuses to move toward a tier that does not strictly outrank the active one, which is the usual
 * shape here.
 *
 * Three properties keep this inside "order the already-eligible set" rather than widening it.
 * It admits nothing: the replacement comes from {@link getEligiblePoolAccounts}, so every
 * eligibility guard has already passed on it. It cannot fail: with no entitled alternative the
 * active account is returned unchanged, so this can never turn a served request into `none`.
 * And it changes nothing without evidence: absent `deniedModelAccountIds`, or an active account
 * nobody denied, it is the identity function.
 *
 * The caller must NOT persist the result. This is one request's correction for one model, in the
 * same spirit as a model detour; the operator's cursor is theirs. A pinned active account is
 * exempt outright, for the reason {@link withoutModelDeniedAccounts} gives.
 */
export function preferModelEntitledAccount(
  config: OcxConfig,
  active: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string {
  const denied = selectionOptions?.deniedModelAccountIds;
  if (denied === undefined || !denied.has(active)) return active;
  if (pinnedCodexAccountId(config) === active) return active;
  // The eligible list restores denied members when filtering would empty it, so re-filter here:
  // moving from one denied account to another buys nothing and costs the warm prefix.
  const entitled = getEligiblePoolAccounts(config, active, now, quotaScope, selectionOptions)
    .filter(id => !denied.has(id));
  return pickLowestUsageAmong(config, entitled, selectionOptions, now) ?? active;
}

/**
 * Move an unbound request back up when a higher tier regains headroom — the
 * weekly-reset case. Returns null when nothing should change.
 *
 * Downward moves are deliberately left to {@link applyQuotaAutoSwitch}: this only
 * fires when the tier filter has already excluded `active`, and only toward a
 * tier that strictly outranks it. Threads bound by affinity never reach here.
 */
export function pickPriorityPreemption(
  config: OcxConfig,
  active: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const eligible = getEligiblePoolAccounts(config, undefined, now, quotaScope, selectionOptions);
  if (eligible.length === 0 || eligible.includes(active)) return null;
  const pinned = pinnedCodexAccountId(config);
  // A live pin already lowered the tier ceiling; never preempt past an explicit
  // operator choice. Same liveness test the tier filter applies, so preview and
  // resolve agree even before the pin is garbage-collected.
  if (
    pinned !== undefined
    && eligible.includes(pinned)
    && hasCodexQuotaHeadroom(config, pinned, selectionOptions, now)
  ) return null;
  const priorityOf = codexAccountPriorityLookup(config);
  if (priorityOf(eligible[0]!) <= priorityOf(active)) return null;
  // Members without headroom are in the tier only because a sibling has some;
  // picking one would hand the request straight back to a drained account.
  return pickLowestUsageAmong(
    config,
    eligible.filter(id => hasCodexQuotaHeadroom(config, id, selectionOptions, now)),
    selectionOptions,
    now,
  );
}

export function applyQuotaAutoSwitch(
  config: OcxConfig,
  active: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  commitSharedSelection = true,
): string {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return active;
  const quota = getAccountQuota(active);
  const activeUsage = computeCodexUsageScore(
    quota,
    getPoolAccountPlanForSelection(config, active, selectionOptions),
    now,
  );
  // Unknown usage is not evidence that a user's explicit selection crossed the
  // threshold. Wait for quota priming instead of rotating among guesses.
  if (isUnknownUsage(activeUsage)) return active;
  if (activeUsage < threshold) return active;
  const best = pickLowerUsageAccount(config, active, activeUsage, now, quotaScope, selectionOptions);
  if (best !== active) {
    if (commitSharedSelection && !isIndependentCodexQuotaScope(quotaScope)) {
      setActiveCodexAccount(config, best);
    }
    return best;
  }

  return active;
}

export function shouldFailover(config: OcxConfig, accountId: string, now: number): boolean {
  const threshold = config.upstreamFailoverThreshold ?? 3;
  if (threshold <= 0) return false;
  dropSpentCredentialFailure(accountId);
  const health = getAccountHealth(accountId);
  if (health?.lastFailureAt && now - health.lastFailureAt > CODEX_FAILURE_WINDOW_MS) return false;
  return !!health && health.consecutiveFailures >= threshold;
}

export function isHealthySharedCodexSelection(
  config: OcxConfig,
  accountId: string,
  now: number,
  quotaScope: CodexQuotaScope | undefined,
  selectionOptions: CodexAccountUsabilityOptions | undefined,
): boolean {
  return isCodexAccountSelectable(config, accountId, now, quotaScope, selectionOptions)
    && hasCodexSharedStateQuotaHeadroom(config, accountId, quotaScope, selectionOptions, now)
    && !hasUnrecoveredCodexQuotaRefusal(accountId, quotaScope)
    && !shouldFailover(config, accountId, now);
}

export function strategySelectionOptionsForModelDetour(
  config: OcxConfig,
  now: number,
  quotaScope: CodexQuotaScope | undefined,
  selectionOptions: CodexAccountUsabilityOptions | undefined,
): CodexAccountUsabilityOptions | undefined {
  if (selectionOptions?.modelEligibleAccountIds === undefined) return selectionOptions;
  const sharedSelectionOptions = sharedStateSelectionOptions(selectionOptions) ?? {};
  return {
    ...selectionOptions,
    modelEligibleAccountIds: new Set(
      [...selectionOptions.modelEligibleAccountIds].filter(accountId =>
        isHealthySharedCodexSelection(
          config,
          accountId,
          now,
          quotaScope,
          sharedSelectionOptions,
        )
      ),
    ),
  };
}

export function applyFailureFailover(
  config: OcxConfig,
  active: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  commitSharedSelection = true,
): string {
  if (!shouldFailover(config, active, now)) return active;
  const best = pickAlternateCodexAccount(config, active, now, quotaScope, selectionOptions);
  if (best) {
    // The scope still routes away from the failing account — that is this request's
    // own decision — but an independent one must not persist a new shared active
    // account. recordCodexUpstreamOutcome only suppresses the promotion it makes at
    // the moment of the failure; the streak outlives the soft avoid, so a later
    // scoped resolve reaches here with the streak still tripped and would otherwise
    // move the shared cursor after all.
    if (commitSharedSelection && !isIndependentCodexQuotaScope(quotaScope)) {
      promoteActiveCodexAccount(config, best);
    }
    return best;
  }
  return active;
}
