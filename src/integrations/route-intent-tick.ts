import type { OcxClientConnectionConfig } from "../types";

export interface RouteIntentTickDeps {
  sync?: () => Promise<unknown>;
  onApplied?: () => void | Promise<void>;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}
export interface RouteIntentTick { stop(): void; requestSync(): Promise<unknown> }

/** Periodic and Home-requested applies share one queue and the existing sync ownership fences. */
export function startRouteIntentTick(connection: OcxClientConnectionConfig, deps: RouteIntentTickDeps = {}): RouteIntentTick {
  if (connection.transport !== "link" || !connection.link) return { stop() {}, requestSync: async () => { throw new Error("not_a_link_child"); } };
  const linkId = connection.link.linkId;
  const sync = deps.sync ?? (async () => {
    const { syncConnectedClient } = await import("../client/connect");
    return syncConnectedClient({ expect: { kind: "link", linkId } });
  });
  const set = deps.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; });
  const clear = deps.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false, running = false, queued = false;
  let timer: unknown;
  const waiters: Array<{ resolve: (result: unknown) => void; reject: (error: unknown) => void }> = [];
  const schedule = (ms: number) => {
    if (!stopped) timer = set(() => { timer = undefined; queued = true; void drain(); }, ms);
  };
  const drain = async () => {
    if (stopped || running) return;
    running = true;
    let delay = 60_000;
    try {
      do {
        queued = false;
        const batch = waiters.splice(0);
        try {
          const result = await sync();
          await deps.onApplied?.();
          for (const waiter of batch) waiter.resolve(result);
          delay = 60_000;
        } catch (error) {
          for (const waiter of batch) waiter.reject(error);
          delay = 5_000;
        }
      } while (queued && !stopped);
    } finally { running = false; schedule(delay); }
  };
  schedule(2_000);
  return {
    requestSync() {
      if (stopped) return Promise.reject(new Error("client_runtime_stopping"));
      if (timer !== undefined) clear(timer);
      timer = undefined;
      queued = true;
      const result = new Promise<unknown>((resolve, reject) => waiters.push({ resolve, reject }));
      void drain();
      return result;
    },
    stop() {
      stopped = true; queued = false;
      if (timer !== undefined) clear(timer);
      timer = undefined;
      for (const waiter of waiters.splice(0)) waiter.reject(new Error("client_runtime_stopping"));
    },
  };
}
