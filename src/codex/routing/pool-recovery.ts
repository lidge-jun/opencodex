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
 * - Its recovery time is the LATEST of its known holds: quota-health cooldown, quota avoidance,
 *   and the credits-off usage-limit reset. An account with a hold whose end is unknown is skipped
 *   rather than guessed.
 * - An account with no recorded hold is skipped: nothing says when it became unavailable, so
 *   nothing says when it will be available again.
 * - Main itself is never a candidate; its own reset stays on the refusal.
 */
import { isCodexAccountPaused } from "../account-pause";
import { codexUsageLimitResetAt } from "../account-credit-use";
import { isSelectableCodexPoolAccount } from "../account-id";
import { isAccountNeedsReauth } from "../account-runtime-state";
import { isCodexAccountUsable } from "../account-usability";
import { getAccountQuota } from "../quota";
import type { OcxConfig } from "../../types";
import { codexQuotaAvoidUntil, getCodexQuotaHealthSnapshot, type CodexQuotaScope } from "./health-store";
import { getPoolAccountPlanForSelection, isCodexAccountHeldAtUsageLimit, isCodexAccountPlanExcluded } from "./selection";

export function nextCodexPoolRecoveryAt(
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  options: { deniedAccountIds?: ReadonlySet<string> } = {},
): number | undefined {
  let earliest: number | undefined;
  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account)) continue;
    const id = account.id;
    if (options.deniedAccountIds?.has(id) || isCodexAccountPaused(config, id)
      || isCodexAccountPlanExcluded(config, id) || isAccountNeedsReauth(id)
      || !isCodexAccountUsable(config, id)) continue;
    const holds: number[] = [];
    const health = getCodexQuotaHealthSnapshot(id, quotaScope, now);
    if (health) {
      if (typeof health.cooldownUntil !== "number" || !Number.isFinite(health.cooldownUntil)) continue;
      holds.push(health.cooldownUntil);
    }
    const avoidUntil = codexQuotaAvoidUntil(id, quotaScope, now);
    if (avoidUntil !== null) holds.push(avoidUntil);
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
