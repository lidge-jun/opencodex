import type { OcxConfig } from "../../types";
import type { CodexAccountUsabilityOptions } from "../account-usability";
import { isCodexAccountUsable } from "../account-usability";
import { isCacheAffinityEnabled, isUnknownUsage } from "./selection";

/**
 * Does a healthy bound account keep its conversation when quota re-evaluation looks at it?
 *
 * Two independent reasons say yes, and they are not the same claim. `pool.cacheAffinity` is an
 * operator preference about COST: provider prompt caches are account-isolated, so handing a bound
 * conversation from account to account re-sends the whole prefix, and #4546 measured 7k-token
 * turns becoming 150k-token ones. Setting it false restores capacity-first routing, and an
 * operator who wants that keeps it.
 *
 * Uploaded-file retention is a claim about CORRECTNESS, so it does not take that instruction
 * (#4778). Uploaded files are scoped to the account that issued them. Moving a conversation that
 * carries live `file_id` references does not cost a cold prefix -- it orphans the reference, and
 * because the reference stays in conversation history EVERY later turn is refused with
 * `409 account_change_file_scope` until the user re-uploads under the serving account or starts
 * over. That is a dead conversation rather than an expensive one, and `pool.cacheAffinity: false`
 * was never asking to accept it: the flag trades cache locality for capacity, not correctness for
 * capacity.
 *
 * This answers the VOLUNTARY move only. Its caller still releases the binding on genuine
 * exhaustion or an unusable account, and every involuntary release that runs earlier in
 * `resolveCodexAccountForThreadDetailed` -- quota refusal, failover streak, pause, cooldown, lost
 * generation, affinity expiry -- never reaches here at all. So retention can never wedge a
 * conversation on an account that cannot serve it, which is exactly why the #4710 refusal remains
 * required: this makes that refusal rarer and does not replace it.
 *
 * It lives beside selection rather than inside `routing.ts` because it is a policy question two
 * call sites ask -- the live path in `reevaluateAffinityQuota` and the side-effect-free
 * `previewReusableAffinityAccount` that subagent fallback reads -- and those two must answer
 * identically or preview hands fallback a different account than the request uses.
 */
export function retainsBoundAccountForQuota(
  config: OcxConfig,
  selectionOptions?: CodexAccountUsabilityOptions,
): boolean {
  return isCacheAffinityEnabled(config)
    || selectionOptions?.retainAccountForUploadedFiles === true;
}

/**
 * May a LIVE binding be moved for quota reasons?
 *
 * Default: no. The bar is genuine exhaustion, because moving a bound conversation discards the
 * prompt cache warmed on its account and a threshold crossing is a hint that the account is
 * getting busy rather than evidence it cannot serve (#4546). Deliberately NOT
 * `hasCodexQuotaHeadroom`, which reads `usage < autoSwitchThreshold` and would reproduce the old
 * rule under a new name.
 *
 * When nothing retains, the historical rule comes back: a crossing of `autoSwitchThreshold` is
 * enough. That is capacity-first routing, and an operator who asks for it keeps it -- it is just
 * not what an install gets by never having heard of the flag.
 */
export function mayRebindAffinityForQuota(
  config: OcxConfig,
  accountId: string,
  usage: number,
  threshold: number,
  selectionOptions?: CodexAccountUsabilityOptions,
): boolean {
  const overThreshold = threshold > 0 && !isUnknownUsage(usage) && usage >= threshold;
  if (!retainsBoundAccountForQuota(config, selectionOptions)) return overThreshold;
  // The usable half is already guaranteed by both callers, which gate on
  // isCodexAccountSelectable; kept explicit so the predicate reads correctly on its own.
  return !isCodexAccountUsable(config, accountId, selectionOptions)
    || (!isUnknownUsage(usage) && usage >= 100);
}
