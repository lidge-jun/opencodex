import { describe, expect, test } from "bun:test";
import {
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  createRequestExecutionBudget,
  deriveRequestExecutionBudget,
  type RequestExecutionBudgetPolicy,
} from "../../src/lib/request-execution-budget";

/**
 * The permit is the charge (#4546).
 *
 * `reserveDispatch` used to decide and `permit.use()` used to charge, which made the decision
 * advisory: two legs that read the same remainder in the same turn -- an account move and a
 * rebuild, a combo child and its parent -- both received a permit and both dispatched. One
 * remaining send admitted two physical sends, which is the per-request multiplication the whole
 * budget exists to stop. These pin the three properties the fix depends on: the second racer is
 * refused, an abandoned reservation is refunded exactly, and a send counted by a retry helper is
 * charged once rather than twice.
 */
const ONE_SEND_LEFT: RequestExecutionBudgetPolicy = {
  maxTotalModelSends: 1,
  baseSendAllowance: 1,
  finalRecoveryAllowance: 0,
  maxAlternateTargetSends: 1,
  maxTargetTransitions: 1,
};

describe("atomic dispatch permits", () => {
  test("two interleaved reserves for one remaining send produce exactly one permit", () => {
    const budget = createRequestExecutionBudget(ONE_SEND_LEFT);
    // Both legs reserve before either dispatches. This is the ordering that used to pass twice.
    const first = budget.reserveDispatch({ sendClass: "initial", targetKey: "t" });
    const second = budget.reserveDispatch({ sendClass: "transient", targetKey: "t" });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    if (second.allowed) throw new Error("unreachable");
    expect(second.reason).toBe("total-exhausted");
    // The reservation itself spent the send, before anything confirmed it.
    expect(budget.used).toBe(1);
    expect(budget.remainingBaseSends(5)).toBe(0);

    if (!first.allowed) throw new Error("unreachable");
    expect(first.permit.use()).toBe(true);
    // Confirmation charges nothing more, and a second confirmation is refused rather than
    // buying the retry thunk another send.
    expect(first.permit.use()).toBe(false);
    expect(budget.used).toBe(1);
  });

  test("release restores the remainder exactly, including the single shared reserve", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    for (let i = 0; i < CODEX_TEXT_GUARDED_BUDGET_POLICY.baseSendAllowance; i++) {
      const send = budget.reserveDispatch({ sendClass: "transient", targetKey: "a" });
      expect(send.allowed).toBe(true);
      if (send.allowed) send.permit.use();
    }
    expect(budget.used).toBe(3);

    // The fourth send: an account move funded by the final-recovery reserve.
    const move = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "b" });
    expect(move.allowed).toBe(true);
    if (!move.allowed) throw new Error("unreachable");
    expect(budget.used).toBe(4);
    expect(budget.reserveSpent).toBe(true);
    expect(budget.alternateTargetSends).toBe(1);
    expect(budget.targetTransitions).toBe(1);
    expect(budget.lastTargetKey).toBe("b");

    // The resolver found no alternate account, so the move never became a send.
    move.permit.release();
    expect(budget.used).toBe(3);
    expect(budget.reserveSpent).toBe(false);
    expect(budget.alternateTargetSends).toBe(0);
    expect(budget.targetTransitions).toBe(0);
    expect(budget.lastTargetKey).toBe("a");

    // Exactly restored: the request can still make its one final-recovery send elsewhere.
    const rebuild = budget.reserveDispatch({ sendClass: "repair", targetKey: "a" });
    expect(rebuild.allowed).toBe(true);
    expect(budget.used).toBe(4);

    // A released permit is inert afterwards, and releasing twice cannot refund twice.
    move.permit.release();
    expect(move.permit.use()).toBe(false);
    expect(budget.used).toBe(4);
  });

  test("a countedExternally permit plus its external report charges exactly one send", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const leg = budget.reserveDispatch({
      sendClass: "auth-recovery",
      targetKey: "t",
      countedExternally: true,
    });
    expect(leg.allowed).toBe(true);
    if (!leg.allowed) throw new Error("unreachable");
    // Booked immediately -- a concurrent leg must see this send as spent even though the retry
    // helper has not reported it yet.
    expect(budget.used).toBe(1);

    expect(leg.permit.use()).toBe(true);
    // `onSendsConsumed` reporting one physical send settles the pending booking instead of
    // charging a second time. Charging both is how a four-send cap became a two-send cap.
    budget.used += 1;
    expect(budget.used).toBe(1);

    // Sends the helper made beyond the reserved one are still charged in full.
    budget.used += 2;
    expect(budget.used).toBe(3);
  });

  test("an external report settles the booking, so a late release refunds nothing", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const leg = budget.reserveDispatch({
      sendClass: "auth-recovery",
      targetKey: "t",
      countedExternally: true,
    });
    if (!leg.allowed) throw new Error("unreachable");
    budget.used += 1;
    expect(budget.used).toBe(1);
    // The send physically happened. A refund here would hand the request a free one back.
    leg.permit.release();
    expect(budget.used).toBe(1);
  });
});

