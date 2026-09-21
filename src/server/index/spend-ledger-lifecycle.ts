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
  // Each entry returns whatever the listener's own stop returned. Typed as void-or-promise
  // because the rollback below has to WAIT on it: declaring it `() => void` let the call site
  // compile while statically erasing the promise it needs to await.
  const failedStartStops: Array<() => void | Promise<void>> = [];
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
      failedStartStops.push(() => stop(true));
      return server;
    },
    release,
    releaseAfterFailedStart(): void {
      // Every listener that came up is stopped, newest first, and the lease is held until those
      // stops have actually SETTLED. Bun's Server.stop(true) returns a promise that resolves
      // once connections are closed, so discarding it handed the state directory back while a
      // listener could still be serving, which is the one thing single-writer ownership exists
      // to prevent.
      //
      // This stays synchronous and returns void on purpose: startServer must not become async,
      // so the wait is a continuation rather than an await. Rollback failures are contained
      // because the startup error that brought us here is the one worth reporting.
      const settling: Promise<unknown>[] = [];
      for (const stop of failedStartStops.splice(0).reverse()) {
        try {
          const pending = stop();
          if (pending !== undefined) settling.push(Promise.resolve(pending));
        } catch { /* a rollback failure must not replace the startup error that caused it */ }
      }
      const finish = (): void => {
        try { release(); } catch { /* same: the startup error is the one that matters */ }
      };
      if (settling.length === 0) { finish(); return; }
      void Promise.allSettled(settling).then(finish);
    },
  };
}
