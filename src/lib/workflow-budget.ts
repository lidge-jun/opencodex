/**
 * Root-workflow admission: a finite budget above the logical request (#4546).
 *
 * The per-request send budget bounds how many times ONE request reaches upstream. It cannot
 * bound how many requests a fan-out makes. A worker that spawns seven hundred children, each
 * of which sends exactly once, never violates a per-request cap and still spends the account.
 * That is the second half of the #4546 incident and it needs a ceiling of its own.
 *
 * The unit is the root workflow -- the user-visible task -- identified by the parent thread
 * header when the client supplies one. A retry is not a new user task and gets no new
 * allowance; a genuinely new top-level request does.
 *
 * Two caps intersect here. The COUNT caps (concurrency, distinct children, physical sends)
 * are process-local and in-memory. The TOKEN cap is the durable spend-reservation ledger in
 * spend-reservation-ledger.ts: when the caller supplies a spend request, admission also
 * reserves input + enforceable output ceiling against the root, identity and pool scopes,
 * and that accounting survives a restart. The count caps alone remain the guarantee for a
 * second process sharing the pool; the durable ledger's single-process topology is stated
 * in that module's header and applies here unchanged.
 */

import {
  sharedSpendLedger,
  type SpendReservationLedger,
  type SpendScope,
  type SpendUsage,
} from "./spend-reservation-ledger";

export interface WorkflowBudgetPolicy {
  /** Children admitted concurrently under one root. */
  readonly maxConcurrentChildren: number;
  /** Physical model sends charged to one root across its whole life. */
  readonly maxPhysicalSends: number;
  /** Distinct children one root may ever create. */
  readonly maxDistinctChildren: number;
  /**
   * Concurrency slots a fan-out may never take. An interactive turn arriving into a saturated
   * root still gets admitted; without this a worker burst starves the conversation it serves.
   */
  readonly interactiveReserve: number;
  /**
   * Roots tracked at once, as a hard bound rather than a hint. At the ceiling one idle,
   * under-limit root is evicted to make room; when no root may be forgotten safely the new
   * root is REFUSED with `workflow-tracking-exhausted`. Admitting it anyway is what made a
   * caller minting new ids able to grow this map past the number written here.
   */
  readonly maxTrackedRoots: number;
}

export const DEFAULT_WORKFLOW_BUDGET_POLICY: WorkflowBudgetPolicy = {
  maxConcurrentChildren: 8,
  maxPhysicalSends: 256,
  maxDistinctChildren: 64,
  interactiveReserve: 1,
  maxTrackedRoots: 512,
};

export type WorkflowDenial =
  | "workflow-concurrency-exhausted"
  | "workflow-sends-exhausted"
  | "workflow-children-exhausted"
  | "workflow-spend-exhausted"
  /**
   * The root table is full and every entry is active or exhausted, so admitting this root
   * would mean evicting one whose ceiling has already fired. Refusing is the honest answer:
   * `maxTrackedRoots` is a bound, and inserting anyway made it a suggestion.
   */
  | "workflow-tracking-exhausted"
  /** This send id was already reserved once; a repeat buys no second dispatch. */
  | "workflow-send-replayed"
  /** The reservation could not be made durable, and a configured ceiling requires it. */
  | "workflow-spend-undurable";

export type WorkflowLane = "interactive" | "worker";

export interface WorkflowAdmission {
  readonly rootId: string;
  /**
   * The request is about to leave for upstream. Call this at the dispatch boundary: until it
   * runs, releasing the lease costs nothing, and after it a missing usage frame is booked as
   * unresolved spend.
   */
  markDispatched(): void;
  release(): void;
}

export type WorkflowDecision =
  | { admitted: true; lease: WorkflowAdmission }
  | {
      admitted: false;
      reason: WorkflowDenial;
      rootId: string;
      /** Which spend scope refused, when the denial came from the token ledger. */
      spendScope?: SpendScope;
    };

/**
 * Token reservation attached to an admission. `outputCeilingTokens` is the ENFORCEABLE
 * ceiling -- the caller's max_output_tokens or the model's documented cap, never an
 * optimistic estimate and never shrunk by a cache-hit expectation. Omitting `spend`
 * entirely keeps the historical count-only admission, which is also what an unconfigured
 * install gets: token accounting is observed by default and refuses nothing until an
 * operator sets real limits.
 */
export interface WorkflowSpendRequest {
  /** Stable id of the physical send; settlement is idempotent on this key. */
  readonly sendId: string;
  readonly identityId?: string;
  readonly poolId?: string;
  readonly inputTokens: number;
  readonly outputCeilingTokens: number;
}