describe("layer caps intersect the shared budget", () => {
  test("a roster credential hop walks within the shared total; a cross-pool move does not", () => {
    // The two classes answer different questions and must not be conflated. A credential
    // rotation inside ONE provider's roster is "auth-recovery": its own roster cap decides how
    // far it walks, and the shared total decides how many sends the request may make. A move
    // between pools is "account-failover", which is bounded to a single alternate target so a
    // request cannot shop the whole estate.
    // Production reserves every roster hop under ONE key per hop site -- provider|model|site --
    // because a CHANGED target key is an alternate target whatever the send class says. Using a
    // per-account key here would have tested a shape the code never produces.
    const ROSTER_KEY = "openai|gpt-5.6|sidecar-oauth-429";
    const roster = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const initial = roster.reserveDispatch({ sendClass: "initial", targetKey: ROSTER_KEY });
    if (!initial.allowed) throw new Error("unreachable");
    initial.permit.use();

    const firstHop = roster.reserveDispatch({ sendClass: "auth-recovery", targetKey: ROSTER_KEY });
    expect(firstHop.allowed).toBe(true);
    if (!firstHop.allowed) throw new Error("unreachable");
    firstHop.permit.use();

    // The second hop is what a roster of three 429'd accounts needs. Classifying it as a
    // cross-account move would refuse it here and strand a free third account.
    const secondHop = roster.reserveDispatch({ sendClass: "auth-recovery", targetKey: ROSTER_KEY });
    expect(secondHop.allowed).toBe(true);
    if (!secondHop.allowed) throw new Error("unreachable");
    secondHop.permit.use();
    expect(roster.used).toBe(3);

    // The shared total is the real bound: the fourth send is the reserve, and a fifth is gone.
    const fourth = roster.reserveDispatch({ sendClass: "auth-recovery", targetKey: ROSTER_KEY });
    expect(fourth.allowed).toBe(true);
    if (!fourth.allowed) throw new Error("unreachable");
    fourth.permit.use();
    const fifth = roster.reserveDispatch({ sendClass: "auth-recovery", targetKey: ROSTER_KEY });
    expect(fifth.allowed).toBe(false);
    expect(roster.used).toBe(CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTotalModelSends);

    // A genuine cross-pool move keeps its one-transition bound with total allowance to spare.
    const pool = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const first = pool.reserveDispatch({ sendClass: "initial", targetKey: "pool-a" });
    if (!first.allowed) throw new Error("unreachable");
    first.permit.use();
    const move = pool.reserveDispatch({ sendClass: "account-failover", targetKey: "pool-b" });
    expect(move.allowed).toBe(true);
    if (!move.allowed) throw new Error("unreachable");
    move.permit.use();
    const secondMove = pool.reserveDispatch({ sendClass: "account-failover", targetKey: "pool-c" });
    expect(secondMove.allowed).toBe(false);
    if (secondMove.allowed) throw new Error("unreachable");
    expect(secondMove.reason).toBe("target-transition-exhausted");
    expect(pool.used).toBe(2);
    expect(pool.used).toBeLessThan(CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTotalModelSends);
  });

  test("a same-target replay stops at the base allowance instead of taking the reserve", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    for (let i = 0; i < 3; i++) {
      const rung = budget.reserveDispatch({ sendClass: "transient", targetKey: "same" });
      expect(rung.allowed).toBe(true);
      if (rung.allowed) rung.permit.use();
    }
    // The gated-model 400 ladder is same-account, same-target: it is an ordinary transient send
    // and may not reach for the reserve an account move or a validated rebuild is funded from.
    const fourth = budget.reserveDispatch({ sendClass: "transient", targetKey: "same" });
    expect(fourth.allowed).toBe(false);
    if (fourth.allowed) throw new Error("unreachable");
    expect(fourth.reason).toBe("base-allowance-exhausted");
    expect(budget.reserveSpent).toBe(false);
  });
});

