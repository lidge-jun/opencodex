import { describe, expect, test } from "bun:test";
import {
  createSpendReservationLedger,
  DEFAULT_SPEND_RESERVATION_POLICY,
  type SpendJournal,
} from "../../src/lib/spend-reservation-ledger";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";

/**
 * The durable spend ledger had no production caller (#4707).
 *
 * Every verb existed -- reserve, markDispatched, settle, abandon, markLost -- and nothing in
 * the request path reached any of them, so `spend-ledger.jsonl` was never written by ordinary
 * traffic and the ceilings the feature advertised stayed process-local and count-only.
 *
 * These pin the three properties the wiring has to have: one entry per physical send, a
 * settlement that tells the send that reported usage apart from the ones that did not, and a
 * restart that neither resets a ceiling nor hands back tokens that may already have been
 * billed.
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

const logContext = (overrides: Record<string, unknown> = {}) => ({
  provider: "test-pool",
  accountLogLabel: "k0123456789abcdef0123456789abcdef",
  usageLogInputTokens: 100,
  spendOutputCeilingTokens: 400,
  ...overrides,
}) as Parameters<typeof createRequestSpendTracker>[0];

describe("the request path books every physical send on the durable ledger", () => {
  test("one entry per charged send, and the terminal send settles with the real usage", () => {
    const journal = memoryJournal();
    const ledger = createSpendReservationLedger({ journal });
    const tracker = createRequestSpendTracker(logContext(), "root-a", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-test", tracker);

    // A physical send is charged once by the request budget, so it is booked once here.
    const first = budget.reserveDispatch({ sendClass: "initial", targetKey: "p|m" });
    expect(first.allowed).toBe(true);
    expect(ledger.snapshot("root", "root-a")?.reserved).toBe(500);

    // A retry helper reporting its own send is the same shape: one report, one entry.
    budget.used += 1;
    expect(ledger.snapshot("root", "root-a")?.reserved).toBe(1000);

    // The terminal usage belongs to the send that produced it; the earlier one failed without
    // reporting any and may still have been billed, so it is unresolved rather than free.
    tracker.settle({ inputTokens: 120, outputTokens: 30 });
    const root = ledger.snapshot("root", "root-a");
    expect(root?.reserved).toBe(0);
    expect(root?.settled).toBe(150);
    expect(root?.unresolved).toBe(500);
  });

  test("a request that reports no usage leaves every send unresolved, not free", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal() });
    const tracker = createRequestSpendTracker(logContext(), "root-b", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-cancel", tracker);
    budget.reserveDispatch({ sendClass: "initial", targetKey: "p|m" });
    budget.used += 1;

    tracker.settle(undefined);
    const root = ledger.snapshot("root", "root-b");
    expect(root?.reserved).toBe(0);
    expect(root?.settled).toBe(0);
    expect(root?.unresolved).toBe(1000);
  });

  test("a reservation the budget hands back releases its tokens instead of booking spend", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal() });
    const tracker = createRequestSpendTracker(logContext(), "root-c", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-refund", tracker);

    const reserved = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "p|m" });
    expect(reserved.allowed).toBe(true);
    expect(ledger.snapshot("root", "root-c")?.reserved).toBe(500);
    if (!reserved.allowed) throw new Error("unreachable");

    // No alternate credential existed, so nothing left this process.
    reserved.permit.release();
    const root = ledger.snapshot("root", "root-c");
    expect(root?.reserved).toBe(0);
    expect(root?.unresolved).toBe(0);
    expect(root?.settled).toBe(0);
  });

  test("a ledger ceiling refuses the dispatch instead of describing it afterwards", () => {
    const ledger = createSpendReservationLedger({
      journal: memoryJournal(),
      policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 900 } },
    });
    const tracker = createRequestSpendTracker(logContext(), "root-d", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-ceiling", tracker);

    expect(budget.reserveDispatch({ sendClass: "initial", targetKey: "p|m" }).allowed).toBe(true);
    const refused = budget.reserveDispatch({ sendClass: "transient", targetKey: "p|m" });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    expect(refused.reason).toBe("spend-exhausted");
    // Refused before the budget charged it, so the send is not counted either.
    expect(budget.used).toBe(1);
    expect(tracker.refusals).toBe(1);
  });

  test("a restart resolves the reservations nobody is left to settle", () => {
    const journal = memoryJournal();
    const before = createSpendReservationLedger({ journal });
    const tracker = createRequestSpendTracker(logContext(), "root-e", before);
    const budget = createRequestExecutionBudget(undefined, "lr-crash", tracker);
    // Two sends left; the process dies before either is settled.
    budget.reserveDispatch({ sendClass: "initial", targetKey: "p|m" });
    budget.reserveDispatch({ sendClass: "transient", targetKey: "p|m" });
    expect(before.snapshot("root", "root-e")?.reserved).toBe(1000);

    const after = createSpendReservationLedger({ journal });
    const root = after.snapshot("root", "root-e");
    // Nothing stays reserved: a reservation with no owner would hold its tokens forever.
    expect(root?.reserved).toBe(0);
    // Both keep their tokens as unresolved, including the one still open. A send can dispatch
    // and die before its dispatch record lands, so "open" does not prove nothing was sent --
    // and handing those tokens back would reset a ceiling that had already fired.
    expect(root?.unresolved).toBe(1000);
    expect(root?.settled).toBe(0);

    // Replaying the same journal again is idempotent: the reconciliation was journaled, so a
    // second restart has nothing left to resolve and cannot double-book it.
    const third = createSpendReservationLedger({ journal });
    expect(third.snapshot("root", "root-e")?.unresolved).toBe(1000);
    expect(third.snapshot("root", "root-e")?.reserved).toBe(0);
  });
});
