import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpendReservationLedger,
  DEFAULT_SPEND_RESERVATION_POLICY,
  type SpendJournal,
} from "../../src/lib/spend-reservation-ledger";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { SpendLedgerOwnerError, type SpendLedgerOwnerErrorCode } from "../../src/lib/spend-ledger-owner";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

/** A journal that cannot persist: the disk-full and permission case durability exists for. */
const unwritableJournal = (): SpendJournal => ({
  read: () => [],
  append: () => { throw new Error("ENOSPC: no space left on device"); },
});

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

  test("a send that already left is recorded past the ceiling, so the next one can be refused", () => {
    // The canonical passthrough ladder does not reserve its physical sends; it reports them
    // after the fetch through onSendsConsumed, which assigns through budget.used. A ceiling
    // cannot refuse those -- the tokens are spent -- and DROPPING them is a fixpoint: the send
    // that would cross the limit never joins the total, the total sits one send short of the
    // ceiling forever, and nothing is ever refused. Recording it is what arms the refusal.
    const ledger = createSpendReservationLedger({
      journal: memoryJournal(),
      policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 900 } },
    });
    const tracker = createRequestSpendTracker(logContext(), "root-f", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-reported", tracker);

    budget.used += 1;
    expect(ledger.snapshot("root", "root-f")?.reserved).toBe(500);
    expect(ledger.exhausted("root", "root-f")).toBe(false);

    // This one projects 1000 against a ceiling of 900 and is booked anyway, because it left.
    budget.used += 1;
    expect(ledger.snapshot("root", "root-f")?.reserved).toBe(1000);
    expect(ledger.exhausted("root", "root-f")).toBe(true);
    // Nothing was refused after the fact -- there was nothing left to refuse.
    expect(tracker.refusals).toBe(0);

    // The ceiling is now armed: the next send that asks BEFORE dispatching is refused.
    const refused = budget.reserveDispatch({ sendClass: "transient", targetKey: "p|m" });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    expect(refused.reason).toBe("spend-exhausted");

    // And a send that already left cannot be handed back for free afterwards: it is marked
    // dispatched when it is recorded, so a refund keeps the tokens as unresolved spend.
    tracker.refund();
    const root = ledger.snapshot("root", "root-f");
    expect(root?.reserved).toBe(500);
    expect(root?.unresolved).toBe(500);
  });

  test("under a configured ceiling a reservation that cannot be made durable refuses the send", () => {
    // Durability before admission is the reason this store is on disk at all: a send whose
    // record a restart would forget is how an exhausted budget comes back with a fresh
    // allowance. The ledger raises this denial only when a limit is configured, so the
    // unconfigured case below is unchanged.
    const ceiling = createSpendReservationLedger({
      journal: unwritableJournal(),
      policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 10_000 } },
    });
    const guarded = createRequestExecutionBudget(
      undefined,
      "lr-undurable",
      createRequestSpendTracker(logContext(), "root-g", ceiling),
    );
    const refused = guarded.reserveDispatch({ sendClass: "initial", targetKey: "p|m" });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    expect(refused.reason).toBe("spend-exhausted");

    // With no ceiling configured, the same unwritable journal is a degradation to report and
    // never an outage to cause.
    const observing = createRequestExecutionBudget(
      undefined,
      "lr-observe",
      createRequestSpendTracker(logContext(), "root-h", createSpendReservationLedger({ journal: unwritableJournal() })),
    );
    expect(observing.reserveDispatch({ sendClass: "initial", targetKey: "p|m" }).allowed).toBe(true);
  });

  test("settlement after the reserved send's owner lease ends is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-spend-wiring-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    const release = acquireOwnedSpendHome();
    try {
      const tracker = createRequestSpendTracker(logContext(), "root-released");
      const budget = createRequestExecutionBudget(undefined, "lr-released", tracker);
      expect(budget.reserveDispatch({ sendClass: "initial", targetKey: "p|m" }).allowed).toBe(true);

      release();
      expect(() => tracker.settle({ inputTokens: 10, outputTokens: 5 })).not.toThrow();
      expect(() => tracker.settle(undefined)).not.toThrow();
    } finally {
      release();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(dir);
    }
  });

  test("other owner and storage failures propagate without losing pending sends", () => {
    const failures: Array<SpendLedgerOwnerErrorCode | "storage"> = [
      "SPEND_LEDGER_OWNER_BUSY",
      "SPEND_LEDGER_OWNER_UNAVAILABLE",
      "SPEND_LEDGER_OWNER_HOME_CONFLICT",
      "storage",
    ];
    for (const failure of failures) {
      const ledger = createSpendReservationLedger({ journal: memoryJournal() });
      const originalMarkLost = ledger.markLost;
      const expected = failure === "storage"
        ? new Error("storage failure")
        : new SpendLedgerOwnerError(failure, "owner failure");
      let failOnce = true;
      const tracker = createRequestSpendTracker(logContext(), `root-${failure}`, {
        ...ledger,
        markLost(sendId) {
          if (failOnce) {
            failOnce = false;
            throw expected;
          }
          return originalMarkLost(sendId);
        },
      });
      const budget = createRequestExecutionBudget(undefined, `lr-${failure}`, tracker);
      budget.used += 1;
      budget.used += 1;

      expect(() => tracker.settle({ inputTokens: 120, outputTokens: 30 })).toThrow(expected);
      const pending = ledger.snapshot("root", `root-${failure}`);
      expect(pending?.reserved).toBe(500);
      expect(pending?.settled).toBe(150);
      tracker.settle({ inputTokens: 120, outputTokens: 30 });
      const complete = ledger.snapshot("root", `root-${failure}`);
      expect(complete?.reserved).toBe(0);
      expect(complete?.settled).toBe(150);
      expect(complete?.unresolved).toBe(500);
    }
  });
});
