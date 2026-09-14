/**
 * One logical request, one execution budget (#4546).
 *
 * The amplification behind #4546 was never a single missing limit. Every layer that can
 * re-send a request -- transport retry, adapter retry, auth recovery, account failover, combo
 * failover, repair -- counted its own allowance, so a per-layer 3 composed into a per-request
 * 12. #4605 and #4608 gave the transient layers one shared counter; this module is the policy
 * that counter answers to.
 *
 * The policy is an INTERSECTION of constraints, not four independent counters. A request that
 * still has total allowance left is not thereby entitled to a second account move, and a
 * request that changed credentials does not get its target-transition allowance back. The
 * default profile keeps the recovery shape that actually works today -- three same-account
 * sends plus one alternate -- by funding the alternate from a reserve that a validated
 * sanitized repair can spend instead, but never both.
 */
import type { TransientSendBudget } from "./upstream-retry";

export type SendClass =
  | "initial"
  | "transient"
  | "auth-recovery"
  | "repair"
  | "account-failover"
  | "combo-failover"
  | "prewarm";

export interface RequestExecutionBudgetPolicy {
  /** Every model send of one logical request, including the reserve. */
  readonly maxTotalModelSends: number;
  /** Shared by the initial send, same-target transient retries, and refresh/repair legs. */
  readonly baseSendAllowance: number;
  /** ONE final recovery, shared by an account move and a validated rebuild. Not one each. */
  readonly finalRecoveryAllowance: number;
  readonly maxAlternateTargetSends: number;
  readonly maxTargetTransitions: number;
}

/**
 * Text Codex guarded profile. Three same-account sends plus one alternate is the recovery
 * shape that live traffic depends on, so a flat ceiling of 3 would break a working path.
 */
export const CODEX_TEXT_GUARDED_BUDGET_POLICY: RequestExecutionBudgetPolicy = {
  maxTotalModelSends: 4,
  baseSendAllowance: 3,
  finalRecoveryAllowance: 1,
  maxAlternateTargetSends: 1,
  maxTargetTransitions: 1,
};

export const REQUEST_BUDGET_POLICY_VERSION = "guarded-v1";

export type BudgetDenial =
  | "total-exhausted"
  | "base-allowance-exhausted"
  | "final-recovery-spent"
  | "alternate-target-exhausted"
  | "target-transition-exhausted"
  | "not-replay-safe";

export interface DispatchIntent {
  readonly sendClass: SendClass;
  /**
   * (provider route, endpoint, model lane, upstream credential identity). A quota domain is a
   * different thing and must not be folded in here.
   */
  readonly targetKey: string;
  /**
   * False refuses the dispatch outright. A request whose execution state upstream is unknown
   * is not replayable just because budget remains (RFC 9110 9.2.2).
   */
  readonly replaySafe?: boolean;
  /**
   * True when the physical send is already reported through another counter -- the retry
   * helpers' `onSendsConsumed` hook. The permit then books the reserve, alternate-target and
   * transition ledgers but leaves `used` to that reporter, because charging both is how a
   * four-send cap silently becomes a two-send cap.
   */
  readonly countedExternally?: boolean;
}

export interface SingleUseDispatchPermit {
  readonly sendClass: SendClass;
  /** Consume exactly once. A second call returns false and charges nothing. */
  use(): boolean;
}

export type DispatchDecision =
  | { allowed: true; permit: SingleUseDispatchPermit }
  | { allowed: false; reason: BudgetDenial };

/**
 * Carried on HandleResponsesOptions so a combo child, a rebuild and an alternate-account leg
 * all decrement the same holder. `used` is the existing #4605 counter and still counts every
 * model send; the reserve is what the fourth send draws on once the base allowance is gone.
 */
export interface RequestExecutionBudget extends TransientSendBudget {
  readonly logicalRequestId: string;
  readonly policyVersion: string;
  readonly policy: RequestExecutionBudgetPolicy;
  reserveDispatch(intent: DispatchIntent): DispatchDecision;
  /**
   * Sends still available from the base allowance, capped by a layer's own maximum.
   * Returns 0 when the allowance is gone -- it never floors to 1, because a floor of 1 is
   * what let every recovery leg send one more time forever.
   */
  remainingBaseSends(cap: number): number;
  readonly reserveSpent: boolean;
  readonly alternateTargetSends: number;
  readonly targetTransitions: number;
  readonly lastTargetKey: string | undefined;
}