/**
 * A credential hop reserves before it knows whether account resolution, request rebuilding, or
 * admission will reach the wire. The reservation is a real charge immediately, so every exit
 * before dispatch must release it. Once bytes leave, the same permit must become non-refundable.
 *
 * These cases assert the permit state and spend observer directly. They fail on the historical
 * accounting defect without depending on a particular server function name or catch-block shape.
 */
describe("dispatch permits distinguish pre-send failures from physical sends", () => {
  const recordingObserver = () => {
    const events: string[] = [];
    return {
      events,
      observer: {
        charge: () => { events.push("charge"); return true; },
        refund: () => { events.push("refund"); },
      },
    };
  };

  test("a reservation released after a pre-dispatch failure books no spend", () => {
    const spy = recordingObserver();
    const budget = createRequestExecutionBudget(ONE_SEND_LEFT, "lr-pre-dispatch", spy.observer);
    const hop = budget.reserveDispatch({
      sendClass: "auth-recovery",
      targetKey: "provider|model",
      countedExternally: true,
    });
    if (!hop.allowed) throw new Error("unreachable");

    let physicalSends = 0;
    try {
      throw new Error("credential application failed");
    } catch {
      hop.permit.release();
    }

    expect(physicalSends).toBe(0);
    expect(budget.used).toBe(0);
    expect(spy.events).toEqual(["charge", "refund"]);
    expect(hop.permit.use()).toBe(false);
    expect(budget.reserveDispatch({ sendClass: "auth-recovery", targetKey: "provider|model" }).allowed)
      .toBe(true);
  });

  test("a reservation confirmed at dispatch stays charged after a later failure", () => {
    const spy = recordingObserver();
    const budget = createRequestExecutionBudget(ONE_SEND_LEFT, "lr-post-dispatch", spy.observer);
    const hop = budget.reserveDispatch({
      sendClass: "auth-recovery",
      targetKey: "provider|model",
    });
    if (!hop.allowed) throw new Error("unreachable");

    let physicalSends = 0;
    try {
      physicalSends += 1;
      expect(hop.permit.use()).toBe(true);
      throw new Error("upstream rejected after dispatch");
    } catch {
      hop.permit.release();
    }

    expect(physicalSends).toBe(1);
    expect(budget.used).toBe(1);
    expect(spy.events).toEqual(["charge"]);
    expect(budget.reserveDispatch({ sendClass: "transient", targetKey: "provider|model" }))
      .toEqual({ allowed: false, reason: "total-exhausted" });
  });
});

/**
 * One physical send, one charge -- whichever layer actually dispatches it (#4709).
 *
 * A credential hop books the replay it is about to make, and the reservation IS the charge. The
 * layer that then sends that replay has its own accounting: the retry helper reports every
 * physical send back through `onSendsConsumed`, while Kiro and Cursor reserve once per send
 * against the same budget. Either one charged the hop's replay a SECOND time, so a four-send
 * ceiling admitted two sends -- and once the allowance was gone the request answered with a
 * synthetic error instead of the 429 the hop was recovering from.
 *
 * `countedExternally` already covered the reporter. `assumeCharge()` is the other half: the
 * dispatching layer takes the booking over, so the send stays charged exactly once and no later
 * report settles against a send that was already paid for.
 */
