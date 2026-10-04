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
import type { SpendReservationProof } from "./spend-reservation-ledger";
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
  | "spend-exhausted"
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
  /**
   * True when the caller's request was rebuilt onto a different destination by an
   * authorized mid-flight change (e.g. Kiro's reset-triggered account rebuild).
   * The physical destination is still recorded, but the move is not a failover
   * decision: it must not consume the request's single target transition or
   * alternate-target allowance, which belong to the actual endpoint fallback.
   */
  readonly rebasedTarget?: boolean;
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
  /**
   * Take over an externally counted booking, because the layer holding this permit is the one
   * that physically sends.
   *
   * `countedExternally` promises that a retry helper will name this send through
   * `onSendsConsumed`. An adapter that owns its own dispatch ladder -- Kiro's reset loop,
   * Cursor's transport loop -- reserves per physical send instead, so no reporter ever arrives
   * and the pending booking would sit there until it silently swallowed an unrelated later
   * report. Confirming through this method settles the permit AND closes the booking, so the
   * send stays charged exactly once (#4709). Returns false once the permit is settled, which is
   * what keeps one permit from admitting two sends.
   */
  assumeCharge(): boolean;
}

export type DispatchDecision =
  | { allowed: true; permit: SingleUseDispatchPermit }
  | { allowed: false; reason: BudgetDenial };

/**
 * Notified when this request's physical-send count moves.
 *
 * `spent` is the only number here that counts SENDS rather than intentions: a reservation
 * increments it, a refund decrements it, and an externally reported send settles against a
 * booking that was already counted. Anything that books one entry per increment therefore
 * books exactly one entry per physical send -- which is what lets the durable spend ledger
 * have a production caller without every dispatch site in the tree remembering to call it.
 *
 * `charge` may refuse, and a refusal denies the dispatch. That is deliberate: the ledger is
 * the only bound here that survives a restart, so a limit it enforces has to be able to stop a
 * send rather than merely describe one.
 */
export interface RequestSendObserver {
  /**
   * Book one physical send. False refuses the dispatch before the budget charges it.
   *
   * `alreadySent` marks a send that has already left, which the reporting transports below
   * do after the fact. Its answer is not a decision -- nothing can un-send it -- and the
   * observer must RECORD it rather than drop it. Dropping it is a fixpoint: the send that
   * would cross a ceiling never joins the total, the total stays just under, and the ceiling
   * never fires for any later request either.
   */
  charge(options?: { alreadySent?: boolean; deferDispatch?: boolean; onReserved?: (proof: SpendReservationProof) => void }): boolean;
  /** Confirm the exact reservation once its dispatch is known. */
  dispatch?(proof: SpendReservationProof): void;
  /** Give back a booking whose send never happened. */
  refund(proof?: SpendReservationProof | null): void;
}

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
  /**
   * Spend one operator-granted replacement for an AMBIGUOUS failure of this logical request,
   * up to `limit`. False once the request has none left.
   *
   * It lives on the budget rather than beside the policy that grants it because it has to be
   * shared exactly where the physical-send ledger is shared. A combo child derives its own
   * budget from the parent's ledger, and two counters would let a request whose parent leg
   * reset before the head and whose child leg reset after it replace an unknown-state send
   * twice. It is NOT a send budget: an authorised replacement still has to fit inside
   * `remainingBaseSends` like every other send.
   *
   * `limit` is the ceiling the ASKING leg is authorised to present, and the request keeps the
   * smallest one any leg has presented. A leg reads it from `route.provider`, which credential
   * rotation, OAuth refresh, transport resolution and a combo target all reassign mid-request,
   * so a per-call ceiling meant the number of duplicate inferences a request could make
   * depended on which row happened to ask last: a row granting one, then a row granting two,
   * bought a second replacement of a turn that may already have run.
   *
   * Optional so a hand-written stub that satisfies the shape test keeps typechecking; a caller
   * that cannot reach it has no operator override, which is the fail-closed answer.
   */
  claimAmbiguousResend?(limit: number): boolean;
  /** True once any scope has claimed a replacement for this logical request. */
  readonly ambiguousResendSpent?: boolean;
}

const RESERVE_FUNDED_CLASSES: ReadonlySet<SendClass> = new Set<SendClass>([
  "account-failover",
  "combo-failover",
  "repair",
  "auth-recovery",
]);

let logicalRequestSeq = 0;

