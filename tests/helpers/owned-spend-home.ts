import { afterEach, beforeEach } from "bun:test";
import { acquireSpendLedgerOwner, type SpendLedgerOwnerLease } from "../../src/lib/spend-ledger-owner";
import { resetSharedSpendLedgerForTest } from "../../src/lib/spend-reservation-ledger";

/**
 * Hold the spend-journal writer lease for a case that dispatches without starting a server.
 *
 * `startServer` takes this lease before anything can serve, so production traffic always
 * reaches the ledger owning its state directory. A case that calls an internal handler directly
 * skips that step, and the ledger refuses to write for a process that owns nothing. Taking the
 * real lease here keeps the production rule intact instead of teaching the ledger to make an
 * exception for tests.
 *
 * The lease is released after every case, so a later case under a different state directory
 * finds the directory free.
 */
export function useOwnedSpendHome(): void {
  let lease: SpendLedgerOwnerLease | undefined;
  beforeEach(() => {
    resetSharedSpendLedgerForTest();
    lease = acquireSpendLedgerOwner();
  });
  afterEach(() => {
    const held = lease;
    lease = undefined;
    try { held?.release(); } catch { /* a failed release must not mask the case's result */ }
    resetSharedSpendLedgerForTest();
  });
}