describe("a credential hop is settled by whichever layer dispatches its replay", () => {
  test("a retry helper's report settles the booking instead of charging again", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const hop = budget.reserveDispatch({
      sendClass: "auth-recovery", targetKey: "p|m", countedExternally: true,
    });
    expect(hop.allowed).toBe(true);
    expect(budget.used).toBe(1);

    // The helper names the same physical send the hop already booked.
    budget.used += 1;
    expect(budget.used).toBe(1);
    // A genuinely second send is charged in full.
    budget.used += 1;
    expect(budget.used).toBe(2);
  });

  test("an adapter that reserves for itself takes the booking over rather than adding to it", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const hop = budget.reserveDispatch({
      sendClass: "auth-recovery", targetKey: "p|m", countedExternally: true,
    });
    if (!hop.allowed) throw new Error("unreachable");
    expect(budget.used).toBe(1);

    // No reporter will ever name this send: the adapter's own ladder is dispatching it.
    expect(hop.permit.assumeCharge()).toBe(true);
    expect(budget.used).toBe(1);
    // The booking is closed, so the next leg's report is charged in full. Leaving it open is
    // how one real send would have gone uncounted.
    budget.used += 1;
    expect(budget.used).toBe(2);

    // One reservation still admits exactly one send, and a settled permit cannot be refunded.
    expect(hop.permit.assumeCharge()).toBe(false);
    expect(hop.permit.use()).toBe(false);
    hop.permit.release();
    expect(budget.used).toBe(2);
  });

});

