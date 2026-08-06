/**
 * A real second process for the N contention tests.
 *
 * Two processes are the only way to prove cross-process exclusion. A second
 * async task in one isolate shares the SQLite connection cache and the
 * reentrancy store, so it proves neither — and this unit has already shipped a
 * test that looked like a race and was not one.
 *
 * It calls the PRODUCTION module, never a copy, and prints exactly one JSON
 * line so the parent can assert on a typed result rather than on log scraping.
 */
import { withCodexWriteLock } from "../../src/codex/codex-write-lock";
import type { AdmissionSnapshot } from "../../src/codex/convergence-types";

const payload = JSON.parse(process.env.OCX_LOCK_CHILD_PAYLOAD ?? "{}") as {
  timeoutMs?: number;
  holdMarker?: string;
  releaseMarker?: string;
};

const admitted = { authoritySnapshotId: "authority-child" } as AdmissionSnapshot;

const result = await withCodexWriteLock(
  {
    timeoutMs: payload.timeoutMs ?? 0,
    admitted,
    readAdmissionUnderLock: () => admitted,
  },
  ctx => {
    if (payload.holdMarker) {
      // Tell the parent the lock is HELD, then block this thread so it stays
      // held. The callback is synchronous by contract, so a sleep here is a busy
      // wait on purpose: awaiting would release nothing and violate the contract.
      Bun.write(payload.holdMarker, "held").catch(() => {});
      const until = Date.now() + 3_000;
      while (Date.now() < until) {
        if (payload.releaseMarker && Bun.file(payload.releaseMarker).size > 0) break;
      }
    }
    // ALWAYS publishes. The lock verifies the row before it will commit, so a
    // callback that writes nothing is not a valid commit — a caller cannot take
    // N, do something else, and have the coordinator record a transition it
    // never made. An earlier version of this helper had a `publish: false`
    // option, and every child that used it failed with "the coordinator
    // transition was not published"; the option was describing a state the
    // contract does not have.
    {
      ctx.coordinator.beginTransition(
        { nativeGeneration: ctx.expectation.nativeBefore, currentTxId: ctx.currentTxId },
        {
          txId: ctx.expectation.txId,
          direction: "apply",
          authoritySnapshotId: ctx.admission.authoritySnapshotId,
          nextRetryAt: new Date().toISOString(),
        },
      );
    }
    return "child-committed";
  },
);

console.log(JSON.stringify({
  status: result.status,
  ...(result.status === "acquired" ? { value: result.value, lockId: result.lockId } : {}),
  ...(result.status === "busy" ? { reason: result.reason } : {}),
  ...(result.status === "refused" ? { reason: result.reason } : {}),
}));
