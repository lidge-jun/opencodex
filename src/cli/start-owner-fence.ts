import type { ServiceChildOwnershipDecision } from "../service/service-child-ownership";

/** Fence shared client-state recovery against a claim committed after the early owner probe. */
export async function recoverStartStateUnderOwnershipLease(deps: {
  supervised: boolean;
  acquireLease: () => { release(): void };
  decide: () => ServiceChildOwnershipDecision;
  stayOut: (refusal: string) => never;
  recover: () => Promise<boolean>;
}): Promise<boolean> {
  if (!deps.supervised) return deps.recover();
  const lease = deps.acquireLease();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };
  try {
    const decision = deps.decide();
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
