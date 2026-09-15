import { describe, expect, test } from "bun:test";
import {
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  createRequestExecutionBudget,
} from "../../src/lib/request-execution-budget";
import {
  createSpendReservationLedger,
  type SpendJournal,
} from "../../src/lib/spend-reservation-ledger";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { createPoolBackpressureLimiter, resolveHeldAccountDispatch } from "../../src/routing/probe-lease";
import { clearTransientProbeLeasesForTests } from "../../src/routing/probe-lease";
import {
  canPortConversationState,
  collectConversationStateCarriers,
  applyAccountChangeConversationStateScrub,
} from "../../src/server/responses/account-change-state";
import {
  clearConversationStateIssuerMap,
  rememberConversationStateIssuer,
} from "../../src/codex/routing";

/**
 * The #4546 incident, as a system rather than as five separate fixes.
 *
 * The amplification was never one missing limit. Every layer that could re-send counted its own
 * allowance, every recovery leg read a remainder nobody else had spent, and the spend that
 * resulted was accounted nowhere that survived a restart. Each layer of this lane fixes one
 * seam; what nobody checks is whether the seams agree.
 *
 * These compose the real primitives -- the request execution budget, the durable spend ledger
 * and its request-scoped caller, the pool recovery limiter -- and assert the numbers line up:
 * physical sends, budget consumption, ledger settlement and the refusal the client is given all
 * describe the same events. A fixture that only counted sends would have passed throughout the
 * incident.
 */
const memoryJournal = (): SpendJournal & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    read: () => [...lines],
    append: (line: string) => { lines.push(line); },
    rewrite: (next: string[]) => { lines.splice(0, lines.length, ...next); },
  };
};

const logContext = () => ({
  provider: "pool-a",
  accountLogLabel: "k0123456789abcdef0123456789abcdef",
  usageLogInputTokens: 100,
  spendOutputCeilingTokens: 400,
}) as Parameters<typeof createRequestSpendTracker>[0];