interface WorkflowState {
  active: number;
  sends: number;
  children: Set<string>;
  lastSeenMs: number;
}

const roots = new Map<string, WorkflowState>();

/**
 * Evict the oldest root that is safe to forget, and report whether one was found.
 *
 * The return value is the point. An earlier version returned void and the caller inserted
 * the new root regardless, so `maxTrackedRoots` bounded nothing whenever every candidate
 * was active or exhausted -- which is precisely the fan-out this file exists to bound.
 */
function evictOneRoot(policy: WorkflowBudgetPolicy, spendLedger?: SpendReservationLedger): boolean {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, state] of roots) {
    // An active root is never evicted: dropping it would hand its fan-out a fresh allowance,
    // which is the exact laundering this ledger exists to prevent. The same holds for an
    // EXHAUSTED-but-idle root -- count-exhausted or spend-exhausted -- because recreating it
    // fresh under the same id resets the very ceiling that already fired.
    if (state.active > 0) continue;
    if (state.sends >= policy.maxPhysicalSends) continue;
    if (spendLedger?.exhausted("root", key) === true) continue;
    if (state.lastSeenMs < oldestAt) { oldestAt = state.lastSeenMs; oldestKey = key; }
  }
  if (oldestKey === undefined) return false;
  roots.delete(oldestKey);
  return true;
}

/**
 * Admit one turn under a root workflow.
 *
 * `childId` distinguishes the members of a fan-out; omit it for the root's own turns.
 * An interactive lane may use the reserved slots a worker lane may not.
 *
 * When `spend` is given, admission also reserves its tokens on the spend ledger -- at the
 * root, identity and pool scopes at once -- before a concurrency slot is taken. A turn
 * released without settlement is resolved by whether it was ever DISPATCHED: an undispatched
 * turn gives its tokens back, and a dispatched one keeps them as unresolved spend, because a
 * send whose usage never arrived may still have been billed. Call `lease.markDispatched()`
 * at the point the request leaves for upstream; without it, admission followed by a local
 * validation or routing failure would book spend that never happened.
 */
export function admitWorkflowTurn(
  rootId: string | undefined,
  lane: WorkflowLane,
  policy: WorkflowBudgetPolicy = DEFAULT_WORKFLOW_BUDGET_POLICY,
  childId?: string,
  now: number = Date.now(),
  spend?: WorkflowSpendRequest,
  spendLedger?: SpendReservationLedger,
): WorkflowDecision | undefined {
  if (!rootId) return undefined;
  // An explicit ledger is consulted even without a spend request, so root eviction can
  // still see spend-exhausted entries. With neither, no token tracking is in play.
  const ledger = spendLedger ?? (spend ? sharedSpendLedger() : undefined);
  let state = roots.get(rootId);
  if (!state) {
    if (roots.size >= policy.maxTrackedRoots && !evictOneRoot(policy, ledger)) {
      // Nothing may be forgotten, so the new root is refused instead of admitted over the
      // bound. The alternative -- evicting an exhausted root -- resets the ceiling that
      // already fired, and a caller minting fresh ids would get unlimited budget from it.
      return { admitted: false, reason: "workflow-tracking-exhausted", rootId };
    }
    state = { active: 0, sends: 0, children: new Set(), lastSeenMs: now };
    roots.set(rootId, state);
  }
  state.lastSeenMs = now;

  if (state.sends >= policy.maxPhysicalSends) {
    return { admitted: false, reason: "workflow-sends-exhausted", rootId };
  }
  if (childId !== undefined && !state.children.has(childId)
    && state.children.size >= policy.maxDistinctChildren) {
    return { admitted: false, reason: "workflow-children-exhausted", rootId };
  }
  const ceiling = lane === "worker"
    ? Math.max(0, policy.maxConcurrentChildren - policy.interactiveReserve)
    : policy.maxConcurrentChildren;
  if (state.active >= ceiling) {
    return { admitted: false, reason: "workflow-concurrency-exhausted", rootId };
  }

  if (spend && ledger) {
    const decision = ledger.reserve({
      sendId: spend.sendId,
      scopes: { rootId, identityId: spend.identityId, poolId: spend.poolId },
      inputTokens: spend.inputTokens,
      outputCeilingTokens: spend.outputCeilingTokens,
      at: now,
    });
    if (!decision.reserved) {
      const denial = decision.denial;
      // Every ledger refusal denies a DISPATCH. A duplicate send id and an undurable
      // reservation are reported as themselves rather than folded into "exhausted", because
      // an operator reading a 429 needs to know which of the three happened.
      const reason: WorkflowDenial = denial.reason === "duplicate-send-id"
        ? "workflow-send-replayed"
        : denial.reason === "reserve-not-durable" || denial.reason === "journal-corrupt"
          ? "workflow-spend-undurable"
          : denial.reason === "tracking-capacity-exhausted"
            ? "workflow-tracking-exhausted"
            : "workflow-spend-exhausted";
      return {
        admitted: false,
        reason,
        rootId,
        spendScope: denial.reason === "spend-limit-exceeded" ? denial.scope : undefined,
      };
    }
  }

  state.active += 1;
  if (childId !== undefined) state.children.add(childId);
  let released = false;
  return {
    admitted: true,
    lease: {
      rootId,
      markDispatched(): void {
        if (spend && ledger) ledger.markDispatched(spend.sendId);
      },
      release(): void {
        if (released) return;
        released = true;
        const current = roots.get(rootId);
        if (current) {
          current.active = Math.max(0, current.active - 1);
          current.lastSeenMs = Date.now();
        }
        // Which of the two applies depends on whether the send ever left this process.
        // `abandon` succeeds only while the reservation is undispatched -- a turn refused by
        // local validation or routing releases its tokens and books nothing, because
        // inventing debt the account never incurred breaks the budget in the other
        // direction. Once dispatched, abandon refuses and markLost keeps the cost as
        // unresolved spend, since a send whose usage frame never arrived may still have been
        // billed. Both are no-ops once settleWorkflowSpend already ran.
        if (spend && ledger && !ledger.abandon(spend.sendId)) ledger.markLost(spend.sendId);
      },
    },
  };
}

