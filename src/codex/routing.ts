import { saveConfigPreservingClaudeCode } from "../config";
import { isCodexAccountGenerationLive, registerCodexRefreshGenerationHandoff } from "./account-store";
import { handOffThreadAffinityGeneration } from "./routing/thread-affinity";
import { codexAccountLogLabel } from "./account-label";
import { isCodexAccountPaused } from "./account-pause";
import { clearCodexAccountPin, pinnedCodexAccountId } from "./account-priority";
import { isCodexAccountUsable, type CodexAccountUsabilityOptions } from "./account-usability";
import { markAccountNeedsReauth } from "./account-runtime-state";
import { codexAccountPinDrainReason } from "./routing/pin-drain";
import { POOL_KEY_CODEX, notePoolRotationFailure } from "./pool-rotation";
import { getAccountQuota, isRetiredCodexSparkModel } from "./quota";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { isSelectableCodexPoolAccount } from "./account-id";
import type { OcxConfig } from "../types";
import { captureConfigGeneration, type GenerationContext } from "../lib/state-store-sweeper";
import { recordUpstreamHostFailure } from "./upstream-host-health";
import type { CodexThreadLineage } from "./lineage";

import { isCodexPoolRefreshCooling } from "./pool-refresh-backoff";
import {
  classifyCodexUpstreamOutcome,
  computeCodexUsageScore,
  computeQuotaCooldown,
  quotaAvoidUntilFor,
  CODEX_FAILURE_WINDOW_MS,
  CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS,
  type CodexUpstreamOutcome,
  type CodexUpstreamOutcomeMeta,
} from "./routing/cooldown-math";
import {
  carriesQuotaRefusal,
  codexPoolKeyForScope,
  codexQuotaScopeForModel,
  deleteAccountHealth,
  deleteAllScopedHealth,
  deleteScopedHealth,
  dropSpentCredentialFailure,
  getAccountHealth,
  getCodexAccountCooldownUntil,
  getCodexAccountSoftAvoidUntil,
  getCodexQuotaHealthSnapshot,
  hasUnrecoveredCodexQuotaRefusal,
  isCodexAccountSoftAvoided,
  isCodexQuotaAvoided,
  isHealthAccountAdmissible,
  isHealthGenerationReconciled,
  isIndependentCodexQuotaScope,
  preservedCooldownFields,
  pruneHealthAccountsForContext,
  commitHealthReconcile,
  clearUpstreamHealthState,
  resetHealthReconcileState,
  deleteAllHealthForAccount,
  scopedHealthFor,
  setAccountHealth,
  setScopedHealth,
  type CodexQuotaScope,
  type CodexUpstreamHealth,
} from "./routing/health-store";
import { ownsProbeLease, probeMayClearCooldown, withProbeLeaseReleased } from "./routing/probe-lease";
// `./routing/probe-lease` above is the QUOTA-COOLDOWN lease; the module below owns the
// unrelated TRANSIENT-HOLD trial and the pool-wide recovery bound above it (#4701).
import {
  isTransientHoldExpired,
  resolveTransientHoldDispatch,
  settleTransientProbeForOutcome,
} from "./routing/transient-hold-dispatch";
import {
  adoptLegacyLineageAffinity,
  affinityAfterRelease,
  affinityOnNoAccount,
  bindModelDetourAffinity,
  bindThreadAffinity,
  clearThreadAccountMapForAccount,
  deleteModelDetourAffinity,
  deleteThreadAffinity,
  deleteThreadAffinitiesForAccount,
  getThreadAffinity,
  getThreadAffinityScopes,
  getModelDetourAffinity,
  isThreadAffinityExpired,
  isThreadAffinityGenerationLive,
  peekPendingReleaseReason,
  CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS,
  CODEX_TRANSIENT_AFFINITY_HOLD_MS,
  type CodexAffinityReason,
  type CodexThreadResolution,
  type ThreadAffinityEntry,
} from "./routing/thread-affinity";
import {
  accountPoolStrategyForScope,
  applyFailureFailover,
  applyQuotaAutoSwitch,
  codexAccountBlockReason,
  getEligiblePoolAccounts,
  getPoolAccountPlanForSelection,
  hasCodexQuotaHeadroom,
  hasCodexSharedStateQuotaHeadroom,
  isCodexAccountPlanExcluded,
  isCodexAccountSelectable,
  isHealthySharedCodexSelection,
  isUnknownUsage,
  pickAlternateCodexAccount,
  pickLowerUsageAccount,
  pickLowestUsageAmong,
  pickLowestUsageCodexAccount,
  pickPriorityPreemption,
  pickResetFirstCodexAccount,
  pickUnboundStrategyAccount,
  preferModelEntitledAccount,
  sharedStateSelectionOptions,
  strategySelectionOptionsForModelDetour,
  shouldFailover,
  peekAlternateCodexAccount,
} from "./routing/selection";
import { mayRebindAffinityForQuota } from "./routing/cache-affinity";
import {
  clearAllManualPreferences,
  consumeManualPreference,
  forgetManualPreference,
  forgetRoutingPreferencesOutside,
  forgetRuntimeActiveCodexAccount,
  getEffectiveActiveCodexAccountId,
  manualPreferenceBlocks,
  promoteActiveCodexAccount,
  rememberActiveCodexAccount,
  setActiveCodexAccount,
} from "./routing/active-account";

export {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  CODEX_FAILURE_WINDOW_MS,
  TERMINAL_SHORT_WINDOW_FRESHNESS_MS,
  CODEX_TRANSIENT_SOFT_AVOID_MS,
  classifyCodexUpstreamOutcome,
  computeCodexUsageScore,
  computeQuotaCooldown,
  computeQuotaCooldownUntil,
  parseRetryAfterMs,
  parseResetCooldownMs,
} from "./routing/cooldown-math";
export type {
  CodexUpstreamOutcome,
  CodexUpstreamOutcomeClass,
  CodexCooldownSource,
  CodexUpstreamOutcomeMeta,
} from "./routing/cooldown-math";
export {
  codexQuotaScopeForModel,
  listLiveCodexAccountIds,
  getCodexUpstreamHealth,
  getCodexAccountCooldownUntil,
  getCodexAccountHealthSnapshot,
  getCodexQuotaHealthSnapshot,
  isCodexAccountInCooldown,
  clearCodexAccountCooldown,
  getCodexAccountSoftAvoidUntil,
  isCodexAccountSoftAvoided,
} from "./routing/health-store";
export type { CodexQuotaScope } from "./routing/health-store";
export {
  tryAcquireCodexQuotaProbeLease,
  canAcquireCodexQuotaProbeLease,
  claimDueCodexQuotaRecoveryProbes,
  claimManualResetCooldowns,
  settleManualResetCooldown,
  settleCodexQuotaRecoveryProbe,
  tryAcquireCodexQuotaScopeProbeLease,
  canAcquireCodexQuotaScopeProbeLease,
  releaseCodexQuotaProbeLease,
  releaseCodexQuotaScopeProbeLease,
} from "./routing/probe-lease";
export type {
  CodexQuotaRecoveryProbeClaim,
  CodexQuotaRecoveryProbeProof,
  ManualResetCooldownClaim,
  ManualResetRefreshLineage,
} from "./routing/probe-lease";
export {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  CODEX_THREAD_AFFINITY_MAX_ENTRIES,
  CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS,
  CODEX_TRANSIENT_AFFINITY_HOLD_MS,
  clearConversationStateIssuerMap,
  clearThreadAccountMap,
  clearThreadAccountMapForAccount,
  debugCodexAffinityGenerations,
  handOffThreadAffinityGeneration,
  peekConversationStateIssuer,
  rememberConversationStateIssuer,
} from "./routing/thread-affinity";
export type {
  CodexThreadResolution,
  CodexAffinityMove,
  CodexAffinityReason,
  CodexAffinityDecision,
  TransientProbeGrant,
} from "./routing/thread-affinity";
export {
  isCodexAccountPlanExcluded,
  getPoolAccountPlan,
  pickLowestUsageCodexAccount,
  pickAlternateCodexAccount,
} from "./routing/selection";
export {
  resetCodexRoutingForManualSelection,
  getEffectiveActiveCodexAccountId,
  isEffectiveCodexAccountPinned,
} from "./routing/active-account";
export { codexAccountPinDrainReason } from "./routing/pin-drain";
export type { CodexPinDrainReason } from "./routing/pin-drain";

// A shared refresh can outlive the request that opened it. Register the affinity
// handoff with the flight so a detached G -> G+1 commit cannot strand bindings at G.
registerCodexRefreshGenerationHandoff(handOffThreadAffinityGeneration);

function hasConfiguredPoolAccount(
  config: OcxConfig,
  accountId: string,
  selectionOptions?: CodexAccountUsabilityOptions,
): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    return isCodexAccountUsable(config, accountId, selectionOptions);
  }
  return (config.codexAccounts ?? [])
    .some(account => isSelectableCodexPoolAccount(account) && account.id === accountId);
}