describe("derived policy scopes", () => {
  const wide: RequestExecutionBudgetPolicy = {
    maxTotalModelSends: 8, baseSendAllowance: 7, finalRecoveryAllowance: 1,
    maxAlternateTargetSends: 7, maxTargetTransitions: 7,
  };

  test("a derived scope admits against what the REQUEST has spent, not its own history", () => {
    // The defect this closes. Aliasing the public `used` property shared only what callers read
    // from outside; `remainingBaseSends`, the total check and the reserve test all consulted the
    // factory's own private counter, so each derived scope believed the request had spent
    // nothing and a per-target holdback had nothing to hold back from.
    const parent = createRequestExecutionBudget(wide);
    const first = deriveRequestExecutionBudget(parent, { ...wide, maxTotalModelSends: 2 });
    expect(first.reserveDispatch({ sendClass: "initial", targetKey: "a/m" }).allowed).toBe(true);
    expect(first.reserveDispatch({ sendClass: "transient", targetKey: "a/m" }).allowed).toBe(true);
    expect(parent.used).toBe(2);

    const second = deriveRequestExecutionBudget(parent, { ...wide, maxTotalModelSends: 2 });
    expect(second.used).toBe(2);
    expect(second.remainingBaseSends(99)).toBe(5);
    expect(second.reserveDispatch({ sendClass: "combo-failover", targetKey: "b/m" }))
      .toEqual({ allowed: false, reason: "total-exhausted" });
  });

  test("recovery ledgers stay per-scope while the send ledger is shared", () => {
    // A later target's account failover is its own recovery decision; only the physical-send
    // total binds the targets together.
    const parent = createRequestExecutionBudget(wide);
    const a = deriveRequestExecutionBudget(parent, { ...wide, maxAlternateTargetSends: 1, maxTargetTransitions: 1 });
    const b = deriveRequestExecutionBudget(parent, { ...wide, maxAlternateTargetSends: 1, maxTargetTransitions: 1 });
    expect(a.reserveDispatch({ sendClass: "account-failover", targetKey: "a/m" }).allowed).toBe(true);
    expect(a.alternateTargetSends).toBe(1);
    expect(b.alternateTargetSends).toBe(0);
    expect(b.reserveDispatch({ sendClass: "account-failover", targetKey: "b/m" }).allowed).toBe(true);
    expect(parent.used).toBe(2);
  });

  test("a pending external booking travels with the shared ledger", () => {
    // A pending booking is a send already counted in the total and waiting for its reporter, so
    // sharing the spend without it would charge that send twice.
    const parent = createRequestExecutionBudget(wide);
    const scope = deriveRequestExecutionBudget(parent, wide);
    const hop = scope.reserveDispatch({ sendClass: "initial", targetKey: "a/m", countedExternally: true });
    expect(hop.allowed).toBe(true);
    expect(parent.used).toBe(1);

    const target = deriveRequestExecutionBudget(scope, wide);
    // The reporter names the send that the booking above already paid for.
    target.used += 1;
    expect(parent.used).toBe(1);
    // Anything beyond it is a genuinely new send.
    target.used += 2;
    expect(parent.used).toBe(3);
  });

  test("assumeCharge on a derived scope closes the booking on the shared ledger", () => {
    // bl1's adapter handoff and this shared ledger have to agree: an adapter that takes over a
    // counted-externally reservation must close the booking the whole request can see, or the
    // next report would settle against it and one real send would go uncharged.
    const parent = createRequestExecutionBudget(wide);
    const scope = deriveRequestExecutionBudget(parent, wide);
    const hop = scope.reserveDispatch({ sendClass: "auth-recovery", targetKey: "a/m", countedExternally: true });
    expect(hop.allowed).toBe(true);
    expect(hop.allowed && hop.permit.assumeCharge()).toBe(true);
    expect(parent.used).toBe(1);
    parent.used += 1;
    expect(parent.used).toBe(2);
  });

  test("a scope derived from a foreign budget bridges instead of throwing", () => {
    // `isRequestExecutionBudget` is a shape test, so a stub can reach the derivation. Turning
    // that into a thrown error would convert a routing request into a 500 to report a condition
    // production never produces.
    let used = 4;
    const foreign = {
      get used() { return used; },
      set used(next: number) { used = next; },
      logicalRequestId: "foreign",
      policyVersion: "guarded-v1",
      policy: wide,
      reserveSpent: false,
      alternateTargetSends: 0,
      targetTransitions: 0,
      lastTargetKey: undefined,
      remainingBaseSends: () => 0,
      reserveDispatch: () => ({ allowed: false, reason: "total-exhausted" }),
    } as unknown as Parameters<typeof deriveRequestExecutionBudget>[0];
    const scope = deriveRequestExecutionBudget(foreign, wide);
    expect(scope.used).toBe(4);
    expect(scope.reserveDispatch({ sendClass: "initial", targetKey: "a/m" }).allowed).toBe(true);
    expect(used).toBe(5);
  });
});

