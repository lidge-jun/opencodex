/**
 * Put one Anthropic account back into the pool after a settled reset grant.
 *
 * A fresh usage read lifts a 429 quota cooldown whose rejected windows read
 * open, whatever its deadline source (#6989), but a grant should not have to
 * wait for one: the grant itself lifts admission, as far as its evidence goes:
 *
 * - `claimedAt` is when the operation was first journaled, before its first
 *   claim was sent. A refusal recorded at or after it may already describe the
 *   post-reset account (another request can be refused while the claim is in
 *   flight), so it stays.
 * - `cleared` is the window list the canonical settlement reported. The
 *   cooldown is lifted only when those windows cover every window its refusal
 *   named; an empty or partial list leaves it in place.
 *
 * Whatever the routing outcome (other than a newer refusal), the cached bars
 * are dropped and usage is reread with its own request: joining a read that
 * started before the grant could republish the pre-reset bars, and a fresh
 * reading is what lets usage recovery release a cooldown the cleared
 * list did not cover. The reread is best-effort; the grant is already spent.
 *
 * Model-family exclusions are not cleared here. Only that reread may release
 * one, and only when its payload proves the family is no longer rejected.
 */
import { anthropicRoutingFor, type AnthropicQuotaWindow } from "../oauth/anthropic-routing";
import type { AnthropicInstanceId } from "./anthropic-instance";
import { fetchAnthropicAccountQuota } from "./quota/anthropic-account-quota";
import { forgetCachedProviderAccountQuota } from "./quota/account-cache";
import { anthropicCooldownRecoveryFor } from "./quota/anthropic-cooldown-recovery";

export interface AnthropicResetAdmissionEvidence {
  /** Journal time of the operation's first record, written before the first claim was sent. */
  claimedAt: number;
  /** Windows the canonical settlement reported cleared (reset-grant window names). */
  cleared: readonly string[];
}

const QUOTA_WINDOW_FOR_RESET_WINDOW: Readonly<Record<string, AnthropicQuotaWindow>> = {
  five_hour: "five-hour",
  seven_day: "weekly",
};

export async function admitAnthropicAccountAfterReset(
  instance: AnthropicInstanceId,
  accountId: string,
  evidence: AnthropicResetAdmissionEvidence,
): Promise<void> {
  const cleared = new Set<AnthropicQuotaWindow>();
  for (const window of evidence.cleared) {
    const quotaWindow = QUOTA_WINDOW_FOR_RESET_WINDOW[window];
    if (quotaWindow) cleared.add(quotaWindow);
  }
  const outcome = anthropicRoutingFor(instance).clearAnthropicAccountCooldownForReset(accountId, evidence.claimedAt, cleared);
  if (outcome === "newer") return;
  // Move any usage read that started before the grant onto a stale generation
  // before dropping the cached row, so it cannot republish the pre-reset bars.
  // "cleared" and "uncovered" already advanced the generation in routing (an
  // uncovered entry moved with it, so the reread below can still recover it).
  if (outcome === "absent") anthropicCooldownRecoveryFor(instance).noteAnthropicCooldownMutation(accountId);
  forgetCachedProviderAccountQuota(instance, accountId);
  await fetchAnthropicAccountQuota(instance, accountId, true, undefined, true);
}
