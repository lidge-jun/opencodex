import { describe, expect, test } from "bun:test";
import { comboExecutionBudgetPolicy, comboTargetSendBudget, deriveSendBudgetScope } from "../../src/server/responses/combo-send-budget";
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

describe("combo scopes share reservation accounting", () => {
  test("a child sees the last send reserved by its parent before dispatch", () => {
    const parent = createRequestExecutionBudget(ONE_SEND_LEFT);
    const child = deriveSendBudgetScope(parent, ONE_SEND_LEFT);
    const reserved = parent.reserveDispatch({ sendClass: "initial", targetKey: "parent" });
    expect(reserved.allowed).toBe(true);
    expect(child.remainingBaseSends(5)).toBe(0);
    expect(child.reserveDispatch({ sendClass: "initial", targetKey: "child" }).allowed).toBe(false);
  });

  test("child release refunds the shared booking and external reports settle it once", () => {
    const parent = createRequestExecutionBudget();
    const child = deriveSendBudgetScope(parent, parent.policy);
    const first = child.reserveDispatch({ sendClass: "initial", targetKey: "child", countedExternally: true });
    if (!first.allowed) throw new Error("expected first permit");
    expect(parent.used).toBe(1);
    first.permit.release();
    expect(parent.used).toBe(0);
    const sent = child.reserveDispatch({ sendClass: "initial", targetKey: "child", countedExternally: true });
    if (!sent.allowed) throw new Error("expected second permit");
    parent.used += 1;
    expect(child.used).toBe(1);
    sent.permit.release();
    expect(parent.used).toBe(1);
    child.used += 1;
    expect(parent.used).toBe(2);
  });

  test("three failed targets cannot each refill the request-wide ladder", () => {
    const parent = createRequestExecutionBudget();
    const combo = deriveSendBudgetScope(parent, comboExecutionBudgetPolicy(3));
    let sends = 0;
    const byTarget: number[] = [];
    for (let target = 0; target < 3; target++) {
      const scope = comboTargetSendBudget(combo, 2 - target);
      const before = sends;
      for (let attempt = 0; attempt < 8; attempt++) {
        const decision = scope.reserveDispatch({ sendClass: attempt === 0 ? "initial" : "auth-recovery", targetKey: `target-${target}` });
        if (!decision.allowed) break;
        expect(decision.permit.use()).toBe(true);
        sends++;
      }
      byTarget.push(sends - before);
    }
    expect(byTarget).toEqual([4, 1, 1]);
    expect(sends).toBe(combo.policy.maxTotalModelSends);
    expect(parent.used).toBe(sends);
    expect(combo.remainingBaseSends(100)).toBe(0);
  });

  test("target transition ledgers remain local to each scope", () => {
    const parent = createRequestExecutionBudget(comboExecutionBudgetPolicy(4));
    for (const name of ["a", "b"]) {
      const child = deriveSendBudgetScope(parent, parent.policy);
      for (const key of [name, `${name}-alternate`]) {
        const decision = child.reserveDispatch({ sendClass: "auth-recovery", targetKey: key });
        expect(decision.allowed).toBe(true);
        if (decision.allowed) decision.permit.use();
      }
      expect(child.targetTransitions).toBe(1);
    }
    expect(parent.targetTransitions).toBe(0);
    expect(parent.used).toBe(4);
  });

  test("two external reporters cannot adopt the same prepaid hop", () => {
    const parent = createRequestExecutionBudget(ONE_SEND_LEFT);
    const hop = parent.reserveDispatch({ sendClass: "initial", targetKey: "combo", countedExternally: true });
    if (!hop.allowed) throw new Error("expected hop");
    hop.permit.use();
    const first = deriveSendBudgetScope(parent, ONE_SEND_LEFT, hop.permit);
    const second = deriveSendBudgetScope(parent, ONE_SEND_LEFT, hop.permit);
    expect(first.reserveDispatch({ sendClass: "transient", targetKey: "a", countedExternally: true }).allowed).toBe(true);
    expect(second.reserveDispatch({ sendClass: "transient", targetKey: "b", countedExternally: true }).allowed).toBe(false);
    parent.used += 1;
    expect(parent.used).toBe(1);
  });

  test("an adapter adopts its exact prepaid hop once and can return it before dispatch", () => {
    const parent = createRequestExecutionBudget(ONE_SEND_LEFT);
    const hop = parent.reserveDispatch({ sendClass: "initial", targetKey: "combo", countedExternally: true });
    if (!hop.allowed) throw new Error("expected hop");
    hop.permit.use();
    const child = deriveSendBudgetScope(parent, ONE_SEND_LEFT, hop.permit);
    expect(child.remainingBaseSends(3)).toBe(1);
    const first = child.reserveDispatch({ sendClass: "initial", targetKey: "adapter" });
    if (!first.allowed) throw new Error("expected prepaid initial send");
    expect(parent.used).toBe(1);
    first.permit.release();
    expect(child.remainingBaseSends(3)).toBe(1);
    const retry = child.reserveDispatch({ sendClass: "initial", targetKey: "adapter" });
    if (!retry.allowed) throw new Error("expected returned booking");
    expect(retry.permit.use()).toBe(true);
    expect(parent.used).toBe(1);
    expect(child.reserveDispatch({ sendClass: "transient", targetKey: "adapter" }).allowed).toBe(false);
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
