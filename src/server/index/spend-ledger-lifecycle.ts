import type { OcxSpendConfig } from "../../types/config";
import {
  acquireSpendLedgerOwner,
  type SpendLedgerOwnerLease,
} from "../../lib/spend-ledger-owner";
import {
  configureSharedSpendLedger,
  spendPolicyFromConfig,
} from "../../lib/spend-reservation-ledger";

const failedStartRollbacks = new WeakMap<object, Promise<void>>();

export function recordFailedStartRollback(error: unknown, rollback: Promise<void>): void {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    failedStartRollbacks.set(error, rollback);
  }
}

/** Keep an outer ownership lease until a synchronous start failure has closed every listener. */
export function waitForFailedStartRollback(error: unknown): Promise<void> {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    return failedStartRollbacks.get(error) ?? Promise.resolve();
  }
  return Promise.resolve();
}

export interface SpendLedgerServerLifecycle {
  configure(spend: OcxSpendConfig | undefined): void;
  track<T extends { stop(closeActiveConnections?: boolean): void | Promise<void> }>(server: T): T;
  release(): void;
  releaseAfterFailedStart(): Promise<void>;
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
    releaseAfterFailedStart(): Promise<void> {
      // Every listener that came up is stopped, newest first, and the lease is held until those
      // stops have actually SETTLED. Bun's Server.stop(true) returns a promise that resolves
      // once connections are closed, so discarding it handed the state directory back while a
      // listener could still be serving, which is the one thing single-writer ownership exists
      // to prevent.
      //
      // Listener shutdown starts synchronously, while the returned promise lets a caller that
      // owns a broader mutation lease keep it until every close has settled. startServer itself
      // remains synchronous. Rollback failures are reported beside the startup error by the
      // outer ownership transaction, without claiming the listener is gone.
      const settling: Promise<unknown>[] = [];
      const failures: unknown[] = [];
      for (const stop of failedStartStops.splice(0).reverse()) {
        try {
          const pending = stop();
          if (pending !== undefined) settling.push(Promise.resolve(pending));
        } catch (failure) { failures.push(failure); }
      }
      const finish = (): void => {
        try { release(); } catch { /* same: the startup error is the one that matters */ }
      };
      if (settling.length === 0) {
        if (failures.length > 0) return Promise.reject(new AggregateError(failures, "failed-start listener rollback was uncertain"));
        finish();
        return Promise.resolve();
      }
      return Promise.allSettled(settling).then(results => {
        for (const result of results) if (result.status === "rejected") failures.push(result.reason);
        if (failures.length > 0) throw new AggregateError(failures, "failed-start listener rollback was uncertain");
        finish();
      });
    },
  };
}
