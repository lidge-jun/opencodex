import type { OcxSpendConfig } from "../../types/config";
import {
  acquireSpendLedgerOwner,
  type SpendLedgerOwnerLease,
} from "../../lib/spend-ledger-owner";
import {
  configureSharedSpendLedger,
  spendPolicyFromConfig,
} from "../../lib/spend-reservation-ledger";

export interface SpendLedgerServerLifecycle {
  configure(spend: OcxSpendConfig | undefined): void;
  track<T extends { stop(closeActiveConnections?: boolean): void | Promise<void> }>(server: T): T;
  release(): void;
  releaseAfterFailedStart(): void;
}

/** Acquire before config loading so every later startup failure has one rollback owner. */
export function acquireSpendLedgerServerLifecycle(configDir: string): SpendLedgerServerLifecycle {
  const owner: SpendLedgerOwnerLease = acquireSpendLedgerOwner(configDir);
  const failedStartStops: Array<() => void> = [];
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    owner.release();
  };
  return {
    configure(spend): void {
      configureSharedSpendLedger(spendPolicyFromConfig(spend));
    },
    track<T extends { stop(closeActiveConnections?: boolean): void | Promise<void> }>(server: T): T {
      // Capture the raw stop before startServer replaces the public method with full teardown.
      const stop = server.stop.bind(server);
      failedStartStops.push(() => { try { void stop(true); } catch { /* preserve startup failure */ } });
      return server;
    },
    release,
    releaseAfterFailedStart(): void {
      for (const stop of failedStartStops.reverse()) stop();
      release();
    },
  };
}