/**
 * Charge physical sends to a root. Called from the send budget's own accounting so a retry
 * inside one request counts toward the workflow total, not only the request total.
 */
export function chargeWorkflowSends(rootId: string | undefined, sends: number): void {
  if (!rootId || sends <= 0) return;
  const state = roots.get(rootId);
  if (!state) return;
  state.sends += sends;
  state.lastSeenMs = Date.now();
}

/**
 * Settle a send's reservation with the usage the response actually reported. Idempotent
 * per send id -- a second call returns false and books nothing. When the usage frame was
 * lost, call this never and let the lease's release move the reservation to unresolved
 * spend, or call the ledger's markLost directly.
 */
export function settleWorkflowSpend(
  sendId: string,
  usage: SpendUsage,
  spendLedger?: SpendReservationLedger,
): boolean {
  return (spendLedger ?? sharedSpendLedger()).settle(sendId, usage);
}

/**
 * Record that the send left for upstream.
 *
 * This is the line between "may be released for free" and "may have been billed". Admission
 * alone is not dispatch: a turn can be admitted and then fail request validation, provider
 * routing, or a local guard without a single byte reaching a model. Booking those as spend
 * invents debt the account never incurred, so the reservation only becomes unresolvable
 * after this call.
 */
export function dispatchWorkflowSpend(sendId: string, spendLedger?: SpendReservationLedger): boolean {
  return (spendLedger ?? sharedSpendLedger()).markDispatched(sendId);
}

/**
 * Give a reservation back because the send never happened. Refused once dispatched, where
 * settle or markLost is the only honest outcome.
 */
export function abandonWorkflowSpend(sendId: string, spendLedger?: SpendReservationLedger): boolean {
  return (spendLedger ?? sharedSpendLedger()).abandon(sendId);
}

/**
 * Whether this root has already spent its whole physical-send ceiling.
 *
 * Separate from `admitWorkflowTurn` so a caller can refuse before dispatch without taking a
 * concurrency slot it would have to remember to release.
 */
export function workflowSendCeilingReached(
  rootId: string | undefined,
  policy: WorkflowBudgetPolicy = DEFAULT_WORKFLOW_BUDGET_POLICY,
): boolean {
  if (!rootId) return false;
  const state = roots.get(rootId);
  return state !== undefined && state.sends >= policy.maxPhysicalSends;
}

export function workflowBudgetSnapshot(rootId: string): {

  active: number; sends: number; children: number;
} | undefined {
  const state = roots.get(rootId);
  return state ? { active: state.active, sends: state.sends, children: state.children.size } : undefined;
}

/** Test seam. Production never clears a live ledger: that would reset a spent budget. */
export function resetWorkflowBudgetsForTest(): void {
  roots.clear();
}