/**
 * One request's physical-send ledger, held apart from the budget object so a derived policy
 * scope can share the exact same one.
 *
 * `spent` and `pendingExternalSends` belong together: a pending booking is a send that is
 * already counted in `spent` and awaiting its reporter, so a scope that shared one without the
 * other would either charge that send twice or never charge it at all.
 *
 * The durable-spend observer belongs here for the same reason. It books one entry per physical
 * send by watching this counter move, so a derived scope that spent the counter without
 * carrying the observer would move it without booking, and a combo child's sends would go
 * missing from the ledger (#4707).
 */
interface SharedSendLedger {
  spent: number;
  pendingExternalSends: Set<object>;
  /**
   * Spend one of this logical request's replacements for an ambiguous failure. Beside `spent`
   * for the same reason `pendingExternalSends` is: a derived scope that shared one without the
   * other would hand the request a second grant.
   *
   * A function rather than the raw count, because the count is not the whole state. The
   * ceiling belongs to the request too, and a bridged scope has no counter of its own to keep
   * it in -- it has to ask whoever holds the request's grant.
   */
  claimAmbiguousResend(limit: number): boolean;
  readonly ambiguousResendSpent: boolean;
  readonly observer?: RequestSendObserver;
}

const sharedSendLedgers = new WeakMap<RequestExecutionBudget, SharedSendLedger>();
const dispatchSpendProofs = new WeakMap<SingleUseDispatchPermit, {
  owner: SharedSendLedger;
  claim(): SpendReservationProof | undefined;
  report(): boolean;
}>();

/** One preflight for the exact prepaid dispatch, never another budget or a replayed permit. */
export function claimDispatchSpendProof(budget: RequestExecutionBudget, permit?: SingleUseDispatchPermit): SpendReservationProof | undefined {
  const proof = permit && dispatchSpendProofs.get(permit);
  return proof && proof.owner === sharedSendLedgers.get(budget) ? proof.claim() : undefined;
}

/** Reports actual sends against only the named permit on this shared ledger. */
export function reportDispatchSends(
  budget: TransientSendBudget,
  sends: number,
  permit?: SingleUseDispatchPermit,
): void {
  const count = Number.isFinite(sends) ? Math.max(0, Math.trunc(sends)) : 0;
  if (count === 0) return;
  const receipt = permit && dispatchSpendProofs.get(permit);
  const prepaid = receipt && receipt.owner === sharedSendLedgers.get(budget as RequestExecutionBudget)
    && receipt.report() ? 1 : 0;
  // Unnamed, foreign, released or already-reported permits cannot consume another receipt.
  budget.used += count - prepaid;
}

/**
 * One logical request's replacement grant: how many it has spent, and the ceiling it is held
 * to.
 *
 * The ceiling is the SMALLEST any leg has presented rather than whatever the current leg
 * presents. Each leg reads its number from the provider row it is running against, and that
 * row changes inside one request -- credential rotation, OAuth refresh, transport resolution
 * and each combo target reassign it. Taking the asking leg's number let a request that had
 * already spent the one replacement a strict row granted buy another as soon as a more
 * permissive row asked, which is a second duplicate inference of one turn.
 */
function createAmbiguousResendGrant(): Pick<SharedSendLedger, "claimAmbiguousResend" | "ambiguousResendSpent"> {
  let claimed = 0;
  let ceiling: number | undefined;
  return {
    get ambiguousResendSpent(): boolean { return claimed > 0; },
    claimAmbiguousResend(limit: number): boolean {
      const presented = Number.isFinite(limit) ? Math.trunc(limit) : 0;
      // A zero or nonsense ceiling refuses on its own and leaves the request's alone. It is a
      // caller that cannot state a grant, not an operator narrowing this request: a leg with no
      // policy is refused before it ever claims, so binding the request to a malformed number
      // would only let such a caller cancel a grant an opted-in row really made.
      if (presented <= 0) return false;
      ceiling = ceiling === undefined ? presented : Math.min(ceiling, presented);
      if (claimed >= ceiling) return false;
      claimed += 1;
      return true;
    },
  };
}

