import type { OcxConfig } from "../../types";
import { isCodexAccountPaused } from "../account-pause";
import { isAccountNeedsReauth } from "../account-runtime-state";
import type { CodexAccountUsabilityOptions } from "../account-usability";
import { isCodexAccountUsable } from "../account-usability";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { hasCodexQuotaHeadroom } from "./selection";

/** Why routing would drop a manual pin, or undefined when the pin survives. */
export type CodexPinDrainReason = "needs_reauth" | "paused" | "unusable" | "quota_threshold";

/**
 * Would routing release a pin on this account the next time it resolves?
 *
 * This lives beside selection rather than inside `routing.ts` for the same reason
 * {@link ./cache-affinity} does: it is a policy question asked by two callers that must answer
 * identically. One is `releaseDrainedCodexAccountPin`, which acts on it. The other is
 * `PUT /api/codex-auth/active`, which reports it.
 *
 * The two-step contradiction in #4521 is what happens when only the first exists. That route
 * validates existence, pause and pending validation, answers 200, and says nothing about quota;
 * the very next resolve runs this rule and drops the pin. The operator sees a setting accepted
 * and then ignored. Reporting it from the same predicate, rather than from a second copy on the
 * accepting surface, is what keeps the answer and the action from drifting -- a client-side
 * re-derivation of the usage score has to track {@link ./cooldown-math} exactly, including the
 * Free/Go plan windows and short-window freshness.
 *
 * Ordering is load-bearing. Cached reauth and configured pause are classified FIRST, because
 * they hold for the main account even while its fenced native profile is unreadable; a
 * selection-only caller then makes every later classification answer "no drain", so reading
 * reauth after that guard would make a pin on a signed-out main look durable.
 *
 * This answers only whether the pin survives. It is not an admission check: the caller that
 * acts on it releases a preference, and every involuntary release -- quota refusal, failover
 * streak, cooldown, lost generation, affinity expiry -- is decided elsewhere and earlier.
 */
export function codexAccountPinDrainReason(
  config: OcxConfig,
  accountId: string,
  selectionOptions?: Pick<
    CodexAccountUsabilityOptions,
    "nativeMainSelectionOnly" | "isMainAccountTokenLive"
  >,
  now: number = Date.now(),
): CodexPinDrainReason | undefined {
  if (isAccountNeedsReauth(accountId)) return "needs_reauth";
  if (isCodexAccountPaused(config, accountId)) return "paused";
  // Temporary drain deliberately forbids every native-main read. A pin on main cannot be
  // classified by credential liveness or quota until the fenced profile is readable. Cached
  // reauth and configured pause state were handled above.
  if (accountId === MAIN_CODEX_ACCOUNT_ID && selectionOptions?.nativeMainSelectionOnly === true) {
    return undefined;
  }
  if (!isCodexAccountUsable(config, accountId, selectionOptions)) return "unusable";
  if (!hasCodexQuotaHeadroom(config, accountId, selectionOptions, now)) return "quota_threshold";
  return undefined;
}