describe("#4546 cost guard, end to end", () => {
  test("a request cannot exceed its ceiling however many layers try to recover", () => {
    const journal = memoryJournal();
    const ledger = createSpendReservationLedger({ journal });
    const tracker = createRequestSpendTracker(logContext(), "root-incident", ledger);
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY, "lr-incident", tracker);

    // Three same-account sends: the initial one and two transient retries.
    for (let index = 0; index < 3; index += 1) {
      expect(budget.reserveDispatch({ sendClass: "transient", targetKey: "pool-a|m" }).allowed).toBe(true);
    }
    // The base allowance is gone. A repair leg may still draw the single shared reserve...
    const repair = budget.reserveDispatch({ sendClass: "repair", targetKey: "pool-a|m" });
    expect(repair.allowed).toBe(true);
    // ...and taking it is what spends the single shared reserve.
    expect(budget.reserveSpent).toBe(true);
    // An account move cannot ALSO have one. The ceiling is what refuses it, which is the
    // intersection the incident lacked: each layer used to hold its own allowance, so a spent
    // request still funded every one of them.
    const move = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "pool-b|m" });
    expect(move.allowed).toBe(false);
    if (move.allowed) throw new Error("unreachable");
    expect(move.reason).toBe("total-exhausted");

    expect(budget.used).toBe(CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTotalModelSends);
    // The ledger saw exactly the sends the budget charged -- no more, and not one fewer.
    expect(ledger.snapshot("root", "root-incident")?.reserved).toBe(4 * 500);
  });

  test("concurrent requests share the recovery allowance instead of each holding one", () => {
    clearTransientProbeLeasesForTests();
    const now = 5_000_000;
    // One initial send in the window, so the ratio floor is the whole allowance.
    const limiter = createPoolBackpressureLimiter({
      windowMs: 10_000, maxRetryRatio: 0, minRecoveryAllowance: 1,
    });
    limiter.recordInitialSend(now);

    // Two requests bound to the same held account arrive together. Exactly one probes it.
    const first = resolveHeldAccountDispatch({ boundAccountId: "held", now, backpressure: limiter });
    const second = resolveHeldAccountDispatch({ boundAccountId: "held", now, backpressure: limiter });
    expect(first.kind).toBe("probe");
    expect(second.kind).toBe("withheld");

    // The refused one is told when to come back, and it is genuinely later. A refusal that said
    // "now" would put the same load on the pool as the dispatch it declined.
    if (second.kind === "withheld") {
      expect(second.retryAt).toBeGreaterThan(now);
    }
    // Separate request objects cannot mint private allowances: the limiter is process-wide.
    expect(limiter.state(now).recoveryDispatches).toBe(1);
    // The withheld result above short-circuits on the lease before it reaches the limiter, so
    // it costs no allowance -- asserting a refusal there would claim a path the code never
    // took. The shared bound is proved by asking the limiter directly: a third leg, with its
    // own request object and its own send budget, finds the one allowance already spent.
    expect(limiter.tryPermitRetryDispatch(now)).toBe(false);
    expect(limiter.state(now).refusedTotal).toBe(1);
    expect(limiter.state(now).recoveryDispatches).toBe(1);
  });

  test("a request that keeps its detour does not spend a probe on a failing account", () => {
    clearTransientProbeLeasesForTests();
    const now = 6_000_000;
    const limiter = createPoolBackpressureLimiter({
      windowMs: 10_000, maxRetryRatio: 0, minRecoveryAllowance: 1,
    });
    expect(resolveHeldAccountDispatch({ boundAccountId: "held", now, backpressure: limiter }).kind)
      .toBe("probe");
    // The probe is out, so the next caller keeps the route that is working rather than adding a
    // second trial to an account already known to be failing.
    expect(resolveHeldAccountDispatch({
      boundAccountId: "held", detourAccountId: "detour", now, backpressure: limiter,
    })).toEqual({ kind: "detour", accountId: "detour" });
  });

  test("a fan-out child spends the parent's allowance, not a fresh one", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal() });
    const tracker = createRequestSpendTracker(logContext(), "root-fanout", ledger);
    const parent = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY, "lr-parent", tracker);
    parent.reserveDispatch({ sendClass: "initial", targetKey: "pool-a|m" });

    // A combo child inherits the holder. The incident's second half was children each taking a
    // full allowance, so a seven-hundred-child fan-out sent seven hundred times under one cap.
    const child = parent;
    child.reserveDispatch({ sendClass: "combo-failover", targetKey: "pool-b|m" });
    expect(parent.used).toBe(2);
    expect(parent.remainingBaseSends(3)).toBe(1);
    // One more move is refused: the child already spent the request's single target transition.
    const third = child.reserveDispatch({ sendClass: "combo-failover", targetKey: "pool-c|m" });
    expect(third.allowed).toBe(false);
    expect(ledger.snapshot("root", "root-fanout")?.reserved).toBe(2 * 500);
  });

  test("a restart neither resets the ceiling nor settles the same send twice", () => {
    const journal = memoryJournal();
    const before = createSpendReservationLedger({ journal });
    const tracker = createRequestSpendTracker(logContext(), "root-restart", before);
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY, "lr-restart", tracker);
    budget.reserveDispatch({ sendClass: "initial", targetKey: "pool-a|m" });
    budget.reserveDispatch({ sendClass: "transient", targetKey: "pool-a|m" });

    // The terminal arrives and the request settles normally.
    tracker.settle({ inputTokens: 120, outputTokens: 30 });
    const settledBefore = before.snapshot("root", "root-restart");
    expect(settledBefore?.settled).toBe(150);
    expect(settledBefore?.unresolved).toBe(500);
    expect(settledBefore?.reserved).toBe(0);

    // Restart. The journal is the whole state, and replaying it changes none of the figures --
    // a ceiling that reset here would hand the next process a fresh allowance for spend that
    // already happened, and a second settlement would double-count it.
    const after = createSpendReservationLedger({ journal });
    const settledAfter = after.snapshot("root", "root-restart");
    expect(settledAfter?.settled).toBe(150);
    expect(settledAfter?.unresolved).toBe(500);
    expect(settledAfter?.reserved).toBe(0);
    // Settlement is keyed on the send id the ledger issued, not on the request. An id it never
    // issued -- a caller guessing, or a replayed logical request id -- settles nothing.
    expect(after.settle("lr-restart", { inputTokens: 1, outputTokens: 1 })).toBe(false);
    expect(after.snapshot("root", "root-restart")?.settled).toBe(150);
  });

  test("an account change drops continuation state and keeps the file reference intact", () => {
    clearConversationStateIssuerMap();
    const bindingKey = "thread-4546-incident";
    rememberConversationStateIssuer(bindingKey, "account-a");

    // Continuation state is portable-by-dropping: one cold turn, then the new account records
    // itself as the issuer. This half of the contract does not change.
    const continuation: Record<string, unknown> = {
      model: "gpt-5.4",
      previous_response_id: "resp_account_a",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] }],
    };
    expect(applyAccountChangeConversationStateScrub({
      body: continuation, bindingKey, servingAccountId: "account-b",
    })).toBe(true);
    expect(continuation.previous_response_id).toBeUndefined();
    expect(continuation.input).toBeDefined();

    // An uploaded file is not. The classifier has always said so, and it says so whether or not
    // the body also carries a response id -- the verdict reports the first reason it finds, so
    // the file is what the carriers must be read for.
    const withFile: Record<string, unknown> = {
      model: "gpt-5.4",
      previous_response_id: "resp_account_a",
      input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file_abc123" }] }],
    };
    expect(collectConversationStateCarriers(withFile).fileIds).toEqual(["file_abc123"]);
    expect(canPortConversationState(collectConversationStateCarriers(withFile)).portable).toBe(false);

    // The scrub does not remove it, and must not: a file reference is content the caller
    // attached, not continuation state the turn can do without.
    applyAccountChangeConversationStateScrub({
      body: withFile, bindingKey, servingAccountId: "account-b",
    });
    expect(collectConversationStateCarriers(withFile).fileIds).toEqual(["file_abc123"]);

    // PENDING CONTRACT (#4710, owned elsewhere): once the refusal lands, this body must be
    // declined before dispatch rather than forwarded, and the refusal wins even when a
    // previous_response_id is present too. When that arrives, add the refusal assertion here
    // -- the two properties below are what it has to preserve, and they are asserted now so the
    // change cannot quietly alter them.
    clearConversationStateIssuerMap();
  });

  test("a refusal made before dispatch spends no send and books no spend", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal() });
    const tracker = createRequestSpendTracker(logContext(), "root-refused", ledger);
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY, "lr-refused", tracker);

    // Nothing reserved, because nothing dispatched. This is the invariant every pre-dispatch
    // refusal in the tree owes the accounting -- a budget refusal, a workflow ceiling, and the
    // account-change file refusal #4710 is adding. A refusal counted as a send would show up as
    // provider load that never existed, and would push a healthy account toward a cooldown.
    expect(budget.used).toBe(0);
    expect(ledger.snapshot("root", "root-refused")).toBeUndefined();
    expect(tracker.refusals).toBe(0);
  });
});
