import type { OcxConfig } from "../../types";
import type { CodexAccountUsabilityOptions } from "../account-usability";
import { pinnedCodexAccountId } from "../account-priority";
import { getAccountQuota, resetAtToMs } from "../quota";
import { manualPreferenceBlocks } from "./active-account";
import { codexPoolKeyForScope, isIndependentCodexQuotaScope, type CodexQuotaScope } from "./health-store";
import { getEligiblePoolAccounts, hasCodexQuotaHeadroom } from "./selection";
import { bindThreadAffinity } from "./thread-affinity";

const WINDOW_MS = 5 * 60 * 60_000;
const TOLERANCE_MS = 60_000;
const FRESHNESS_MS = 5 * 60_000;
// Reservation is synchronous, so concurrent resolves cannot start the same window twice.
// Keep the deadline fixed: idle observations may slide their reset forward on every poll.
const steeredUntil = new Map<string, number>();

export function clearIdleWindowSteering(): void {
  steeredUntil.clear();
}

/** Only called for first placement, after conversation/family affinity has had precedence. */
export function pickIdleWindowAccount(
  config: OcxConfig,
  threadId: string | null,
  now: number,
  commit: boolean,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  if (config.codexPool?.startIdleWindows !== true || isIndependentCodexQuotaScope(quotaScope)
    || pinnedCodexAccountId(config) !== undefined) return null;
  const eligible = getEligiblePoolAccounts(config, undefined, now, quotaScope, selectionOptions, true);
  for (const id of eligible) {
    if (manualPreferenceBlocks(codexPoolKeyForScope(quotaScope), id)
      || selectionOptions?.deniedModelAccountIds?.has(id)
      || !hasCodexQuotaHeadroom(config, id, selectionOptions, now)) continue;
    const quota = getAccountQuota(id);
    const observed = quota?.shortObservedAt;
    const reset = quota?.shortResetAt;
    if (quota?.shortPercent !== 0 || quota.shortWindowSeconds !== WINDOW_MS / 1000
      || observed === undefined || !Number.isFinite(observed)
      || reset === undefined || !Number.isFinite(reset)
      || now < observed || now - observed > FRESHNESS_MS) continue;
    const resetMs = resetAtToMs(reset);
    const previous = steeredUntil.get(id);
    if (Math.abs(resetMs - observed - WINDOW_MS) > TOLERANCE_MS || resetMs <= now
      || (previous !== undefined && (now <= previous || observed <= previous))) continue;
    if (commit) {
      for (const [accountId, until] of steeredUntil) {
        if (until < now - FRESHNESS_MS) steeredUntil.delete(accountId);
      }
      steeredUntil.set(id, Math.max(resetMs, now + WINDOW_MS) + TOLERANCE_MS);
      if (threadId) bindThreadAffinity(threadId, id, now, quotaScope);
    }
    return id;
  }
  return null;
}
