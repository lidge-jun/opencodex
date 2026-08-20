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
import { writeFileSync } from "node:fs";

const payload = JSON.parse(process.env.OCX_LOCK_CHILD_PAYLOAD ?? "{}") as {
  timeoutMs?: number;
  holdMarker?: string;
  releaseMarker?: string;
  holdMs?: number;
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
      //
      // The write must be SYNCHRONOUS for the same reason. `Bun.write` returns a
      // promise whose file write only lands on a later event-loop turn, and the
      // busy wait below yields no turn -- so the marker appeared ~3s late, AFTER
      // the hold had already ended. The parent then started its contender against
      // an unheld lock and saw `acquired` where the test demands `busy`, which
      // reads exactly like a broken exclusion invariant rather than a late marker.
      writeFileSync(payload.holdMarker, "held");
      // The release marker is the real signal; this is only the ceiling for how long we wait
      // to see it. Three seconds was enough where the contender starts quickly, but on a
      // Windows shard the contender's process spawn can outlast the hold — the holder then
      // releases first and the parent sees `acquired` where it demands `busy`, which reads as
      // a broken exclusion invariant rather than as a hold that expired too early (#2152).
      const until = Date.now() + (payload.holdMs ?? 3_000);
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
  ...(result.status === "busy" ? { reason: result.reason, lockId: result.lockId } : {}),
  ...(result.status === "refused" ? { reason: result.reason } : {}),
}));