export function clearCodexUpstreamHealth(): void {
  // Operator preferences are routing state, not health, but they live and die with the same
  // reset points. Leaving them behind lets a selection from one context suppress the
  // automatic cursor in the next one.
  clearAllManualPreferences();
  clearUpstreamHealthState();
  forgetRuntimeActiveCodexAccount();
  // The reconcile watermark is part of this state, not something that outlives it. Keeping
  // it across a full reset is incoherent: there is no health left to protect, yet
  // recordCodexUpstreamOutcome would still drop a writer whose generation predates the
  // watermark for any account missing from the equally stale live set. Left behind, it also
  // leaks between test files, which is how it was found.
  resetHealthReconcileState();
}

export function clearCodexUpstreamHealthForAccount(accountId: string): void {
  deleteAllHealthForAccount(accountId);
  // Deletion is the third operator exit, next to pause and exclusion, and it is the one
  // with no reconcile path behind it: once the account is gone nothing can succeed on it,
  // so an unspent preference naming it would suppress the automatic cursor for every other
  // account until the process restarts.
  forgetManualPreference(accountId);
}

export function reconcileCodexRoutingHealth(context: GenerationContext): number {
  if (isHealthGenerationReconciled(context.generation)) return 0;
  const removed = pruneHealthAccountsForContext(context.codexAccountIds);
  // Sweep preferences the same way, for the account set this generation actually has. The
  // delete path above is the direct route; this is the one that catches an account removed
  // by an edit the runtime never saw. Deliberately not counted in `removed`, which reports
  // health rows.
  forgetRoutingPreferencesOutside(context.codexAccountIds);
  commitHealthReconcile(context.generation, context.codexAccountIds);
  return removed;
}
/**
 * Is a transient failure streak the ONLY thing standing between this thread and its account?
 *
 * The point is the word "only". A binding must still be released for every cause that means
 * the account cannot serve this conversation at all -- a quota refusal it already answered,
 * an operator pause, a plan exclusion, an unusable or superseded credential, a hard cooldown,
 * an avoided quota window. What is left after those is a 5xx streak and the escalating
 * soft-avoid window it writes, and that is a statement about right now, not about ownership.
 *
 * #4269 is the cautionary case: a retryable 503 whose human-readable body happened to contain
 * the word "reauthentication" was classified as an auth failure. A failure's blast radius has
 * to come from the scope it was recorded at, which is what this predicate reads.
 *
 * Deliberately NOT gated on `pool.cacheAffinity`. That flag chooses between cache-first and
 * capacity-first QUOTA routing; it says nothing about how a failure should be attributed, and
 * an operator who prefers capacity-first has not asked for three 503s to cost them a prefix.
 */
function isTransientOnlyAffinityBlock(
  config: OcxConfig,
  entry: ThreadAffinityEntry,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): boolean {
  if (!isThreadAffinityGenerationLive(entry)) return false;
  if (hasUnrecoveredCodexQuotaRefusal(entry.accountId, quotaScope)) return false;
  if (isCodexAccountPaused(config, entry.accountId)) return false;
  if (isCodexAccountPlanExcluded(config, entry.accountId)) return false;
  if (!isCodexAccountUsable(config, entry.accountId, selectionOptions)) return false;
  if (getCodexQuotaHealthSnapshot(entry.accountId, quotaScope, now) !== null) return false;
  if (isCodexQuotaAvoided(entry.accountId, quotaScope, now)) return false;
  return shouldFailover(config, entry.accountId, now)
    || isCodexAccountSoftAvoided(entry.accountId, now)
    || isCodexPoolRefreshCooling(entry.accountId, now);
}

/**
 * Is every pin this thread holds on the failing account past its hold window?
 *
 * A thread that has never detoured has no hold to spend, so it answers false: the resolve path
 * has not yet had the chance to route around the failure, and deleting the pin here would take
 * that chance away.
 */
function isTransientHoldSpentForAccount(threadId: string, accountId: string, now: number): boolean {
  const affinities = getThreadAffinityScopes(threadId);
  if (!affinities) return false;
  let matched = false;
  for (const entry of affinities.values()) {
    if (entry.accountId !== accountId) continue;
    matched = true;
    if (!isTransientHoldExpired(entry, now)) return false;
  }
  return matched;
}

/**
 * Who serves this thread while its own account is held. Prefers the account already doing so,
 * because a detour that moves every turn is just the original defect wearing a different name.
 */
function transientDetourAccount(
  config: OcxConfig,
  entry: ThreadAffinityEntry,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  mode: "commit" | "peek" = "commit",
): string | null {
  const held = entry.transientDetourAccountId;
  if (
    held !== undefined
    && held !== entry.accountId
    && isCodexAccountSelectable(config, held, now, quotaScope, selectionOptions)
    && !hasUnrecoveredCodexQuotaRefusal(held, quotaScope)
    && !shouldFailover(config, held, now)
    && !isCodexAccountSoftAvoided(held, now)
  ) {
    return held;
  }
  // Preview must name the same account resolve would, including before any detour has been
  // recorded -- but without advancing the round-robin ring, which is the one side effect in
  // the selection path.
  return mode === "peek"
    ? peekAlternateCodexAccount(config, entry.accountId, now, quotaScope, selectionOptions)
    : pickAlternateCodexAccount(config, entry.accountId, now, quotaScope, selectionOptions);
}

/**
 * Which account is ACTUALLY answering for one conversation key right now (#4546, wp8).
 *
 * First placement reads this, not the binding alone: a parent parked on a transient detour
 * is being served by the detour, so a new child placed "where the parent lives" would miss
 * the warm account by one hop. A dead binding, an expired hold, and an ineligible serving
 * account all answer null -- the caller then tries a sibling, then falls back to cold
 * placement, which is the correct order because a stale home is worse than no hint.
 *
 * "Right now" includes the MODEL lane. A parent whose home account is not entitled to this
 * model is being served through a model-scoped detour, which is the same "serving, not stale
 * home" case one level further in: reading only the ordinary binding would hand the child an
 * account this request cannot use, and it would then start cold on the very model whose
 * warm account the family already found. The detour scope embeds the model and the quota
 * scope, so the entry consulted here is compatible by construction.
 */
function lineageServingAccountId(
  conversationKey: string,
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  modelId?: string,
): string | null {
  const entry = (modelId !== undefined
    ? getModelDetourAffinity(conversationKey, modelId, quotaScope)
    : undefined)
    ?? getThreadAffinity(conversationKey, quotaScope);
  if (!entry || isThreadAffinityExpired(entry, now) || !isThreadAffinityGenerationLive(entry)) {
    return null;
  }
  const holdLive = entry.transientHoldSince !== undefined && !isTransientHoldExpired(entry, now);
  const serving = holdLive && entry.transientDetourAccountId !== undefined
    ? entry.transientDetourAccountId
    : entry.accountId;
  return isCodexAccountSelectable(config, serving, now, quotaScope, selectionOptions)
      && !hasUnrecoveredCodexQuotaRefusal(serving, quotaScope)
      && !shouldFailover(config, serving, now)
      && !isCodexAccountSoftAvoided(serving, now)
    ? serving
    : null;
}

/**
 * First placement only: where a child with NO binding of its own should start. Parent's
 * current serving account first, then a compatible sibling's -- "compatible" meaning the
 * same quota-scope slot, since a Reserve sibling says nothing about the shared lane. The
 * child still binds under its own key; this is a hint for turn one, not a root-wide pin.
 */
function pickLineageServingAccount(
  config: OcxConfig,
  lineage: CodexThreadLineage,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  modelId?: string,
): { accountId: string; reason: CodexAffinityReason } | null {
  // Cohort keying (#4780) makes a tree share one key, so for a same-session family the parent's
  // key IS this request's and the lookup below would re-ask a question the caller already
  // answered by finding no binding entry. What remains is the case cohort keying cannot unify:
  // a session-less chain whose parent this scope has not recorded, where the keys differ.
  if (
    lineage.parentConversationKey !== undefined
    && lineage.parentConversationKey !== lineage.conversationKey
  ) {
    const parent = lineageServingAccountId(
      lineage.parentConversationKey, config, now, quotaScope, selectionOptions, modelId,
    );
    if (parent) return { accountId: parent, reason: "lineage_parent" };
    for (const siblingKey of lineage.siblingConversationKeys) {
      const sibling = lineageServingAccountId(
        siblingKey, config, now, quotaScope, selectionOptions, modelId,
      );
      if (sibling) return { accountId: sibling, reason: "lineage_sibling" };
    }
  }
  return null;
}

