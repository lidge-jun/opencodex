import { withConfigMutationLockSync } from "../config";
import type { OcxClientConnectionConfig } from "../types";
import { withLinkApply } from "./link-home";
import { clientConnectionEnded } from "./runtime-restart";
import { pendingClientConnectMayOwnToken, readClientConnectionStateWithEvidence } from "./state";

/**
 * Called outside L: Link apply exclusion is outermost in the apply -> N -> L -> C order.
 * Once admitted, keep it through all teardown awaits; a new connect cannot commit halfway.
 */
export async function runClientRecycleWithAdmission(
  served: OcxClientConnectionConfig,
  allowed: () => boolean,
  teardown: () => Promise<void>,
): Promise<boolean> {
  let admitted = false;
  try {
    return await withLinkApply(async () => {
      admitted = withConfigMutationLockSync(() => allowed() && !pendingClientConnectMayOwnToken()
        && clientConnectionEnded(served, readClientConnectionStateWithEvidence()));
      if (!admitted) return false;
      await teardown();
      return true;
    });
  } catch (error) {
    if (admitted) throw error; // A started teardown must not masquerade as an admission refusal.
    return false;
  }
}
