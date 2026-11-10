import type { ApiTargets } from "./api-targets";

export interface TargetDiscoveryDeps {
  initialBase: string;
  discover: (initialBase: string, signal: AbortSignal) => Promise<ApiTargets>;
  configure: (targets: ApiTargets) => void;
  bootstrap: (plane: "shared", signal: AbortSignal) => Promise<unknown>;
  hasSession: (plane: "shared") => boolean;
  onTargets: (targets: ApiTargets) => void;
  onSessionReady: (ready: boolean) => void;
  onError: (error: "unavailable" | "client-state-changed" | null) => void;
  onSettled: (settled: boolean) => void;
  isClientStateChanged: (error: unknown) => boolean;
}

/**
 * One in-flight discovery at a time. Event bursts coalesce into one follow-up read,
 * and a same-target refresh never schedules itself recursively.
 */
export function createTargetDiscovery(deps: TargetDiscoveryDeps): { refresh: () => Promise<void>; dispose: () => void } {
  let inFlight: Promise<void> | null = null;
  let pending = false;
  let disposed = false;

  const refresh = (): Promise<void> => {
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    const run = async () => {
      const controller = new AbortController();
      try {
        const next = await deps.discover(deps.initialBase, controller.signal);
        if (disposed || controller.signal.aborted) return;
        deps.configure(next);
        deps.onTargets(next);
        if (next.connected && !deps.hasSession("shared")) {
          await deps.bootstrap("shared", controller.signal);
        }
        if (disposed || controller.signal.aborted) return;
        deps.onSessionReady(deps.hasSession("shared"));
        deps.onError(null);
        deps.onSettled(true);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        deps.onError(deps.isClientStateChanged(error) ? "client-state-changed" : "unavailable");
        deps.onSettled(true);
      }
    };
    const promise = run().finally(() => {
      inFlight = null;
      if (pending && !disposed) {
        pending = false;
        void refresh();
      }
    });
    inFlight = promise;
    return promise;
  };

  return { refresh, dispose: () => { disposed = true; } };
}