/**
 * Reconcile the effective active account after an administrative exclusion such as pause.
 * The operator's persisted selection is cleared when it names the excluded account; quota
 * keeps its historical persisted promotion, while rotating strategies retain the replacement
 * only in the process-local cursor.
 */
export function reconcileCodexActiveAfterExclusion(
  config: OcxConfig,
  excludedAccountId: string,
  now = Date.now(),
): string | null {
  const wasEffective = (getEffectiveActiveCodexAccountId(config) ?? MAIN_CODEX_ACCOUNT_ID) === excludedAccountId;
  // Exclusion does not route through resetCodexRoutingForManualSelection, so the one-shot is
  // revoked here too. A preference naming an account that can no longer serve would keep
  // suppressing the automatic cursor with no way to clear it.
  forgetManualPreference(excludedAccountId);
  if (config.activeCodexAccountId === excludedAccountId) {
    config.activeCodexAccountId = undefined;
  }
  // Excluding an account revokes any manual pin on it even when it was not the
  // effective active — otherwise a paused account keeps acting as a tier ceiling,
  // suppressing every higher-ordered account while being unusable itself.
  clearCodexAccountPin(config, excludedAccountId);
  if (!wasEffective) return getEffectiveActiveCodexAccountId(config) ?? null;

  forgetRuntimeActiveCodexAccount();
  const fallback = pickAlternateCodexAccount(config, excludedAccountId, now);
  if (fallback) promoteActiveCodexAccount(config, fallback);
  return fallback;
}

/**
 * Release a pin whose account is durably drained. "Use this account now" ends
 * when the account crosses the auto-switch threshold or stops being selectable
 * at all — never on a transient cooldown or soft-avoid, which it recovers from
 * on its own. Clearing the pin also removes the condition, so this writes at
 * most once per pin.
 */
function releaseDrainedCodexAccountPin(
  config: OcxConfig,
  selectionOptions?: Pick<
    CodexAccountUsabilityOptions,
    "nativeMainSelectionOnly" | "isMainAccountTokenLive"
  >,
  now: number = Date.now(),
): void {
  const pinned = pinnedCodexAccountId(config);
  if (pinned === undefined) return;
  if (codexAccountPinDrainReason(config, pinned, selectionOptions, now) === undefined) return;
  clearCodexAccountPin(config);
  saveConfigPreservingClaudeCode(config);
}

export function resolveCodexAccountForThread(
  threadId: string | null,
  config: OcxConfig,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  lineage?: CodexThreadLineage,
): string | null {
  const resolution = resolveCodexAccountForThreadDetailed(threadId, config, now, quotaScope, undefined, undefined, lineage);
  // A WITHHELD dispatch is deliberately not an account here: this wrapper cannot carry a retry
  // time, and answering with the held account is the send the hold prevents. Fails closed.
  return resolution.status === "selected" ? resolution.accountId : null;
}

function previewReusableAffinityAccount(
  entry: ThreadAffinityEntry | undefined,
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  if (
    !entry
    || isThreadAffinityExpired(entry, now)
  ) {
    return null;
  }
  if (
    !isThreadAffinityGenerationLive(entry)
    || !isCodexAccountSelectable(config, entry.accountId, now, quotaScope, selectionOptions)
    || hasUnrecoveredCodexQuotaRefusal(entry.accountId, quotaScope)
    || shouldFailover(config, entry.accountId, now)
  ) {
    // Preview must reach the same answer as resolve, including the transient detour, or the
    // subagent fallback decides against a binding the next real request would have held.
    // Read-only by contract: no hold is started and no detour is recorded here.
    if (
      !isTransientHoldExpired(entry, now)
      && isTransientOnlyAffinityBlock(config, entry, now, quotaScope, selectionOptions)
    ) {
      const detour = transientDetourAccount(config, entry, now, quotaScope, selectionOptions, "peek");
      if (detour !== null && detour !== entry.accountId) return detour;
      // Nowhere to detour still means the thread keeps its account, so preview says so too.
      return entry.accountId;
    }
    return null;
  }
  if (accountPoolStrategyForScope(config, quotaScope) === "reset-first") {
    return resetFirstAffinityReplacement(entry, config, now, quotaScope, selectionOptions) ?? entry.accountId;
  }
  // Quota strategy only: non-quota strategies keep affinity for ongoing threads
  // (new-session-only rotation — docs / affinity policy A).
  if (accountPoolStrategyForScope(config, quotaScope) === "quota") {
    const threshold = config.autoSwitchThreshold ?? 80;
    if (threshold > 0) {
      const usage = computeCodexUsageScore(
        getAccountQuota(entry.accountId),
        getPoolAccountPlanForSelection(config, entry.accountId, selectionOptions),
      now,
      );
      // Preview must agree with resolve: this is the second copy of the same rule, and the
      // suite asserts the two answer identically.
      if (mayRebindAffinityForQuota(config, entry.accountId, usage, threshold, selectionOptions)) {
        const best = pickCacheSafeQuotaReplacement(
          config,
          entry.accountId,
          usage,
          now,
          quotaScope,
          selectionOptions,
        );
        if (best) return best;
      }
    }
  }
  return entry.accountId;
}

/** Reset ordering may move a binding only under the existing cache-affinity release policy. */
function resetFirstAffinityReplacement(
  entry: ThreadAffinityEntry,
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return null;
  const usage = computeCodexUsageScore(getAccountQuota(entry.accountId), getPoolAccountPlanForSelection(config, entry.accountId, selectionOptions), now);
  if (!mayRebindAffinityForQuota(config, entry.accountId, usage, threshold, selectionOptions)) return null;
  const candidates = getEligiblePoolAccounts(config, entry.accountId, now, quotaScope, selectionOptions, true)
    // Headroom alone answers true for an UNMEASURED account, which is the right default for an
    // unbound request and the wrong bet for a bound one. The quota strategy already excludes
    // those through the strictly-cooler compare; reset ordering has no such compare, so it has
    // to say it. Moving a warm conversation onto an account nobody has a reading for is a
    // guess, not an improvement.
    .filter(id => {
      if (!hasCodexQuotaHeadroom(config, id, selectionOptions, now)) return false;
      return !isUnknownUsage(computeCodexUsageScore(
        getAccountQuota(id),
        getPoolAccountPlanForSelection(config, id, selectionOptions),
        now,
      ));
    });
  return pickResetFirstCodexAccount(config, candidates, now, selectionOptions);
}

/**
 * Quota-strategy replacement for a LIVE binding (#4546).
 *
 * "Strictly cooler by any margin" — what {@link pickLowerUsageAccount} answers — is the
 * right rule for an unbound request and the wrong one for a bound thread. Once every
 * account sits in the threshold band the coolest is still over it, so a long-running
 * conversation was handed from account to account on consecutive turns. Codex prompt
 * caches are account-isolated, so each hop restarted from a cold prefix; the reporter
 * measured 7k-token turns becoming 150k-token turns.
 *
 * The destination must clear the same bar {@link resetFirstAffinityReplacement} already
 * applies — genuine headroom via {@link hasCodexQuotaHeadroom} — AND be strictly cooler
 * than the bound account. Headroom alone is not sufficient: that predicate deliberately
 * answers true for unknown usage, which is the right default for an unbound pick but a
 * guess when a warm prefix is at stake. `CODEX_UNKNOWN_USAGE_SCORE` is 101, so an
 * unobserved account can never be strictly cooler than a known over-threshold score and
 * the second bar excludes it without a special case.
 *
 * This narrows a preference, never a refusal: callers release the binding on a 429/402,
 * failover, or exhaustion before this helper is consulted, so a thread cannot be wedged
 * on an account that cannot serve.
 */
function pickCacheSafeQuotaReplacement(
  config: OcxConfig,
  boundAccountId: string,
  boundUsage: number,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const candidates = getEligiblePoolAccounts(
    config,
    boundAccountId,
    now,
    quotaScope,
    selectionOptions,
    true,
  ).filter(id => hasCodexQuotaHeadroom(config, id, selectionOptions, now));
  const best = pickLowestUsageAmong(config, candidates, selectionOptions, now);
  if (best === null || best === boundAccountId) return null;
  const bestUsage = computeCodexUsageScore(
    getAccountQuota(best),
    getPoolAccountPlanForSelection(config, best, selectionOptions),
    now,
  );
  return bestUsage < boundUsage ? best : null;
}

/**
 * Re-evaluate an affined account under the quota strategy. Returns a replacement
 * that has genuine quota headroom and is strictly cooler than the bound account,
 * or null when the current binding should remain (#4546).
 */
