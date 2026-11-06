import type { ServiceChildOwnershipDecision } from "../service/service-child-ownership";
import { removePidIfValueIs } from "../config/process-state";
import { observeProxyLiveness, START_OWNERSHIP_LIVENESS, type LiveProxy } from "../server/proxy-liveness";
import { markCrossHomeSibling, reconcileStartupJournal } from "./cross-home-owner";

/** Called only under the ownership lease; a negative early probe grants no mutation authority. */
export async function recoverStartJournalAfterOwnerRecheck(
  owner: { live: LiveProxy | null; pidSnapshot: number | null },
  sibling = false,
): Promise<boolean> {
  const observation = await observeProxyLiveness(START_OWNERSHIP_LIVENESS);
  owner.live = observation.live;
  if (owner.live) return sibling;
  if (observation.kind !== "absent") {
    throw new Error("Proxy ownership is unverified; startup refused. PID record and recovery journal were preserved. Retry when the owner can be verified.");
  }
  removePidIfValueIs(owner.pidSnapshot);
  if (!sibling) sibling = await markCrossHomeSibling();
  if (!sibling) reconcileStartupJournal();
  return sibling;
}

/** Hold ownership stable through the final liveness check and shared-state recovery. */
export async function recoverStartStateUnderOwnershipLease(deps: {
  supervised: boolean;
  acquireLease: () => { release(): void };
  decide: () => ServiceChildOwnershipDecision;
  stayOut: (refusal: string) => never;
  recover: () => Promise<boolean>;
}): Promise<boolean> {
  const lease = deps.acquireLease();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };
  try {
    const decision = deps.supervised ? deps.decide() : { kind: "proceed" as const };
    if (decision.kind === "stay-out") {
      // stayOut exits the process, so a finally block would never release the lease.
      release();
      deps.stayOut(decision.refusal);
    }
    return await deps.recover();
  } finally {
    release();
  }
}
