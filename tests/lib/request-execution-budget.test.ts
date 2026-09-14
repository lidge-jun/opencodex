import { describe, expect, test } from "bun:test";
import {
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  createRequestExecutionBudget,
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
  test("a second credential hop is refused while total allowance remains", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const initial = budget.reserveDispatch({ sendClass: "initial", targetKey: "acct-1" });
    if (!initial.allowed) throw new Error("unreachable");
    initial.permit.use();

    const firstHop = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "acct-2" });
    expect(firstHop.allowed).toBe(true);
    if (!firstHop.allowed) throw new Error("unreachable");
    firstHop.permit.use();

    // GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST would allow a second and a third hop. The shared
    // budget still has two of four sends left. The effective allowance is the intersection, and
    // the cross-account bounds are what refuse here: one target transition and one alternate
    // send per request, whichever is reached first.
    const secondHop = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "acct-3" });
    expect(secondHop.allowed).toBe(false);
    if (secondHop.allowed) throw new Error("unreachable");
    expect(secondHop.reason).toBe("target-transition-exhausted");
    expect(budget.used).toBe(2);
    expect(budget.used).toBeLessThan(CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTotalModelSends);
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