function reevaluateAffinityQuota(
  entry: ThreadAffinityEntry,
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const strategy = accountPoolStrategyForScope(config, quotaScope);
  if (strategy === "reset-first") {
    const replacement = resetFirstAffinityReplacement(entry, config, now, quotaScope, selectionOptions);
    if (replacement || now - entry.lastReevalAt >= CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS) entry.lastReevalAt = now;
    return replacement;
  }
  if (strategy !== "quota") return null;
  const threshold = config.autoSwitchThreshold ?? 80;
  const usage = threshold > 0
    ? computeCodexUsageScore(
        getAccountQuota(entry.accountId),
        getPoolAccountPlanForSelection(config, entry.accountId, selectionOptions),
      now,
      )
    : 0;
  // One bar, used for BOTH the rebind decision and the re-score interval. Keying the short
  // circuit off the old threshold while the rebind bar moved would re-score a bound thread on
  // every request through the whole 80-99% band instead of once a minute.
  const mayRebind = mayRebindAffinityForQuota(config, entry.accountId, usage, threshold, selectionOptions);
  if (
    !mayRebind
    && now - entry.lastReevalAt < CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS
  ) {
    return null;
  }
  entry.lastReevalAt = now;
  if (!mayRebind) return null;
  return pickCacheSafeQuotaReplacement(
    config,
    entry.accountId,
    usage,
    now,
    quotaScope,
    selectionOptions,
  );
}

/**
 * Side-effect-free preview of the Codex pool account native routing would prefer.
 * Used for subagent fallback quota decisions before final auth.
 *
 * Does not mutate activeCodexAccountId, thread affinity, config on disk, or probe leases.
 * Mirrors {@link resolveCodexAccountForThreadDetailed} account choice, including returning a
 * configured cooled account so callers can evaluate probe/quota availability.
 */
export function previewCodexAccountForRequest(
  threadId: string | null,
  config: OcxConfig,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  modelId?: string,
  lineage?: CodexThreadLineage,
): string | null {
  // A request-scoped model detour keeps its own serving-account affinity. Preview
  // reads it before the ordinary lane, but never repairs or deletes it. Roster
  // expansion therefore preserves the already-serving account, and preview mirrors
  // final resolution even when the ordinary lane was independently retired.
  if (threadId && selectionOptions?.modelEligibleAccountIds !== undefined) {
    const detourPreview = previewReusableAffinityAccount(
      getModelDetourAffinity(threadId, modelId, quotaScope),
      config,
      now,
      quotaScope,
      selectionOptions,
    );
    if (detourPreview) return detourPreview;
  }
  const entry = threadId ? getThreadAffinity(threadId, quotaScope) : undefined;
  const ordinaryPreview = previewReusableAffinityAccount(
    entry,
    config,
    now,
    quotaScope,
    selectionOptions,
  );
  if (ordinaryPreview) return ordinaryPreview;

  // A conversation carried across an in-process swap is still bound under the pre-#4546 raw
  // parent key, and resolve adopts that binding rather than rebinding cold. Preview has to name
  // the same account. Read-only, as everything here is: it neither adopts nor retires the entry.
  if (threadId && !entry && lineage?.legacyConversationKey !== undefined) {
    const legacyPreview = previewReusableAffinityAccount(
      getThreadAffinity(lineage.legacyConversationKey, quotaScope),
      config,
      now,
      quotaScope,
      selectionOptions,
    );
    if (legacyPreview) return legacyPreview;
  }

  // First placement mirrors resolve: a child with no binding previews the account actually
  // serving its parent (or a compatible sibling), so the subagent fallback does not decide
  // against a cold pick the real request would never make. Read-only: nothing binds here.
  if (threadId && !entry && lineage) {
    const lineagePreview = pickLineageServingAccount(
      config, lineage, now, quotaScope, selectionOptions, modelId,
    );
    if (lineagePreview) return lineagePreview.accountId;
  }

  const strategyPick = pickUnboundStrategyAccount(
    config,
    threadId,
    now,
    false,
    quotaScope,
    strategySelectionOptionsForModelDetour(config, now, quotaScope, selectionOptions),
  );
  if (strategyPick) return strategyPick;

  let active = getEffectiveActiveCodexAccountId(config) ?? null;
  if (!active) {
    return pickLowestUsageCodexAccount(config, undefined, now, quotaScope, selectionOptions);
  }
  if (!isCodexAccountSelectable(config, active, now, quotaScope, selectionOptions)) {
    const fallback = pickLowestUsageCodexAccount(config, active, now, quotaScope, selectionOptions);
    if (fallback) active = fallback;
    else if (
      hasConfiguredPoolAccount(config, active, selectionOptions)
      && !isCodexAccountPaused(config, active)
      && !isCodexAccountPlanExcluded(config, active)
    ) return active;
    else return null;
  }
  active = pickPriorityPreemption(config, active, now, quotaScope, selectionOptions) ?? active;

  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold > 0) {
    const usage = computeCodexUsageScore(
      getAccountQuota(active),
      getPoolAccountPlanForSelection(config, active, selectionOptions),
      now,
    );
    if (!isUnknownUsage(usage) && usage >= threshold) {
      active = pickLowerUsageAccount(config, active, usage, now, quotaScope, selectionOptions);
    }
  }
  if (shouldFailover(config, active, now)) {
    const best = pickLowestUsageCodexAccount(config, active, now, quotaScope, selectionOptions);
    if (best) active = best;
  }
  // Same correction resolve applies, for the same reason: preview must name the account the
  // request will actually use, or subagent fallback scores a model against the wrong one.
  active = preferModelEntitledAccount(config, active, now, quotaScope, selectionOptions);
  if (!isCodexAccountUsable(config, active, selectionOptions)) {
    return hasConfiguredPoolAccount(config, active, selectionOptions) ? active : null;
  }
  if (isCodexAccountPaused(config, active)) return null;
  if (getCodexQuotaHealthSnapshot(active, quotaScope, now)) {
    return hasConfiguredPoolAccount(config, active, selectionOptions) ? active : null;
  }
  return active;
}

