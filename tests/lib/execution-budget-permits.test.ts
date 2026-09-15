import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("derived scopes share physical sends and counted-externally settlement", () => {
    const parent = createRequestExecutionBudget({
      maxTotalModelSends: 8, baseSendAllowance: 7, finalRecoveryAllowance: 1,
      maxAlternateTargetSends: 7, maxTargetTransitions: 7,
    });
    const combo = deriveRequestExecutionBudget(parent, {
      maxTotalModelSends: 8, baseSendAllowance: 7, finalRecoveryAllowance: 1,
      maxAlternateTargetSends: 7, maxTargetTransitions: 7,
    });
    const target = deriveRequestExecutionBudget(combo, {
      maxTotalModelSends: 8, baseSendAllowance: 7, finalRecoveryAllowance: 1,
      maxAlternateTargetSends: 1, maxTargetTransitions: 1,
    });
    const hop = combo.reserveDispatch({ sendClass: "initial", targetKey: "provider-a/model-a", countedExternally: true });
    expect(hop.allowed).toBe(true);
    expect(parent.used).toBe(1);
    expect(target.used).toBe(1);
    target.used += 1;
    expect(parent.used).toBe(1);
    target.used += 2;
    expect(parent.used).toBe(3);
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
 * The refund property above is only worth something if every caller actually uses it.
 *
 * The generic-OAuth 429 ladder reserves a hop before it knows whether a rotation is possible.
 * Two of its three exits released correctly and the `catch` did not, so a throw from the
 * snapshot fetch or from credential application charged the request for a send that never left
 * the process — and a later recovery in the same request was then refused on an allowance
 * nothing had spent. The passthrough and runTurn ladders already had it right; these two did not.
 *
 * This is a source oracle because the defect lives in the caller's control flow, not in the
 * budget: a unit test of the budget cannot see a caller that forgets to hand the permit back.
 */
describe("generic-OAuth hop reservations are handed back when no send happens", () => {
  // Bounded to each ladder's own span and matched on the catch that opens it. An earlier version
  // of this test searched from the first following "catch {" and found the inline body-cancel
  // catch instead, so it passed while the defect was still present.
  const ladder = (relativePath: string, fromMarker: string, toMarker: string): string => {
    const source = readFileSync(new URL("../../" + relativePath, import.meta.url), "utf8");
    const from = source.indexOf(fromMarker);
    const to = source.indexOf(toMarker, from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
  };
  const refundsOnThrow = /catch \{[^}]*hop\.permit\?\.release\(\)/;

  test("the adapter dispatch ladder confirms at the dispatch boundary and refunds otherwise", () => {
    const source = readFileSync(new URL("../../src/server/responses/adapter-dispatch.ts", import.meta.url), "utf8");
    // Confirming before the rebuild is not enough: buildRequest failures return { failed }
    // without reaching the wire, so the hop is confirmed by the callback the rebuild invokes at
    // its dispatch boundary, and the { failed } arm refunds whatever that callback did not spend.
    expect(source).toContain("onDispatch?.()");
    // Confirmed at the wire, not before the pacer: waitForProviderRequestSlot can reject for an
    // abort, a saturated queue, an expired slot or a removed provider without ever calling the
    // adapter, and release() is a no-op once used, so an early confirm could never be refunded.
    const slotWait = source.indexOf("await waitForProviderRequestSlot(");
    const confirmAfterWait = source.indexOf("onDispatch?.()", slotWait);
    const adapterSend = source.indexOf("transportState.activeAdapter.fetchResponse(retryRequest", confirmAfterWait);
    expect(slotWait).toBeGreaterThan(-1);
    expect(confirmAfterWait).toBeGreaterThan(slotWait);
    expect(adapterSend).toBeGreaterThan(confirmAfterWait);
    // The helper path has the same boundary inside the thunk that reaches the wire.
    const thunkConfirm = source.indexOf("onDispatch?.()", adapterSend);
    const headerTimeout = source.indexOf("fetchWithHeaderTimeout(retryRequest.url", thunkConfirm);
    expect(thunkConfirm).toBeGreaterThan(adapterSend);
    expect(headerTimeout).toBeGreaterThan(thunkConfirm);
    const block = ladder(
      "src/server/responses/adapter-dispatch.ts",
      "adapter-recovery-oauth-429",
      "attemptOpaqueBlobRecovery",
    );
    expect(block).toContain('rebuildAndRefetch("oauth-account-429", () => { hop.permit?.use(); })');
    expect(block).toMatch(/if \("failed" in result\) \{[^}]*hop\.permit\?\.release\(\)/);
    expect(block).toMatch(refundsOnThrow);
  });

  test("the continuation ladder refunds, because its send happens after the loop continues", () => {
    const block = ladder(
      "src/server/responses/adapter-continuation.ts",
      "continuation-oauth-429",
      "shouldAttemptImageTierRetry",
    );
    // Nothing in that try dispatches: the replay is the next iteration, so a throw must return
    // the reservation rather than confirm it.
    expect(block).not.toContain("hop.permit?.use()");
    expect(block).toMatch(refundsOnThrow);
  });
});
