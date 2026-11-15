/** Ephemeral Home wakeups. The admitted link id, never a caller selector, owns each slot. */
export const ROUTE_INTENT_WATCH_HEADER = "x-ocx-route-intent-watch";
export const ROUTE_INTENT_AFTER_HEADER = "x-ocx-route-intent-after";
export const ROUTE_INTENT_WAKE_HEADER = "x-ocx-route-intent-wake";
export const ROUTE_INTENT_WATCH_TIMEOUT_MS = 30_000;
export const ROUTE_INTENT_WATCH_MAX_LINKS = 256;
export type RouteIntentWake = "notified" | "timeout" | "cancelled" | "busy";

export class RouteIntentWatch {
  private readonly waiters = new Map<string, (reason: RouteIntentWake) => void>();
  constructor(private readonly timeoutMs = ROUTE_INTENT_WATCH_TIMEOUT_MS, private readonly maxLinks = ROUTE_INTENT_WATCH_MAX_LINKS) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ROUTE_INTENT_WATCH_TIMEOUT_MS
      || !Number.isInteger(maxLinks) || maxLinks < 1 || maxLinks > ROUTE_INTENT_WATCH_MAX_LINKS) throw new RangeError("invalid route intent watch bounds");
  }
  get size(): number { return this.waiters.size; }
  wait(linkId: string, signal: AbortSignal): Promise<RouteIntentWake> {
    if (signal.aborted) return Promise.resolve("cancelled");
    if (this.waiters.has(linkId) || this.waiters.size >= this.maxLinks) return Promise.resolve("busy");
    return new Promise(resolve => {
      const finish = (reason: RouteIntentWake) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.waiters.delete(linkId);
        resolve(reason);
      };
      const abort = () => finish("cancelled");
      const timer = setTimeout(() => finish("timeout"), this.timeoutMs);
      timer.unref();
      this.waiters.set(linkId, finish);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  /** False means no active watcher accepted the request; it is never an apply acknowledgment. */
  notify(linkId: string): boolean {
    const wake = this.waiters.get(linkId);
    wake?.("notified");
    return wake !== undefined;
  }
}
export const homeRouteIntentWatch = new RouteIntentWatch();
