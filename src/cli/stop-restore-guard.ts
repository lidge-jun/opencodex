import { withConfigMutationLockSync } from "../config";
import { inspectStopRestoreOwnership } from "../client/restore-ownership";
export { inspectStopRestoreOwnership, stopRestoreWriteGuard } from "../client/restore-ownership";
import type { StopRunRecord } from "./stop-report";
import { clearPendingTeardown, pendingTeardownPathFor } from "../config/pending-teardown";

type RestoreRecord = Pick<StopRunRecord, "sharedTeardown" | "receiptClearFailed">;

function refuse(record: RestoreRecord): true {
  record.sharedTeardown = "refused";
  console.error("❌ The client connection could not be confirmed (it may be changing); restoration stopped and the obligation is kept. Rerun 'ocx stop'.");
  return true;
}

/** Only the named, discharged nonces are removed; C covers both ownership and unlink. */
export function clearRestoredStopReceipts(record: RestoreRecord, nonces: string[], restored = true): boolean {
  let entered = false;
  try {
    return withConfigMutationLockSync(() => {
      entered = true;
      const boundary = inspectStopRestoreOwnership();
      if (boundary === "unproven" || boundary === "restore" && !restored) return refuse(record);
      if (boundary === "hub-owned") {
        record.sharedTeardown = "skipped";
        console.log("↩️  A hub connection was committed while this stop ran; it owns Codex routing, its catalog and the Grok config, so restoration stopped.");
      }
      let failed = false;
      for (const nonce of nonces) {
        if (!clearPendingTeardown(nonce)) {
          failed = true;
          record.receiptClearFailed = true;
          console.error(`❌ The shared teardown was discharged, but its receipt could not be removed: ${pendingTeardownPathFor(nonce)}`);
          console.error("   Remove it manually; otherwise every later stop and update will try to recover it again.");
        }
      }
      return failed;
    });
  } catch {
    if (entered) record.receiptClearFailed = true;
    return refuse(record);
  }
}

export function settleUnrestoredStopBoundary(
  boundary: "hub-owned" | "unproven", record: RestoreRecord, nonces: string[],
): boolean {
  return boundary === "unproven" ? refuse(record) : clearRestoredStopReceipts(record, nonces, false);
}
