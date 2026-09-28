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
  try {
    const decision = deps.decide();
    if (decision.kind === "stay-out") deps.stayOut(decision.refusal);
    return await deps.recover();
  } finally {
    lease.release();
  }
}