export function resolveCodexAccountForThreadDetailed(
  threadId: string | null,
  config: OcxConfig,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  modelId?: string,
  lineage?: CodexThreadLineage,
): CodexThreadResolution {
  // An entitlement roster constrains only this model request. It must not rewrite
  // the operator's shared active/pin choice or the task's ordinary-model affinity.
  const modelScopedSelection = selectionOptions?.modelEligibleAccountIds !== undefined;
  let preserveExistingModelScopedAffinity = false;
  const sharedSelectionOptions: CodexAccountUsabilityOptions | undefined = modelScopedSelection
    ? sharedStateSelectionOptions(selectionOptions) ?? {}
    : selectionOptions;
  // Retiring a spent manual pin is independent of affinity: an existing thread
  // keeps its account below, but the operator's tier ceiling must not silently
  // revive after quota resets. Independent model scopes must never persist a
  // change to shared routing state.
  if (!isIndependentCodexQuotaScope(quotaScope)) {
    releaseDrainedCodexAccountPin(config, sharedStateSelectionOptions(selectionOptions), now);
  }
  const sharedActiveBeforeSelection = getEffectiveActiveCodexAccountId(config);
  const preserveSharedSelectionForModelDetour = modelScopedSelection && (
    sharedActiveBeforeSelection === undefined
    || isHealthySharedCodexSelection(
      config,
      sharedActiveBeforeSelection,
      now,
      quotaScope,
      sharedSelectionOptions,
    )
  );

  // A conversation that was live across an in-process code swap is still bound under the
  // pre-#4546 raw parent key. Adopt that binding onto this thread's key BEFORE anything below
  // reads an entry, so the conversation arrives here as an ordinary bound thread instead of a
  // cold one: every branch that follows -- detour reuse, transient hold, quota re-eval --
  // should treat it as the continuing conversation it is. No-op on a fresh process.
  if (threadId) adoptLegacyLineageAffinity(threadId, lineage, now, quotaScope, modelId);

  if (threadId && modelScopedSelection) {
    const detourEntry = getModelDetourAffinity(threadId, modelId, quotaScope);
    if (detourEntry) {
      const detourReusable = !isThreadAffinityExpired(detourEntry, now)
        && isThreadAffinityGenerationLive(detourEntry)
        && isCodexAccountSelectable(config, detourEntry.accountId, now, quotaScope, selectionOptions)
        && !hasUnrecoveredCodexQuotaRefusal(detourEntry.accountId, quotaScope)
        && !shouldFailover(config, detourEntry.accountId, now);
      if (detourReusable) {
        detourEntry.lastUsedAt = now;
        // Same as the ordinary lane: serving again ends the hold. Without this the marker
        // survives recovery, and a later streak reads a hold that started before the account
        // ever came back -- which is the pin drop this whole branch exists to prevent.
        if (detourEntry.transientHoldSince !== undefined) delete detourEntry.transientHoldSince;
        if (detourEntry.transientDetourAccountId !== undefined) delete detourEntry.transientDetourAccountId;
        // Model detours follow the same affinity policy as ordinary bindings:
        // RR/fill-first stay sticky, while quota strategy may re-evaluate an
        // over-threshold account without changing the ordinary lane.
        const cooler = reevaluateAffinityQuota(
          detourEntry,
          config,
          now,
          quotaScope,
          selectionOptions,
        );
        if (cooler) {
          bindModelDetourAffinity(threadId, cooler, now, modelId, quotaScope);
          return { status: "selected", accountId: cooler, affinity: { move: "rebound", reason: "model_lane" } };
        }
        return { status: "selected", accountId: detourEntry.accountId, affinity: { move: "reused", reason: "model_lane" } };
      }
      // The model lane gets the same transient hold as the ordinary one. Without it a
      // model-scoped request drops its detour pin on three 503s and falls back to an ordinary
      // home account that may not even be entitled to this model.
      if (
        !isTransientHoldExpired(detourEntry, now)
        && isTransientOnlyAffinityBlock(config, detourEntry, now, quotaScope, selectionOptions)
      ) {
        const lane = transientDetourAccount(config, detourEntry, now, quotaScope, selectionOptions);
        detourEntry.transientHoldSince ??= now;
        detourEntry.lastUsedAt = now;
        // A provider-wide outage soft-avoids every sibling, so there is nowhere to detour.
        // That is a statement about where this request can go, not about who owns the
        // conversation: dropping the pin here would rebuild the cold prefix elsewhere for
        // exactly the failure the hold exists to survive -- nor a licence to send at the
        // failing account, which is what the dispatch resolver bounds (#4701).
        return resolveTransientHoldDispatch(detourEntry, lane, now);
      }
      // Detour expiry or invalidation must not expire the ordinary task. Drop only
      // this model lane and select from ordinary/shared state below.
      deleteModelDetourAffinity(threadId, modelId, quotaScope);
    }
  }

  // Why the binding went away, when it did. Carried to the selection below so the request that
  // pays for a cold prefix can say what it paid for.
  let releaseReason: CodexAffinityReason | undefined;
  const entry = threadId ? getThreadAffinity(threadId, quotaScope) : undefined;
  if (threadId && entry) {
    if (isThreadAffinityExpired(entry, now)) {
      deleteThreadAffinity(threadId, quotaScope);
      return { status: "expired", accountId: entry.accountId, affinity: { move: "cleared", reason: "expired" } };
    }
    const generationLive = isThreadAffinityGenerationLive(entry);
    const selectableForSharedState = generationLive
      && isCodexAccountSelectable(config, entry.accountId, now, quotaScope, sharedSelectionOptions);
    const selectableForRequest = selectableForSharedState
      && isCodexAccountSelectable(config, entry.accountId, now, quotaScope, selectionOptions);
    const failoverReady = shouldFailover(config, entry.accountId, now);
    // A quota refusal outranks every affinity preference, including `pool.cacheAffinity`:
    // the account has already told this thread it cannot serve it.
    const quotaRefused = hasUnrecoveredCodexQuotaRefusal(entry.accountId, quotaScope);
    const healthyForSharedAffinity = selectableForSharedState
      && hasCodexSharedStateQuotaHeadroom(config, entry.accountId, quotaScope, sharedSelectionOptions, now)
      && !quotaRefused
      && !failoverReady;
    if (
      selectableForRequest
      && !quotaRefused
      // Affined threads must leave a failing account once the streak trips failover
      // (soft-avoid covers the first-hit case; this catches post-avoid residual streaks).
      && !failoverReady
    ) {
      entry.lastUsedAt = now;
      // Serving again ends any transient hold: the thread is home, so the detour it was
      // parked on is no longer the answer to anything.
      if (entry.transientHoldSince !== undefined) delete entry.transientHoldSince;
      if (entry.transientDetourAccountId !== undefined) delete entry.transientDetourAccountId;
      // Periodic quota re-eval: a long-lived bound thread must still switch when
      // it crosses autoSwitchThreshold, but only onto an account that has genuine
      // quota headroom AND is strictly cooler — moving to a destination still over
      // the threshold just trades the warmed prompt-cache prefix for an equally hot
      // account, which is the #4546 ping-pong.
      // Without this the reuse branch returns before applyQuotaAutoSwitch and the
      // thread stays pinned for the full idle TTL (the WSL "never switches" report).
      // Over-threshold pins re-eval immediately so a depleted primary does not keep
      // serving for up to 60s after a secondary with quota is available (#584).
      // Non-quota strategies (RR / fill-first) keep affinity for ongoing threads —
      // rotation is new-session-only (affinity policy A).
      const cooler = reevaluateAffinityQuota(entry, config, now, quotaScope, selectionOptions);
      if (cooler) {
        if (!isIndependentCodexQuotaScope(quotaScope)) {
          promoteActiveCodexAccount(config, cooler);
        }
        bindThreadAffinity(threadId, cooler, now, quotaScope); // rebinds + resets clocks
        return { status: "selected", accountId: cooler, affinity: { move: "rebound", reason: "quota_headroom" } };
      }
      return { status: "selected", accountId: entry.accountId, affinity: { move: "reused", reason: "healthy" } };
    }
    // Transient trouble on the bound account is a reason to send elsewhere, not a reason to
    // give up the conversation. Detour this request and KEEP the binding, so recovery is free
    // instead of costing another cold prefix (#4546). Bounded: once the hold outlives what a
    // transient failure can explain, fall through and release it like any other dead account.
    if (
      !isTransientHoldExpired(entry, now)
      && isTransientOnlyAffinityBlock(config, entry, now, quotaScope, selectionOptions)
    ) {
      const detour = transientDetourAccount(config, entry, now, quotaScope, selectionOptions);
      entry.transientHoldSince ??= now;
      entry.lastUsedAt = now;
      // No sibling can take it either -- the usual shape of a provider-wide 503. The binding
      // survives: "cannot send right now" and "forget which account owns this conversation"
      // are different answers. So is the third answer this used to give -- "send at the
      // failing account" -- now a bounded probe or a typed refusal (#4701).
      return resolveTransientHoldDispatch(entry, detour, now);
    }
    // A model-only exclusion does not invalidate the shared task binding. Health,
    // generation, pause, cooldown, and failure evidence still retire it normally.
    if (!modelScopedSelection || !healthyForSharedAffinity) {
      // A hold that outlived its window is not the same as a conversation with nowhere to go.
      // If the account that has actually been serving this thread is still healthy, promote it
      // instead of deleting the entry and re-picking cold: releasing here threw away the one
      // piece of evidence the request had -- that B works -- and handed the thread back to a
      // fresh strategy choice, which is the cold-prefix cost #4546 is about. A timer expiring
      // restores the right to re-decide; it is not itself a recovery.
      const expiredDetour = entry.transientDetourAccountId;
      if (
        isTransientHoldExpired(entry, now)
        && generationLive
        && !quotaRefused
        && expiredDetour !== undefined
        && expiredDetour !== entry.accountId
        && isCodexAccountSelectable(config, expiredDetour, now, quotaScope, selectionOptions)
        && !hasUnrecoveredCodexQuotaRefusal(expiredDetour, quotaScope)
        && !shouldFailover(config, expiredDetour, now)
        && !isCodexAccountSoftAvoided(expiredDetour, now)
      ) {
        if (!isIndependentCodexQuotaScope(quotaScope)) promoteActiveCodexAccount(config, expiredDetour);
        bindThreadAffinity(threadId, expiredDetour, now, quotaScope);
        return {
          status: "selected",
          accountId: expiredDetour,
          affinity: { move: "rebound", reason: "transient_hold_expired" },
        };
      }
      releaseReason = !generationLive
        ? "generation"
        : quotaRefused
          ? "quota_refusal"
          : isTransientHoldExpired(entry, now)
            ? "transient_hold_expired"
            : codexAccountBlockReason(config, entry.accountId, now, quotaScope, selectionOptions)
              ?? "quota_headroom";
      deleteThreadAffinity(threadId, quotaScope);
    } else {
      preserveExistingModelScopedAffinity = true;
    }
  }
  // A release recorded by the outcome path (a 429 clears the pin before the next request even
  // arrives) is the reason this request is starting cold, so it outranks having found nothing.
  releaseReason ??= peekPendingReleaseReason(threadId);

  // FIRST PLACEMENT for a child thread (#4546, wp8). A child with no binding of its own used
  // to bind under the raw parent id -- an entry unrelated to the root's real binding -- or
  // land cold while its parent was being served warm somewhere. Consult the family's CURRENT
  // serving account first (detour included), then a compatible sibling's, and only then fall
  // through to cold placement. The child binds under its OWN key below: this is a warm start,
  // not a root-wide pin, so a later move of the parent never drags the child with it.
  //
  // Guarded on `entry === undefined`, which is strictly narrower than "has no usable binding":
  // a thread whose binding was just released above still holds its own history and re-decides
  // through the ordinary path. Only a thread that has never bound takes a family hint. That
  // also makes `preserveExistingModelScopedAffinity` unreachable here -- it is only ever set
  // while reusing an existing model-detour entry -- so this binds through the ordinary lane.
  if (threadId && entry === undefined && lineage) {
    const lineagePick = pickLineageServingAccount(
      config, lineage, now, quotaScope, selectionOptions, modelId,
    );
    if (lineagePick) {
      bindThreadAffinity(threadId, lineagePick.accountId, now, quotaScope);
      // Deliberately no promoteActiveCodexAccount: a family hint places THIS request, it does
      // not move the operator-visible shared cursor for unrelated new threads.
      return {
        status: "selected",
        accountId: lineagePick.accountId,
        // A pending release still outranks the hint as the reported reason, and consuming it
        // here is what stops the next request reporting the same release a second time.
        affinity: releaseReason === undefined
          ? { move: "new_bind", reason: lineagePick.reason }
          : affinityAfterRelease(threadId, releaseReason),
      };
    }
  }

  // A request-scoped roster may still contain unhealthy candidates. Non-quota strategies return
  // before the quota/failover helpers below, so prefer only shared-healthy roster members here;
  // otherwise RR/fill-first can immediately re-pick a known failing account even when another
  // entitled account is healthy. If no healthy member exists, the normal fallback path below
  // still decides whether the sole eligible candidate must be used.
  const strategySelectionOptions = strategySelectionOptionsForModelDetour(
    config,
    now,
    quotaScope,
    selectionOptions,
  );
  const strategyPick = pickUnboundStrategyAccount(
    config,
    threadId,
    now,
    true,
    quotaScope,
    strategySelectionOptions,
    !modelScopedSelection,
    !preserveExistingModelScopedAffinity,
  );
  if (strategyPick) {
    if (threadId && preserveExistingModelScopedAffinity) {
      bindModelDetourAffinity(threadId, strategyPick, now, modelId, quotaScope);
    }
    if (
      modelScopedSelection
      && !preserveSharedSelectionForModelDetour
      && !isIndependentCodexQuotaScope(quotaScope)
    ) {
      // NOT guarded by manualPreferenceBlocks, unlike preemption below. Measured: guarding
      // it fails 8 cases in tests/codex-integration/codex-routing.test.ts, because a model
      // detour is not the pool exercising discretion — the operator's account cannot serve
      // this model at all. Under a rotating strategy this promote only moves the
      // process-local cursor to whoever is actually serving and releases the pin; the
      // operator's persisted activeCodexAccountId is left untouched either way, which is
      // the thing the preference exists to protect.
      promoteActiveCodexAccount(config, strategyPick);
    }
    return { status: "selected", accountId: strategyPick, affinity: affinityAfterRelease(threadId, releaseReason) };
  }

  let active = getEffectiveActiveCodexAccountId(config);
  if (!active) {
    const selected = pickLowestUsageCodexAccount(config, undefined, now, quotaScope, selectionOptions);
    if (!selected) {
      if (
        selectionOptions?.nativeMainSelectionOnly === true
        && selectionOptions.modelEligibleAccountIds !== undefined
      ) {
        return { status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID, affinity: affinityAfterRelease(threadId, releaseReason) };
      }
      return { status: "none", affinity: affinityOnNoAccount(threadId, releaseReason) };
    }
    if (!isIndependentCodexQuotaScope(quotaScope) && !modelScopedSelection) {
      setActiveCodexAccount(config, selected);
    }
    active = selected;
  }
  const activeSelectableForSharedState = isCodexAccountSelectable(
    config,
    active,
    now,
    quotaScope,
    sharedSelectionOptions,
  );
  const activeHealthyForSharedSelection = activeSelectableForSharedState
    && hasCodexSharedStateQuotaHeadroom(config, active, quotaScope, sharedSelectionOptions, now)
    && !shouldFailover(config, active, now);
  if (!isCodexAccountSelectable(config, active, now, quotaScope, selectionOptions)) {
    const fallback = pickLowestUsageCodexAccount(config, active, now, quotaScope, selectionOptions);
    if (fallback) {
      const modelOnlyMove = modelScopedSelection
        && preserveSharedSelectionForModelDetour
        && activeHealthyForSharedSelection;
      if (!isIndependentCodexQuotaScope(quotaScope) && !modelOnlyMove) {
        setActiveCodexAccount(config, fallback);
      }
      active = fallback;
    } else if (
      selectionOptions?.nativeMainSelectionOnly === true
      && selectionOptions.modelEligibleAccountIds !== undefined
    ) {
      // Entitlement discovery intentionally excludes main while a temporary drain
      // fences its credential. Once every eligible non-main candidate is unavailable,
      // return main only as a non-mutating sentinel so the caller's atomic claim can
      // classify maintenance. Do not fall through to the configured-but-ineligible
      // active account or persist/bind this synthetic selection.
      return { status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID, affinity: affinityAfterRelease(threadId, releaseReason) };
    } else if (
      hasConfiguredPoolAccount(config, active, selectionOptions)
      && !isCodexAccountPaused(config, active)
      && !isCodexAccountPlanExcluded(config, active)
    ) {
      return { status: "selected", accountId: active, affinity: affinityAfterRelease(threadId, releaseReason) };
    } else {
      return { status: "none", affinity: affinityOnNoAccount(threadId, releaseReason) };
    }
  }
  // Before applyQuotaAutoSwitch: its sync disk write would otherwise persist a
  // move inside the drained tier that preemption immediately overrides.
  const preempted = pickPriorityPreemption(config, active, now, quotaScope, selectionOptions);
  if (preempted) {
    // Runtime-only, like every other automatic pick: config.activeCodexAccountId
    // stays the operator's selection and getEffectiveActiveCodexAccountId is what
    // surfaces this to the API and dashboard. An independent quota group must not
    // move the shared cursor at all — its ordering decision is its own.
    if (
      !preserveSharedSelectionForModelDetour
      && !isIndependentCodexQuotaScope(quotaScope)
    ) {
      // Preemption is an automatic pick competing with the operator, so it yields.
      if (!manualPreferenceBlocks(POOL_KEY_CODEX, preempted)) {
        rememberActiveCodexAccount(config, preempted);
      }
    }
    active = preempted;
  }
  active = applyQuotaAutoSwitch(
    config,
    active,
    now,
    quotaScope,
    selectionOptions,
    !preserveSharedSelectionForModelDetour,
  );
  active = applyFailureFailover(
    config,
    active,
    now,
    quotaScope,
    selectionOptions,
    !preserveSharedSelectionForModelDetour,
  );
  // The shared cursor can name an account whose own roster denies this model, and an active
  // account never passes through the eligible list. Correct it for THIS request only -- nothing
  // is persisted -- and only toward an account eligibility already admitted (#4768).
  active = preferModelEntitledAccount(config, active, now, quotaScope, selectionOptions);
  if (!isCodexAccountUsable(config, active, selectionOptions)) {
    return hasConfiguredPoolAccount(config, active, selectionOptions)
      ? { status: "selected", accountId: active, affinity: affinityAfterRelease(threadId, releaseReason) }
      : { status: "none", affinity: affinityOnNoAccount(threadId, releaseReason) };
  }
  if (isCodexAccountPaused(config, active)) return { status: "none", affinity: affinityOnNoAccount(threadId, releaseReason) };
  if (getCodexQuotaHealthSnapshot(active, quotaScope, now)) {
    return hasConfiguredPoolAccount(config, active, selectionOptions)
      ? { status: "selected", accountId: active, affinity: affinityAfterRelease(threadId, releaseReason) }
      : { status: "none", affinity: affinityOnNoAccount(threadId, releaseReason) };
  }
  if (threadId) {
    if (preserveExistingModelScopedAffinity) {
      bindModelDetourAffinity(threadId, active, now, modelId, quotaScope);
    } else {
      bindThreadAffinity(threadId, active, now, quotaScope);
    }
  }
  return { status: "selected", accountId: active, affinity: affinityAfterRelease(threadId, releaseReason) };
}


