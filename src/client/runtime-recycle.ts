import { readDesktopDisconnectReceipt } from "../claude/desktop-remote-store";
import { ConfigMutationLockError, withConfigMutationLockSync } from "../config";
import type { OcxClientConnectionConfig } from "../types";
import { LinkApplyBusyError, withLinkApply } from "./link-home";
import { clientConnectionEnded } from "./runtime-restart";
import { pendingClientConnectMayOwnToken, readClientConnectionStateWithEvidence, sameClientConnectionOwner } from "./state";

interface ScheduledRecycle {
  current: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

function recycleLockBusy(error: unknown): boolean {
  if (error instanceof LinkApplyBusyError) return true;
  const cause = error instanceof ConfigMutationLockError ? error.cause : undefined;
  return !!cause && typeof cause === "object" && "code" in cause
    && (cause.code === "SQLITE_BUSY" || cause.code === "SQLITE_LOCKED");
}

/**
 * Called outside L: Link apply exclusion is outermost in the apply -> N -> L -> C order.
 * Once admitted, keep it through all teardown awaits; a new connect cannot commit halfway.
 */
export async function runClientRecycleWithAdmission(
  served: OcxClientConnectionConfig,
  allowed: () => boolean,
  teardown: () => Promise<void>,
  scheduled?: ScheduledRecycle,
): Promise<boolean> {
  const now = scheduled?.now ?? (() => performance.now());
  const deadline = now() + 30_000;
  let delay = 50;
  for (let retried = false; ; retried = true) {
    if (scheduled && !scheduled.current()) return false;
    if (retried && now() >= deadline) {
      console.warn("[client] disconnect recycle timed out waiting for a Link lock; check ocx status and restart");
      return false;
    }
    let admitted = false;
    try {
      return await withLinkApply(async () => {
        admitted = withConfigMutationLockSync(() => {
          if ((scheduled && !scheduled.current()) || !allowed() || pendingClientConnectMayOwnToken()) return false;
          const current = readClientConnectionStateWithEvidence();
          // A new connection committed while this disconnect waited owns its own transition.
          if (!retried) return clientConnectionEnded(served, current);
          if (current.kind !== "disconnected") return false;
          const receipt = readDesktopDisconnectReceipt();
          return receipt.kind === "absent" || (receipt.kind === "valid" && receipt.value.phase === "complete"
            && sameClientConnectionOwner(receipt.value.owner, served) && receipt.value.tokenFingerprint === served.tokenFingerprint);
        });
        if (!admitted) return false;
        await teardown();
        return true;
      });
    } catch (error) {
      if (admitted) throw error;
      if (!scheduled || !recycleLockBusy(error)) return false;
    }
    await (scheduled.sleep ?? Bun.sleep)(Math.max(0, Math.min(delay, deadline - now())));
    delay = Math.min(delay * 2, 1_000);
  }
}