describe("derived scopes and the durable spend observer", () => {
  const wide: RequestExecutionBudgetPolicy = {
    maxTotalModelSends: 8, baseSendAllowance: 7, finalRecoveryAllowance: 1,
    maxAlternateTargetSends: 7, maxTargetTransitions: 7,
  };
  const recordingObserver = () => {
    const events: string[] = [];
    let allow = true;
    return {
      events,
      deny: () => { allow = false; },
      observer: {
        charge: () => { events.push(allow ? "charge" : "refused"); return allow; },
        refund: () => { events.push("refund"); },
      },
    };
  };

  test("a derived scope books its sends on the parent's ledger", () => {
    // The observer books by watching the send counter move. A derived scope that spent the
    // shared counter without carrying the observer would move it without booking, and every
    // combo child send would be missing from the durable ledger.
    const spy = recordingObserver();
    const parent = createRequestExecutionBudget(wide, "lr-observer", spy.observer);
    const scope = deriveRequestExecutionBudget(parent, wide);
    expect(scope.reserveDispatch({ sendClass: "combo-failover", targetKey: "b/m" }).allowed).toBe(true);
    expect(spy.events).toEqual(["charge"]);
    expect(parent.used).toBe(1);
  });

  test("one physical send is booked exactly once across the derivation", () => {
    // A combo hop reserves with countedExternally and the child reports the same send. The
    // pending booking settles that report, so the ledger must see one entry, not two.
    const spy = recordingObserver();
    const parent = createRequestExecutionBudget(wide, "lr-once", spy.observer);
    const scope = deriveRequestExecutionBudget(parent, wide);
    expect(scope.reserveDispatch({ sendClass: "initial", targetKey: "a/m", countedExternally: true }).allowed).toBe(true);
    deriveRequestExecutionBudget(scope, wide).used += 1;
    expect(spy.events).toEqual(["charge"]);
    expect(parent.used).toBe(1);
  });

  test("a released derivation refunds on the parent's ledger", () => {
    const spy = recordingObserver();
    const parent = createRequestExecutionBudget(wide, "lr-refund", spy.observer);
    const scope = deriveRequestExecutionBudget(parent, wide);
    const leg = scope.reserveDispatch({ sendClass: "auth-recovery", targetKey: "a/m" });
    expect(leg.allowed).toBe(true);
    if (leg.allowed) leg.permit.release();
    expect(spy.events).toEqual(["charge", "refund"]);
    expect(parent.used).toBe(0);
  });

  test("a ledger ceiling refuses a derived dispatch rather than describing it afterwards", () => {
    const spy = recordingObserver();
    const parent = createRequestExecutionBudget(wide, "lr-ceiling", spy.observer);
    const scope = deriveRequestExecutionBudget(parent, wide);
    spy.deny();
    expect(scope.reserveDispatch({ sendClass: "combo-failover", targetKey: "b/m" }))
      .toEqual({ allowed: false, reason: "spend-exhausted" });
    expect(parent.used).toBe(0);
  });
});

describe("the ambiguous-resend allowance", () => {
  test("one logical request holds one grant, and a derived scope shares it", () => {
    // The reason the grant lives here rather than beside the policy that issues it: a combo
    // child derives its own budget, and two grants would let one turn replace an
    // unknown-state send twice -- once on the parent leg, once on the child's.
    const parent = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const child = deriveRequestExecutionBudget(parent, CODEX_TEXT_GUARDED_BUDGET_POLICY);

    expect(parent.claimAmbiguousResend?.(1)).toBe(true);
    expect(child.claimAmbiguousResend?.(1)).toBe(false);
    expect(parent.claimAmbiguousResend?.(1)).toBe(false);
    // A later leg cannot raise the ceiling, either. Each leg reads its number from the
    // provider row it is running against, and that row is reassigned mid-request by rotation,
    // refresh, transport resolution and each combo target -- so releasing the difference meant
    // the count of duplicate inferences depended on which row happened to ask last. The
    // request keeps the smallest ceiling any leg presented.
    expect(child.claimAmbiguousResend?.(2)).toBe(false);
    expect(parent.claimAmbiguousResend?.(2)).toBe(false);
  });

  test("a grant is not a send, and a spent send budget is not a spent grant", () => {
    const budget = createRequestExecutionBudget(ONE_SEND_LEFT);
    expect(budget.reserveDispatch({ sendClass: "initial", targetKey: "t" }).allowed).toBe(true);
    expect(budget.remainingBaseSends(5)).toBe(0);
    // The grant survives, because it authorises nothing by itself: the send it would fund
    // still has to fit in the allowance, which is the caller's check.
    expect(budget.claimAmbiguousResend?.(1)).toBe(true);
    expect(budget.used).toBe(1);
  });

  test("a ceiling of zero or a nonsense ceiling grants nothing", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    expect(budget.claimAmbiguousResend?.(0)).toBe(false);
    expect(budget.claimAmbiguousResend?.(Number.NaN)).toBe(false);
    expect(budget.claimAmbiguousResend?.(Number.POSITIVE_INFINITY)).toBe(false);
    expect(budget.claimAmbiguousResend?.(1)).toBe(true);
  });
});