export function recordCodexUpstreamOutcome(
  config: OcxConfig,
  accountId: string | null,
  outcome: CodexUpstreamOutcome,
  meta: CodexUpstreamOutcomeMeta = {},
): void {
  // Host-level evidence is account-independent (#914): a pre-connection
  // reachability failure is recorded in the (provider, host) ledger even when
  // there is no account to attribute, or the account's writer generation is
  // stale — the early returns below must not gate it.
  if (outcome === "connect_neutral" && meta.hostKey) {
    recordUpstreamHostFailure(meta.hostKey, { code: meta.lastFailureCode, now: meta.now ?? Date.now() });
  }
  if (!accountId) return;
  // Conclude the half-open recovery trial BEFORE the admissibility gate below (#4701): an
  // outcome that gate drops still ended this request, and a lease nobody hands back leaves the
  // next trial waiting out its deadline. The settle carries its own fences, so this is safe here.
  settleTransientProbeForOutcome(accountId, meta, classifyCodexUpstreamOutcome(outcome, meta.denial));
  const writerGeneration = meta.writerGeneration ?? captureConfigGeneration();
  if (!isHealthAccountAdmissible(accountId, writerGeneration)) return;
  const now = meta.now ?? Date.now();
  const outcomeClass = classifyCodexUpstreamOutcome(outcome, meta.denial);
  // Reject retired quota evidence before stale-credential cleanup or any shared mutation.
  if (outcomeClass === "quota" && isRetiredCodexSparkModel(meta.modelId)
      && computeQuotaCooldown(meta).source === "reset-derived") return;
  const quotaScope = codexQuotaScopeForModel(meta.modelId);
  /*
   * Spend a stale credential failure BEFORE any branch reads health (#2892 gap 4 review).
   *
   * Reader-side spending alone is not enough: the transient and workspace branches derive their new
   * entry from the current one, so a spent G1 401 would donate its `consecutiveFailures` to G2's
   * first genuine 503 and drop the tag while doing it. The account then reaches the failover
   * threshold one failure early, and no later read can tell. Clearing it here means every branch
   * starts from evidence that still describes a live credential.
   */
  dropSpentCredentialFailure(accountId);
  if (outcomeClass === "success") {
    // The operator's one-shot is spent by a dispatch that actually worked, and only by that.
    // A failed lookup leaves it unspent so the intent survives the failure.
    consumeManualPreference(accountId, codexPoolKeyForScope(quotaScope));
    const scopedProbe = meta.probeQuotaScope
      ? scopedHealthFor(accountId, meta.probeQuotaScope)
      : undefined;
    if (scopedProbe && meta.probeQuotaScope) {
      if (scopedProbe.cooldownUntil && probeMayClearCooldown(scopedProbe, meta)) {
        deleteScopedHealth(accountId, meta.probeQuotaScope);
      } else if (ownsProbeLease(scopedProbe, meta)) {
        setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
      }
    }
    // A served request is what ends the refusal marker the quota branch left on this lane.
    // The probe contract above owns the scoped COOLDOWN; this owns only the field
    // {@link hasUnrecoveredCodexQuotaRefusal} reads, which would otherwise keep threads away
    // from an account that is demonstrably serving them again. The account-wide marker needs
    // no equivalent: every recovery write below runs it through preservedCooldownFields.
    const refusedScope = quotaScope ? scopedHealthFor(accountId, quotaScope) : undefined;
    if (quotaScope && refusedScope && carriesQuotaRefusal(refusedScope)) {
      const {
        lastFailureStatus: _refusal, lastFailureAt: _refusedAt, quotaAvoidUntil: _avoid, ...retained
      } = refusedScope;
      // A live cooldown and its probe bookkeeping survive; an entry that held nothing else goes.
      if (Object.keys(retained).length > 1) setScopedHealth(accountId, quotaScope, retained);
      else deleteScopedHealth(accountId, quotaScope);
    }
    const current = getAccountHealth(accountId);
    const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
    // A leased probe that is still on its own cooldown generation proves the
    // account recovered: clear the hard cooldown outright (#433).
    if (cooldownUntil && probeMayClearCooldown(current, meta)) {
      deleteAccountHealth(accountId);
      return;
    }
    // Owning probe on a stale generation: the lease is done, but a newer 429
    // replaced the cooldown in the meantime, so only give the lease back.
    // Non-owners keep every hard-cooldown field, including someone else's live lease.
    const base = ownsProbeLease(current, meta) ? withProbeLeaseReleased(current!, now) : current;
    const preserved = preservedCooldownFields(base);
    const failoverEnabled = (config.upstreamFailoverThreshold ?? 3) > 0;
    if (failoverEnabled && current && current.consecutiveFailures >= 2) {
      const consecutiveSuccesses = (current.consecutiveSuccesses ?? 0) + 1;
      if (consecutiveSuccesses < 2) {
        setAccountHealth(accountId, {
          ...base!,
          ...preserved,
          consecutiveSuccesses,
        });
        return;
      }
    }
    // Level 1 clears immediately; escalated accounts need two consecutive healthy terminals.
    // Hard quota cooldown intentionally survives either recovery path.
    if (cooldownUntil) setAccountHealth(accountId, { consecutiveFailures: 0, ...preserved });
    else deleteAccountHealth(accountId);
    return;
  }
  if (outcomeClass === "caller") {
    // A 4xx does not change account health, but it does conclude an in-flight
    // probe — otherwise the lease would never be handed back.
    const current = getAccountHealth(accountId);
    const scopedProbe = meta.probeQuotaScope
      ? scopedHealthFor(accountId, meta.probeQuotaScope)
      : undefined;
    if (scopedProbe && meta.probeQuotaScope && ownsProbeLease(scopedProbe, meta)) {
      setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
    }
    if (ownsProbeLease(current, meta)) {
      setAccountHealth(accountId, withProbeLeaseReleased(current!, now));
    }
    return;
  }

  if (outcomeClass === "neutral") {
    // A proven pre-connection reachability failure (DNS / TCP refusal) or a
    // relayed 3xx is host-level, not account evidence: rotation cannot repair
    // it and must not happen (#914). Conclude any owned probe lease, record the
    // failure under the (provider, host) ledger when one is named, and leave
    // account health, thread affinity, and the active account untouched.
    const current = getAccountHealth(accountId);
    const scopedProbe = meta.probeQuotaScope
      ? scopedHealthFor(accountId, meta.probeQuotaScope)
      : undefined;
    if (scopedProbe && meta.probeQuotaScope && ownsProbeLease(scopedProbe, meta)) {
      setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
    }
    if (ownsProbeLease(current, meta)) {
      setAccountHealth(accountId, withProbeLeaseReleased(current!, now));
    }
    return;
  }

  const lastFailureStatus = typeof outcome === "number" ? outcome : 0;
  if (outcomeClass === "workspace") {
    // The credential is valid; this account just cannot reach this workspace (#1789).
    // Record the failure so routing stops preferring it, but do not mark it for
    // reauthentication and do not sweep its thread affinities: telling the user to
    // re-login is wrong advice that cannot fix a workspace grant.
    setAccountHealth(accountId, {
      consecutiveFailures: (getAccountHealth(accountId)?.consecutiveFailures ?? 0) + 1,
      lastFailureStatus,
      lastFailureAt: now,
    });
    return;
  }
  if (outcomeClass === "credential") {
    // 401/403 quarantines the account for reauth. That supersedes quota state
    // entirely: a cooldown (and any probe lease) on an unusable account is moot.
    // Unless the rejected credential is already gone: a stale 401 racing a
    // replacement would otherwise take the fresh credential out of rotation and
    // sweep affinities that belong to it (#2887).
    if (
      meta.credentialGeneration !== undefined
      && !isCodexAccountGenerationLive(accountId, meta.credentialGeneration)
    ) {
      return;
    }
    /*
     * The pre-check above closes the same-process race, but not a cross-process one (#2892 gap 4).
     * `isCodexAccountGenerationLive` is an unlocked read while credential writers coordinate under
     * the mutation lock, and OS preemption needs no `await` — so another process can replace the
     * credential after this check, or at any point after this whole function returns. No re-read here
     * can close that: a replacement is always free to land one instruction later.
     *
     * Taking the credential lock is not an option either: it runs with `busy_timeout=0`, so acquiring
     * it per outcome would turn ordinary contention into thrown request-path errors.
     *
     * So the evidence is TAGGED with the credential it describes and judged when it is READ. The
     * health entry carries `credentialFailureGeneration` and the reauth map carries the same
     * generation; `dropSpentCredentialFailure` and `isAccountNeedsReauth` discard an entry whose
     * credential is gone. A later transient or quota write replaces the entry along with its tag, and
     * `preservedCooldownFields` drops the tag explicitly, so this provenance can never be spent
     * against a failure it did not describe.
     *
     * Affinity sweeping needs no tag: an affinity entry already carries a credential generation and
     * self-invalidates on the next check, and re-adding swept entries would be a worse bug.
     */
    setAccountHealth(accountId, {
      consecutiveFailures: 1,
      lastFailureStatus,
      lastFailureAt: now,
      // Provenance rides on the entry: only this failure can be spent when its credential dies.
      ...(meta.credentialGeneration !== undefined
        ? { credentialFailureGeneration: meta.credentialGeneration }
        : {}),
    });
    deleteAllScopedHealth(accountId);
    // The reauth flag carries the same provenance, so a replacement landing after this call cannot
    // inherit a quarantine that was never about it.
    markAccountNeedsReauth(accountId, writerGeneration, meta.credentialGeneration);
    clearThreadAccountMapForAccount(accountId, "quota_refusal");
    return;
  }

  if (outcomeClass === "quota") {
    const { until, source } = computeQuotaCooldown(meta);
    // A reset timestamp is an advisory quota-window announcement. When the
    // selected native model belongs to a confirmed independent group, preserve
    // it there so a different group (Reserve versus the shared native quota) can
    // still reach upstream. Explicit Retry-After/default 429s remain account-wide.
    if (source === "reset-derived" && quotaScope) {
      const prior = scopedHealthFor(accountId, quotaScope);
      const cooldownGeneration = (prior?.cooldownGeneration ?? 0) + 1;
      const ownsLease = meta.probeQuotaScope === quotaScope && ownsProbeLease(prior, meta);
      setScopedHealth(accountId, quotaScope, {
        consecutiveFailures: 0,
        lastFailureStatus,
        lastFailureAt: now,
        cooldownUntil: until,
        quotaAvoidUntil: quotaAvoidUntilFor(meta, now, until),
        cooldownSince: now,
        cooldownSource: source,
        cooldownGeneration,
        ...(ownsLease
          ? { lastProbeAt: now }
          : {
            ...(prior?.probeLeaseId !== undefined ? { probeLeaseId: prior.probeLeaseId } : {}),
            ...(prior?.probeLeaseGeneration !== undefined ? { probeLeaseGeneration: prior.probeLeaseGeneration } : {}),
            ...(prior?.lastProbeAt !== undefined ? { lastProbeAt: prior.lastProbeAt } : {}),
        }),
      });
      // The shared native scope is the existing account-wide native behavior:
      // threads must leave it and new requests should prefer an eligible account.
      // Reserve remains isolated so a same-account Terra/Luna combo fallback can run.
      if (quotaScope === "shared" && !meta.fixedAccount) {
        clearThreadAccountMapForAccount(accountId, "quota_refusal");
        notePoolRotationFailure(POOL_KEY_CODEX, accountId);
        if (getEffectiveActiveCodexAccountId(config) === accountId) {
          // Same-request 429 retry already picked via excludeAccountId — reuse it so
          // round-robin does not advance the ring a second time.
          const reused = meta.promoteAccountId && meta.promoteAccountId !== accountId
            ? meta.promoteAccountId
            : null;
          const fallback = reused ?? pickAlternateCodexAccount(config, accountId, now, quotaScope);
          if (fallback) promoteActiveCodexAccount(config, fallback);
        }
      }
      return;
    }

    // A scoped probe that received an account-wide throttle is no longer live.
    const scopedProbe = meta.probeQuotaScope
      ? scopedHealthFor(accountId, meta.probeQuotaScope)
      : undefined;
    if (scopedProbe && meta.probeQuotaScope && ownsProbeLease(scopedProbe, meta)) {
      setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
    }
    const prior = getAccountHealth(accountId);
    // Every cooldown write bumps the generation so a probe issued against the
    // previous cooldown can no longer clear this one (#433).
    const cooldownGeneration = (prior?.cooldownGeneration ?? 0) + 1;
    // A failed probe concludes its lease; an unrelated 429 leaves the live probe alone.
    const ownsLease = ownsProbeLease(prior, meta);
    setAccountHealth(accountId, {
      consecutiveFailures: 0,
      lastFailureStatus,
      lastFailureAt: now,
      cooldownUntil: until,
      quotaAvoidUntil: quotaAvoidUntilFor(meta, now, until),
      cooldownSince: now,
      cooldownSource: source,
      cooldownGeneration,
      ...(ownsLease
        ? { lastProbeAt: now }
        : {
          ...(prior?.probeLeaseId !== undefined ? { probeLeaseId: prior.probeLeaseId } : {}),
          ...(prior?.probeLeaseGeneration !== undefined ? { probeLeaseGeneration: prior.probeLeaseGeneration } : {}),
          ...(prior?.lastProbeAt !== undefined ? { lastProbeAt: prior.lastProbeAt } : {}),
        }),
    });
    if (!meta.fixedAccount) {
      clearThreadAccountMapForAccount(accountId, "quota_refusal");
      // An independent native quota request may discover an account-wide throttle,
      // but it still must not advance the shared RR ring or active cursor. The next
      // shared request observes the cooldown and chooses its own fallback.
      if (!isIndependentCodexQuotaScope(quotaScope)) {
        notePoolRotationFailure(POOL_KEY_CODEX, accountId);
        const effectiveActive = getEffectiveActiveCodexAccountId(config);
        if (effectiveActive === accountId) {
          // Same-request 429 retry already picked via excludeAccountId — reuse it so
          // round-robin does not advance the ring a second time.
          const reused = meta.promoteAccountId && meta.promoteAccountId !== accountId
            ? meta.promoteAccountId
            : null;
          const fallback = reused ?? pickAlternateCodexAccount(config, accountId, now, quotaScope);
          if (fallback) promoteActiveCodexAccount(config, fallback);
        }
      }
    }
    return;
  }

  // transient (connect_error / timeout / 5xx)
  const current = getAccountHealth(accountId);
  const scopedProbe = meta.probeQuotaScope
    ? scopedHealthFor(accountId, meta.probeQuotaScope)
    : undefined;
  if (scopedProbe && meta.probeQuotaScope && ownsProbeLease(scopedProbe, meta)) {
    setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
  }
  // A transient failure concludes an owning probe; an unrelated 5xx must not
  // consume someone else's live lease or drop hard-cooldown bookkeeping (#433).
  const transientBase = ownsProbeLease(current, meta) ? withProbeLeaseReleased(current!, now) : current;
  const stale = current?.lastFailureAt ? now - current.lastFailureAt > CODEX_FAILURE_WINDOW_MS : false;
  const hardCooldownUntil = getCodexAccountCooldownUntil(accountId, now) ?? undefined;
  // Soft avoid + affinity clears are part of failover. When threshold is 0, leave
  // sticky sessions alone (same as shouldFailover / applyFailureFailover no-ops).
  const failoverThreshold = config.upstreamFailoverThreshold ?? 3;
  const consecutiveFailures = stale ? 1 : (current?.consecutiveFailures ?? 0) + 1;
  const failoverReady = failoverThreshold > 0 && consecutiveFailures >= failoverThreshold;
  const escalationMs = CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS[
    Math.min(Math.max(consecutiveFailures - failoverThreshold, 0), CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS.length - 1)
  ]!;
  const softAvoidUntil = failoverReady
    ? Math.max(
      getCodexAccountSoftAvoidUntil(accountId, now) ?? 0,
      now + escalationMs,
    )
    : undefined;
  setAccountHealth(accountId, {
    ...preservedCooldownFields(transientBase),
    consecutiveFailures,
    lastFailureStatus,
    lastFailureAt: now,
    ...(hardCooldownUntil ? { cooldownUntil: hardCooldownUntil } : {}),
    ...(softAvoidUntil !== undefined ? { softAvoidUntil } : {}),
  });
  // Drop this thread's pin immediately so the next continue can rebind without
  // waiting for the soft-avoid selectable check. Guard: only delete when the
  // thread is still pinned to the FAILING account — a late failure from account A
  // must not delete a newer healthy binding to account B (race: T→A, A fails,
  // T→B, late A failure must not delete B's mapping).
  // A transient streak no longer surrenders the conversation: the resolve path detours this
  // thread onto a remembered alternate and KEEPS the binding, so recovering costs nothing
  // (#4546). The pin is dropped only once the hold has outlived what a transient failure can
  // explain, the same bound the resolve path applies -- recorded here so a thread that simply
  // stops sending cannot leave a dead pin behind.
  if (
    !meta.fixedAccount
    && failoverReady
    && meta.threadId
    && isTransientHoldSpentForAccount(meta.threadId, accountId, now)
  ) {
    deleteThreadAffinitiesForAccount(meta.threadId, accountId);
  }
  // No account-wide clear for a transient streak. Every pinned thread reaches the same detour
  // on its own next request, and wiping the map would retire bindings for quota scopes the
  // failure never described -- a spent Terra window must not evict the same thread's Spark pin.
  if (
    !meta.fixedAccount
    && !isIndependentCodexQuotaScope(quotaScope)
    && getEffectiveActiveCodexAccountId(config) === accountId
  ) {
    applyFailureFailover(config, accountId, now, quotaScope);
  }
}

export function formatCodexProviderForLog(providerName: string, accountId: string | null, config: OcxConfig): string {
  if (!accountId) return providerName;
  // The main Codex login participates in rotation as "main-pool" (MAIN_CODEX_ACCOUNT_ID) but is the
  // same physical account as the "main" passthrough (null accountId). Log both under the base provider
  // name so usage/tokens aggregate into a single row instead of splitting into `chatgpt` + `chatgpt-main`.
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return providerName;
  const account = (config.codexAccounts ?? [])
    .find(candidate => isSelectableCodexPoolAccount(candidate) && candidate.id === accountId);
  return account ? `${providerName}-${codexAccountLogLabel(account)}` : providerName;
}
