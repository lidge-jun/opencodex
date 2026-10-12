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
 * Returns an idempotent release. Call it FIRST in the case's own teardown, before the state
 * directory is removed and before the home variable is restored: an open SQLite lease inside a
 * directory being deleted fails the removal on Windows and leaves an unlinked live database on
 * POSIX. Ordering is stated by the caller rather than inferred from hook registration order,
 * which differs between these fixtures and is not a contract either way.
 */
export function acquireOwnedSpendHome(): () => void {
  resetSharedSpendLedgerForTest();
  const lease: SpendLedgerOwnerLease = acquireSpendLedgerOwner();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // A rollback or close failure is a real defect in the thing under test, so it is allowed to
    // fail the case. Swallowing it would leave a green run over a lease that never let go.
    try {
      lease.release();
    } finally {
      resetSharedSpendLedgerForTest();
    }
  };
}
