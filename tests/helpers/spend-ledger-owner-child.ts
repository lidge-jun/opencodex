/** Real-process holder for spend-ledger single-writer tests. */
import { existsSync, writeFileSync } from "node:fs";
import { acquireSpendLedgerOwner, SpendLedgerOwnerError } from "../../src/lib/spend-ledger-owner";
import {
  configureSharedSpendLedger,
  sharedSpendLedger,
  type SpendReservationPolicy,
} from "../../src/lib/spend-reservation-ledger";

const payload = JSON.parse(process.env.OCX_SPEND_OWNER_CHILD ?? "{}") as {
  holdMarker?: string;
  releaseMarker?: string;
  mode?: "observe" | "enforced";
};

try {
  const lease = acquireSpendLedgerOwner();
  const policy: SpendReservationPolicy = {
    root: payload.mode === "enforced" ? { maxTokens: 1_000 } : {},
    identity: {},
    pool: {},
    retentionMs: 60_000,
  };
  configureSharedSpendLedger(policy);
  const ledger = sharedSpendLedger();
  ledger.reserve({
    sendId: `child-${payload.mode ?? "observe"}`,
    scopes: { rootId: "child-root" },
    inputTokens: 1,
    outputCeilingTokens: 1,
  });
  if (payload.holdMarker) writeFileSync(payload.holdMarker, "held");
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (payload.releaseMarker && !existsSync(payload.releaseMarker)) {
    Atomics.wait(waiter, 0, 0, 20);
  }
  lease.release();
  console.log(JSON.stringify({ status: "acquired" }));
} catch (error) {
  console.log(JSON.stringify({
    status: "refused",
    code: error instanceof SpendLedgerOwnerError ? error.code : "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  }));
}