const RESERVE_FUNDED_CLASSES: ReadonlySet<SendClass> = new Set<SendClass>([
  "account-failover",
  "combo-failover",
  "repair",
  "auth-recovery",
]);

let logicalRequestSeq = 0;

export function createRequestExecutionBudget(
  policy: RequestExecutionBudgetPolicy = CODEX_TEXT_GUARDED_BUDGET_POLICY,
  logicalRequestId?: string,
): RequestExecutionBudget {
  let reserveSpent = false;
  let alternateTargetSends = 0;
  let targetTransitions = 0;
  let lastTargetKey: string | undefined;

  const budget: RequestExecutionBudget = {
    used: 0,
    logicalRequestId: logicalRequestId ?? `lr-${Date.now().toString(36)}-${(logicalRequestSeq += 1).toString(36)}`,
    policyVersion: REQUEST_BUDGET_POLICY_VERSION,
    policy,
    get reserveSpent() { return reserveSpent; },
    get alternateTargetSends() { return alternateTargetSends; },
    get targetTransitions() { return targetTransitions; },
    get lastTargetKey() { return lastTargetKey; },
    remainingBaseSends(cap: number): number {
      const capped = Number.isFinite(cap) ? Math.trunc(cap) : 0;
      return Math.max(0, Math.min(capped, policy.baseSendAllowance - budget.used));
    },
    reserveDispatch(intent: DispatchIntent): DispatchDecision {
      if (intent.replaySafe === false) return { allowed: false, reason: "not-replay-safe" };
      if (budget.used >= policy.maxTotalModelSends) return { allowed: false, reason: "total-exhausted" };

      const changesTarget = lastTargetKey !== undefined && lastTargetKey !== intent.targetKey;
      const isAlternateTarget = changesTarget || intent.sendClass === "account-failover"
        || intent.sendClass === "combo-failover";
      if (isAlternateTarget && changesTarget && targetTransitions >= policy.maxTargetTransitions) {
        return { allowed: false, reason: "target-transition-exhausted" };
      }
      if (isAlternateTarget && alternateTargetSends >= policy.maxAlternateTargetSends) {
        return { allowed: false, reason: "alternate-target-exhausted" };
      }

      // The base allowance is spent first. Only once it is gone does a recovery class reach
      // for the single shared reserve -- an account move and a validated rebuild cannot each
      // take one.
      const drawsReserve = budget.remainingBaseSends(policy.baseSendAllowance) === 0;
      if (drawsReserve) {
        if (!RESERVE_FUNDED_CLASSES.has(intent.sendClass)) {
          return { allowed: false, reason: "base-allowance-exhausted" };
        }
        if (reserveSpent || policy.finalRecoveryAllowance <= 0) {
          return { allowed: false, reason: "final-recovery-spent" };
        }
      }

      let consumed = false;
      return {
        allowed: true,
        permit: {
          sendClass: intent.sendClass,
          use(): boolean {
            if (consumed) return false;
            consumed = true;
            // Charged here, immediately before the physical send, rather than reported after
            // the helper returns: a counter that is only reconciled afterwards cannot stop two
            // concurrent legs that both read the same remainder.
            if (intent.countedExternally !== true) budget.used += 1;
            if (drawsReserve) reserveSpent = true;
            if (isAlternateTarget) alternateTargetSends += 1;
            if (changesTarget) targetTransitions += 1;
            lastTargetKey = intent.targetKey;
            return true;
          },
        },
      };
    },
  };
  if (lastTargetKey === undefined) lastTargetKey = undefined;
  return budget;
}

export function isRequestExecutionBudget(
  value: TransientSendBudget | undefined,
): value is RequestExecutionBudget {
  return typeof (value as RequestExecutionBudget | undefined)?.reserveDispatch === "function";
}
