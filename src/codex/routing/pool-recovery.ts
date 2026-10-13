/**
 * When another stored pool account can serve again, for a main-account hard-lock refusal (#7046).
 *
 * A pool request that fell through to the main login and met the main-account quota guard used
 * to be told to come back at main's own reset, which can be days away while a sibling pool
 * account recovers within hours. This module answers one question: the earliest KNOWN instant at
 * which a stored pool account's every temporary hold ends. It changes no routing state, selects
 * nothing, and never lifts the main guard. The client retries at that time, and ordinary selection
 * decides again from fresh state; a reset timestamp is a hint, not proof of fresh quota.
 *
 * Conservative by construction (the policy Jun is asked to confirm in #7046):
 * - An account is a candidate only when it is a selectable stored pool account that is not
 *   paused, plan-excluded, quarantined for sign-in, otherwise unusable, or denied for the model.
 *   Those are operator or credential states no clock lifts.
 * - Its recovery time is the LATEST of every routing hold with a known end: quota-health cooldown,
 *   quota avoidance, transient soft avoidance, pool-refresh backoff, and the credits-off
 *   usage-limit reset. An account under a hold whose end is unknown, or under the sliding
 *   failure-window guard (whose end moves with every failure), is skipped rather than guessed.
 * - For an account-gated model, only accounts the resolved entitlement roster admits count, and
 *   with no resolved roster nothing does.
 * - An account with no recorded hold is skipped: nothing says when it became unavailable, so
 *   nothing says when it will be available again.
 * - Main itself is never a candidate; its own reset stays on the refusal.
 */
import { isCodexAccountPaused } from "../account-pause";
import { codexUsageLimitResetAt } from "../account-credit-use";
import { isSelectableCodexPoolAccount } from "../account-id";
import { isAccountNeedsReauth } from "../account-runtime-state";
import { isCodexAccountUsable } from "../account-usability";
import { getCodexPoolRefreshCooldownUntil } from "../pool-refresh-backoff";
import { getAccountQuota } from "../quota";
import type { OcxConfig } from "../../types";
import { failureWindowSteersNewThreads } from "./failure-window";
import {
  codexQuotaAvoidUntil, getCodexAccountSoftAvoidUntil, getCodexQuotaHealthSnapshot, type CodexQuotaScope,
} from "./health-store";
import { getPoolAccountPlanForSelection, isCodexAccountHeldAtUsageLimit, isCodexAccountPlanExcluded } from "./selection";

export function nextCodexPoolRecoveryAt(
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  options: {
    deniedAccountIds?: ReadonlySet<string>;
    /** When set, only these accounts may serve the model (account-gated models). */
    eligibleAccountIds?: ReadonlySet<string>;
  } = {},
): number | undefined {
  let earliest: number | undefined;
  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account)) continue;
    const id = account.id;
    if (options.deniedAccountIds?.has(id) || (options.eligibleAccountIds && !options.eligibleAccountIds.has(id))
      || isCodexAccountPaused(config, id)
      || isCodexAccountPlanExcluded(config, id) || isAccountNeedsReauth(id)
      || !isCodexAccountUsable(config, id) || failureWindowSteersNewThreads(config, id, now)) continue;
    const holds: number[] = [];
    const health = getCodexQuotaHealthSnapshot(id, quotaScope, now);
    if (health) {
      if (typeof health.cooldownUntil !== "number" || !Number.isFinite(health.cooldownUntil)) continue;
      holds.push(health.cooldownUntil);
    }
    const avoidUntil = codexQuotaAvoidUntil(id, quotaScope, now);
    if (avoidUntil !== null) holds.push(avoidUntil);
    const softAvoidUntil = getCodexAccountSoftAvoidUntil(id, now);
    if (softAvoidUntil !== null) holds.push(softAvoidUntil);
    const refreshCooldownUntil = getCodexPoolRefreshCooldownUntil(id, now);
    if (refreshCooldownUntil !== null) holds.push(refreshCooldownUntil);
    if (isCodexAccountHeldAtUsageLimit(config, id, now)) {
      const resetAt = codexUsageLimitResetAt(getAccountQuota(id), getPoolAccountPlanForSelection(config, id), now);
      if (resetAt === undefined) continue;
      holds.push(resetAt);
    }
    if (holds.length === 0) continue;
    const recoveryAt = Math.max(...holds);
    if (recoveryAt > now && (earliest === undefined || recoveryAt < earliest)) earliest = recoveryAt;
  }
  return earliest;
}