function createRequestExecutionBudgetWithLedger(
  policy: RequestExecutionBudgetPolicy,
  logicalRequestId: string | undefined,
  counter: SharedSendLedger,
): RequestExecutionBudget {
  const observer = counter.observer;
  let reserveSpent = false;
  let alternateTargetSends = 0;
  let targetTransitions = 0;
  let lastTargetKey: string | undefined;
  const targetReservations: Array<{ targetKey: string }> = [];

  const budget: RequestExecutionBudget = {
    get used(): number { return counter.spent; },
    set used(next: number) {
      // A numeric report has no receipt identity. Only reportDispatchSends may settle a
      // prepaid permit; guessing by reservation order can refund another leg's actual send.
      const charged = next - counter.spent;
      counter.spent = Math.max(0, next);
      // These sends have already left. The ledger records them even past a ceiling it would
      // have refused, because refusing after the fact only hides spend that was really
      // incurred -- the refusal has to happen at the reservation below, or not at all.
      for (let index = 0; index < charged; index += 1) observer?.charge({ alreadySent: true });
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
    claimAmbiguousResend(limit: number): boolean {
      return counter.claimAmbiguousResend(limit);
    },
    get ambiguousResendSpent(): boolean { return counter.ambiguousResendSpent; },
    reserveDispatch(intent: DispatchIntent): DispatchDecision {
      if (intent.replaySafe === false) return { allowed: false, reason: "not-replay-safe" };
      if (counter.spent >= policy.maxTotalModelSends) return { allowed: false, reason: "total-exhausted" };

      const changesTarget = lastTargetKey !== undefined && lastTargetKey !== intent.targetKey;
      const isAlternateTarget = changesTarget || intent.sendClass === "account-failover"
        || intent.sendClass === "combo-failover";
      const chargesTransition = changesTarget && intent.rebasedTarget !== true;
      const chargesAlternateTarget = isAlternateTarget && intent.rebasedTarget !== true;
      if (isAlternateTarget && chargesTransition && targetTransitions >= policy.maxTargetTransitions) {
        return { allowed: false, reason: "target-transition-exhausted" };
      }
      if (chargesAlternateTarget && alternateTargetSends >= policy.maxAlternateTargetSends) {
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

      // Consulted last, because it is the only bound here that WRITES. A ledger entry booked
      // for a dispatch a cheaper check above would have refused is spend this request never
      // makes, and it would hold those tokens against the scope until retention expired.
      let spendProof: SpendReservationProof | undefined;
      if (observer && !observer.charge({ deferDispatch: true, onReserved: proof => { spendProof = proof; } })) {
        return { allowed: false, reason: "spend-exhausted" };
      }

      // THE RESERVATION IS THE CHARGE. Deciding here and charging in `use()` left a window in
      // which two legs read the same remainder, both received a permit, and both dispatched:
      // one remaining send admitted two physical sends, which is the per-request multiplication
      // this budget exists to stop. Everything is booked now; `release()` is the way back.
      counter.spent += 1;
      const receipt = { targetKey: intent.targetKey };
      targetReservations.push(receipt);
      if (intent.countedExternally === true) counter.pendingExternalSends.add(receipt);
      if (drawsReserve) reserveSpent = true;
      if (chargesAlternateTarget) alternateTargetSends += 1;
      if (chargesTransition) targetTransitions += 1;
      lastTargetKey = intent.targetKey;

      let settled: "open" | "used" | "released" = "open";
      const permit: SingleUseDispatchPermit = {
        sendClass: intent.sendClass,
        use(): boolean {
          if (settled !== "open") return false;
          settled = "used";
          if (intent.countedExternally !== true && spendProof) observer?.dispatch?.(spendProof);
          return true;
        },
        assumeCharge(): boolean {
          if (settled !== "open" || (intent.countedExternally === true && !counter.pendingExternalSends.has(receipt))) return false;
          settled = "used";
          // The booking this reservation made for an external reporter is now owned by the
          // caller. Close only its own receipt so a later reporter cannot spend it again.
          if (intent.countedExternally === true) counter.pendingExternalSends.delete(receipt);
          if (spendProof) observer?.dispatch?.(spendProof);
          return true;
        },
        release(): void {
          if (settled !== "open") return;
          settled = "released";
          // An externally counted reservation the reporter already settled paid for a send
          // that physically happened. Refunding it would hand the request a free send back.
          if (intent.countedExternally === true) {
            if (!counter.pendingExternalSends.delete(receipt)) return;
          }
          counter.spent -= 1;
          observer?.refund(spendProof ?? null);
          if (drawsReserve) reserveSpent = false;
          if (chargesAlternateTarget) alternateTargetSends -= 1;
          if (chargesTransition) targetTransitions -= 1;
          targetReservations.splice(targetReservations.indexOf(receipt), 1);
          lastTargetKey = targetReservations.at(-1)?.targetKey;
        },
      };
      let preflightClaimed = false;
      dispatchSpendProofs.set(permit, { owner: counter, report: () => {
        if (!counter.pendingExternalSends.has(receipt)) return false;
        if (spendProof) observer?.dispatch?.(spendProof);
        counter.pendingExternalSends.delete(receipt);
        // Reset-only helpers report just BEFORE calling the dispatch thunk. Its one use()
        // remains available, but release/proof cannot refund or reuse this reported receipt.
        return true;
      }, claim: () => {
        if (preflightClaimed || settled === "released"
          || (intent.countedExternally === true ? !counter.pendingExternalSends.has(receipt) : settled !== "open")) return undefined;
        preflightClaimed = true;
        return spendProof;
      } });
      return { allowed: true, permit };
    },
  };
  sharedSendLedgers.set(budget, counter);
  return budget;
}

export function createRequestExecutionBudget(
  policy: RequestExecutionBudgetPolicy = CODEX_TEXT_GUARDED_BUDGET_POLICY,
  logicalRequestId?: string,
  observer?: RequestSendObserver,
): RequestExecutionBudget {
  const grant = createAmbiguousResendGrant();
  return createRequestExecutionBudgetWithLedger(policy, logicalRequestId, {
    spent: 0,
    pendingExternalSends: new Set(),
    claimAmbiguousResend: grant.claimAmbiguousResend,
    get ambiguousResendSpent(): boolean { return grant.ambiguousResendSpent; },
    ...(observer ? { observer } : {}),
  });
}

/**
 * A budget that applies its own policy and keeps its own recovery ledgers while spending the
 * parent's exact physical-send ledger.
 *
 * Aliasing the public `used` property was not enough, and that is the whole defect. The factory
 * reads its own private counter back in `remainingBaseSends`, in the total check, and in the
 * reserve test, so an aliased scope answered every admission question from a counter that only
 * ever saw its own reservations. A combo's per-target holdback is computed from
 * `maxTotalModelSends` and is therefore unenforceable unless the scope actually observes what
 * the request has already spent.
 */
export function deriveRequestExecutionBudget(
  parent: RequestExecutionBudget,
  policy: RequestExecutionBudgetPolicy,
): RequestExecutionBudget {
  return createRequestExecutionBudgetWithLedger(policy, parent.logicalRequestId, ledgerFor(parent));
}

/**
 * A budget that did not come from this factory still honors the public `used` contract, so
 * bridge onto it rather than failing the request. `isRequestExecutionBudget` is a shape test,
 * so a stub can reach here; turning that into a thrown error would convert a routing request
 * into a 500 to report a condition production never produces. Only a factory-backed parent can
 * share pending external bookings and a durable-spend observer, which are private by
 * construction; a bridged scope keeps the parent's spend accurate and books nothing of its own.
 */
/**
 * Grant claims made THROUGH a bridge, keyed by the bridged parent so every scope derived from it
 * sees them. A parent that predates `ambiguousResendSpent` can still grant through
 * `claimAmbiguousResend`; reading only its missing flag would report "not spent" after a derived
 * scope spent the grant, and a combo would then hop on a zero-output 200 from the replacement.
 */
const bridgedGrantClaims = new WeakMap<RequestExecutionBudget, { claimed: boolean }>();

function ledgerFor(parent: RequestExecutionBudget): SharedSendLedger {
  const existing = sharedSendLedgers.get(parent);
  if (existing) return existing;
  const pendingExternalSends = new Set<object>();
  let bridged = bridgedGrantClaims.get(parent);
  if (!bridged) {
    bridged = { claimed: false };
    bridgedGrantClaims.set(parent, bridged);
  }
  const claims = bridged;
  return {
    get spent(): number { return parent.used; },
    set spent(next: number) { parent.used = next; },
    pendingExternalSends,
    // Asked of the parent rather than counted here. A local counter is a SECOND grant: two
    // scopes derived from one bridged parent, or one scope beside the parent it was derived
    // from, each replaced an unknown-state send once. Pending bookings and the durable-spend
    // observer genuinely cannot cross this boundary because they are private to the factory,
    // but the grant can -- `claimAmbiguousResend` is public on the parent. A parent that does
    // not implement it grants nothing, which is the fail-closed answer for a send whose
    // upstream state is unknown.
    claimAmbiguousResend: (limit: number): boolean => {
      const granted = parent.claimAmbiguousResend?.(limit) === true;
      if (granted) claims.claimed = true;
      return granted;
    },
    get ambiguousResendSpent(): boolean { return claims.claimed || parent.ambiguousResendSpent === true; },
  };
}

export function isRequestExecutionBudget(
  value: TransientSendBudget | undefined,
): value is RequestExecutionBudget {
  return typeof (value as RequestExecutionBudget | undefined)?.reserveDispatch === "function";
}
