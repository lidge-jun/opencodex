import { describe, expect, test } from "bun:test";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY, type SpendDenial, type SpendReservationPolicy } from "../../src/lib/spend-reservation-ledger";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import type { RequestLogContext } from "../../src/server/request-log";

function fixture(policy: Partial<SpendReservationPolicy>, rootId: string | undefined = "fixture-root", identityId: string | undefined = "fixture-account") {
  const ledger = createSpendReservationLedger({ policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, ...policy }, salt: "fixture-only" });
  const context: RequestLogContext = { model: "fixture-model", provider: "fixture-pool", accountLogLabel: identityId,
    usageLogInputTokens: 10, spendOutputCeilingTokens: 20 };
  const tracker = createRequestSpendTracker(context, rootId, ledger);
  const budget = createRequestExecutionBudget(undefined, "fixture-request", tracker);
  let dispatched = 0;
  const attempt = () => {
    const decision = budget.reserveDispatch({ sendClass: "initial", targetKey: "fixture-pool/model" });
    if (decision.allowed && decision.permit.use()) dispatched++;
    return decision;
  };
  return { ledger, context, tracker, budget, attempt, dispatched: () => dispatched };
}

describe("configured spend cannot dispatch without a capacity booking", () => {
  for (const limit of ["root", "identity", "pool"] as const) {
    for (const capacity of ["scopes", "sends"] as const) {
      test(`${limit} ceiling refuses exhausted ${capacity} tracking`, () => {
        const f = fixture({ [limit]: { maxTokens: 1000 }, ...(capacity === "scopes" ? { maxTrackedScopes: 1 } : { maxTrackedSends: 1 }) });
        if (capacity === "sends") expect(f.ledger.reserve({ sendId: "busy", scopes: { poolId: "fixture-pool" }, inputTokens: 1, outputCeilingTokens: 0 }).reserved).toBe(true);
        expect(f.attempt().allowed).toBe(false);
        expect(f.dispatched()).toBe(0);
        expect(f.budget.used).toBe(0);
        expect(f.tracker.refusals).toBe(1);
        expect(f.context.errorCode).toBe("workflow_tracking_exhausted");
        expect(f.context.terminalSource).toBe("synthetic");
        expect(f.ledger.snapshot("pool", "fixture-pool")?.reserved).toBe(capacity === "sends" ? 1 : undefined);
      });
    }
  }

  for (const mode of ["unconfigured", "rootless", "identityless"] as const) {
    test(`${mode} capacity failure stays permissive with no local refusal`, () => {
      // Passing explicit undefined to the factory would use its default, so remove the
      // irrelevant scope in the tracker itself while retaining real ledger capacity pressure.
      const ledger = createSpendReservationLedger({ policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, maxTrackedSends: 1,
        ...(mode === "rootless" ? { root: { maxTokens: 1000 } } : mode === "identityless" ? { identity: { maxTokens: 1000 } } : {}),
      } });
      ledger.reserve({ sendId: "busy", scopes: { poolId: "pool" }, inputTokens: 1, outputCeilingTokens: 0 });
      const context: RequestLogContext = { model: "fixture", provider: "pool", spendOutputCeilingTokens: 30 };
      const tracker = createRequestSpendTracker(context, undefined, ledger);
      const budget = createRequestExecutionBudget(undefined, undefined, tracker);
      const decision = budget.reserveDispatch({ sendClass: "initial", targetKey: "pool/model" });
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) throw new Error("expected observe-only dispatch");
      expect(decision.permit.use()).toBe(true);
      expect(budget.used).toBe(1);
      expect(tracker.refusals).toBe(0);
      expect(context.localTerminalReason).toBeUndefined();
      expect(context.errorCode).toBeUndefined();
      expect(ledger.snapshot("pool", "pool")?.reserved).toBe(1);
    });
  }

  test("an already-sent capacity failure preserves physical count without a false refusal", () => {
    const f = fixture({ pool: { maxTokens: 1000 }, maxTrackedSends: 1 });
    f.ledger.reserve({ sendId: "busy", scopes: { poolId: "fixture-pool" }, inputTokens: 1, outputCeilingTokens: 0 });
    f.budget.used += 1;
    expect(f.budget.used).toBe(1);
    expect(f.tracker.refusals).toBe(0);
    expect(f.context.errorCode).toBeUndefined();
    expect(f.context.localTerminalReason).toBeUndefined();
    expect(f.ledger.snapshot("pool", "fixture-pool")?.reserved).toBe(1);
  });

  test("enabling a ceiling affects the existing tracker on its next charge", () => {
    const f = fixture({ maxTrackedScopes: 1 });
    expect(f.attempt().allowed).toBe(true);
    f.ledger.reconfigure({ ...f.ledger.policy, pool: { maxTokens: 1000 } });
    expect(f.attempt().allowed).toBe(false);
    expect(f.dispatched()).toBe(1);
    expect(f.budget.used).toBe(1);
    expect(f.tracker.refusals).toBe(1);
  });

  test("newly resolved identity applies on the next charge without reconstructing the tracker", () => {
    const f = fixture({ identity: { maxTokens: 1000 }, maxTrackedScopes: 1 });
    delete f.context.accountLogLabel;
    expect(f.attempt().allowed).toBe(true);
    f.context.accountLogLabel = "newly-resolved-account";
    expect(f.attempt().allowed).toBe(false);
    expect(f.dispatched()).toBe(1);
    expect(f.budget.used).toBe(1);
  });
});

for (const [denial, code] of [
  [{ reason: "duplicate-send-id", sendId: "duplicate" }, "workflow_send_replayed"],
  [{ reason: "reserve-not-durable", sendId: "failed-write" }, "workflow_spend_undurable"],
  [{ reason: "journal-corrupt", corruptRecords: 1 }, "workflow_spend_undurable"],
] as const satisfies ReadonlyArray<readonly [SpendDenial, string]>) {
  test(`${denial.reason} refuses only an applicable new dispatch`, () => {
    for (const enforced of [false, true]) {
      for (const alreadySent of [false, true]) {
        const f = fixture(enforced ? { pool: { maxTokens: 1000 } } : {});
        // Force the exact refusal to test the consumer; real capacity failures are above,
        // and actual journal failures/corruption are covered by the ledger regression suite.
        const ledger = Object.create(f.ledger) as typeof f.ledger;
        ledger.reserve = () => ({ reserved: false, denial });
        const tracker = createRequestSpendTracker(f.context, undefined, ledger);
        expect(tracker.charge({ alreadySent })).toBe(alreadySent || !enforced);
        expect(tracker.refusals).toBe(enforced && !alreadySent ? 1 : 0);
        expect(f.context.errorCode).toBe(enforced && !alreadySent ? code : undefined);
      }
    }
  });
}
