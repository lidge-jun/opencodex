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
   * helpers' `onSendsConsumed` hook. The send is still booked at reservation time, because an
   * advisory reservation cannot stop a concurrent leg; what changes is that the booking is
   * PENDING, and the first send the external reporter names settles it instead of adding a
   * second charge. Charging both is how a four-send cap silently becomes a two-send cap.
   */
  readonly countedExternally?: boolean;
}

export interface SingleUseDispatchPermit {
  readonly sendClass: SendClass;
  /**
   * Confirm the dispatch this permit already paid for. The reservation is the charge, so this
   * charges nothing; it is how a leg proves it is the one that sent. A second call returns
   * false, which is what keeps a retry thunk from sending twice on one permit.
   */
  use(): boolean;
  /**
   * Hand back a reservation that never dispatched -- a credential move that found no alternate,
   * a rebuild abandoned before the send. Idempotent, and a no-op once the permit was used or
   * once an external send reporter already settled it.
   */
  release(): void;
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
   *
   * A reserved-but-unconfirmed send is spent for this purpose. The alternative -- counting only
   * confirmed sends -- is what let two legs read the same remainder and both dispatch.
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

interface SharedSendCounter {
  spent: number;
  pendingExternalSends: number;
}

const sharedSendCounters = new WeakMap<RequestExecutionBudget, SharedSendCounter>();

function createRequestExecutionBudgetWithCounter(
  policy: RequestExecutionBudgetPolicy,
  logicalRequestId: string | undefined,
  counter: SharedSendCounter,
): RequestExecutionBudget {
  let reserveSpent = false;
  let alternateTargetSends = 0;
  let targetTransitions = 0;
  let lastTargetKey: string | undefined;

  const budget: RequestExecutionBudget = {
    get used(): number { return counter.spent; },
    set used(next: number) {
      // The retry helpers report their real send count by assigning through this field. A
      // reservation taken with `countedExternally` has already booked one of those sends, so
      // the report settles the pending booking first and only the surplus is charged.
      const delta = next - counter.spent;
      if (delta <= 0) {
        counter.spent = Math.max(0, next);
        return;
      }
      const settled = Math.min(delta, counter.pendingExternalSends);
      counter.pendingExternalSends -= settled;
      counter.spent += delta - settled;
    },
    logicalRequestId: logicalRequestId ?? `lr-${Date.now().toString(36)}-${(logicalRequestSeq += 1).toString(36)}`,
    policyVersion: REQUEST_BUDGET_POLICY_VERSION,
    policy,
    get reserveSpent() { return reserveSpent; },
    get alternateTargetSends() { return alternateTargetSends; },
    get targetTransitions() { return targetTransitions; },
    get lastTargetKey() { return lastTargetKey; },
    remainingBaseSends(cap: number): number {
      const capped = Number.isFinite(cap) ? Math.trunc(cap) : 0;
      return Math.max(0, Math.min(capped, policy.baseSendAllowance - counter.spent));
    },
    reserveDispatch(intent: DispatchIntent): DispatchDecision {
      if (intent.replaySafe === false) return { allowed: false, reason: "not-replay-safe" };
      if (counter.spent >= policy.maxTotalModelSends) return { allowed: false, reason: "total-exhausted" };

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
      const drawsReserve = policy.baseSendAllowance - counter.spent <= 0;
      if (drawsReserve) {
        if (!RESERVE_FUNDED_CLASSES.has(intent.sendClass)) {
          return { allowed: false, reason: "base-allowance-exhausted" };
        }
        if (reserveSpent || policy.finalRecoveryAllowance <= 0) {
          return { allowed: false, reason: "final-recovery-spent" };
        }
      }

      // THE RESERVATION IS THE CHARGE. Deciding here and charging in `use()` left a window in
      // which two legs read the same remainder, both received a permit, and both dispatched:
      // one remaining send admitted two physical sends, which is the per-request multiplication
      // this budget exists to stop. Everything is booked now; `release()` is the way back.
      const previousTargetKey = lastTargetKey;
      counter.spent += 1;
      if (intent.countedExternally === true) counter.pendingExternalSends += 1;
      if (drawsReserve) reserveSpent = true;
      if (isAlternateTarget) alternateTargetSends += 1;
      if (changesTarget) targetTransitions += 1;
      lastTargetKey = intent.targetKey;

      let settled: "open" | "used" | "released" = "open";
      return {
        allowed: true,
        permit: {
          sendClass: intent.sendClass,
          use(): boolean {
            if (settled !== "open") return false;
            settled = "used";
            return true;
          },
          release(): void {
            if (settled !== "open") return;
            settled = "released";
            // An externally counted reservation the reporter already settled paid for a send
            // that physically happened. Refunding it would hand the request a free send back.
            if (intent.countedExternally === true) {
              if (counter.pendingExternalSends === 0) return;
              counter.pendingExternalSends -= 1;
            }
            counter.spent -= 1;
            if (drawsReserve) reserveSpent = false;
            if (isAlternateTarget) alternateTargetSends -= 1;
            if (changesTarget) targetTransitions -= 1;
            lastTargetKey = previousTargetKey;
          },
        },
      };
    },
  };
  sharedSendCounters.set(budget, counter);
  return budget;
}

export function createRequestExecutionBudget(
  policy: RequestExecutionBudgetPolicy = CODEX_TEXT_GUARDED_BUDGET_POLICY,
  logicalRequestId?: string,
): RequestExecutionBudget {
  return createRequestExecutionBudgetWithCounter(policy, logicalRequestId, { spent: 0, pendingExternalSends: 0 });
}

/** Derive a policy scope that shares the exact physical-send ledger with its parent. */
export function deriveRequestExecutionBudget(
  parent: RequestExecutionBudget,
  policy: RequestExecutionBudgetPolicy,
): RequestExecutionBudget {
  const counter = sharedSendCounters.get(parent);
  if (!counter) throw new Error("request execution budget is not factory-backed");
  return createRequestExecutionBudgetWithCounter(policy, parent.logicalRequestId, counter);
}

export function isRequestExecutionBudget(
  value: TransientSendBudget | undefined,
): value is RequestExecutionBudget {
  return typeof (value as RequestExecutionBudget | undefined)?.reserveDispatch === "function";
}
