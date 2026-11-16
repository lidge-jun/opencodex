import { lookup } from "node:dns/promises";
import { isPreConnectReachabilityError } from "./upstream-reachability";

/** Longest configurable offline wait (#7958): five minutes, the span of a laptop sleep/Wi-Fi hop. */
export const MAX_OFFLINE_RESEND_WAIT_SEC = 300;
/** Interval between reachability probes while offline. */
export const OFFLINE_REACHABILITY_PROBE_INTERVAL_MS = 1_000;

/**
 * Decides, at most once per logical request, whether a pre-connect failure may be resent after
 * the destination became reachable again. Returns false for every later call.
 */
export type OfflineResendWait = (error: unknown, signal?: AbortSignal) => Promise<boolean>;

export interface OfflineResendDependencies {
  /** Resolves when the host resolves; rejects while it does not. */
  resolveHost?: (hostname: string) => Promise<unknown>;
  /** Abortable delay between probes. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

let testDependencies: OfflineResendDependencies | undefined;

/** Test-only seam for the DNS probe, delay and clock; `undefined` restores the real ones. */
export function setOfflineResendDependenciesForTests(dependencies: OfflineResendDependencies | undefined): void {
  testDependencies = dependencies;
}

/** The configured wait in milliseconds, or 0 when the opt-in is off or malformed. */
export function resolveOfflineResendWaitMs(configuredSec: unknown): number {
  if (typeof configuredSec !== "number" || !Number.isFinite(configuredSec) || configuredSec <= 0) return 0;
  return Math.ceil(Math.min(configuredSec, MAX_OFFLINE_RESEND_WAIT_SEC) * 1_000);
}

/**
 * Opt-in offline wait for one request (#7958). After a send fails before any byte reached the
 * origin (DNS failure, network unreachable, connection refused; see `isPreConnectReachabilityError`),
 * poll the destination's DNS until it resolves or `maxWaitMs` passes, then allow one resend.
 * Nothing was delivered, so the resend cannot repeat an upstream effect; the caller's send budget
 * still counts it. A rejection that is not pre-connect, a second failure, an exhausted wait or a
 * client abort returns the original failure.
 */
export function createOfflineResendWait(url: string, maxWaitMs: number): OfflineResendWait | undefined {
  if (!(maxWaitMs > 0)) return undefined;
  let hostname: string;
  try { hostname = new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { return undefined; }
  let claimed = false;
  return async (error, signal) => {
    if (claimed || !isPreConnectReachabilityError(error)) return false;
    claimed = true;
    const deps = testDependencies ?? {};
    const resolveHost = deps.resolveHost ?? ((host: string) => lookup(host));
    const delay = deps.delay ?? abortableDelay;
    const now = deps.now ?? Date.now;
    const deadline = now() + maxWaitMs;
    for (;;) {
      signal?.throwIfAborted();
      try {
        await resolveHost(hostname);
        return true;
      } catch { /* still offline */ }
      const remaining = deadline - now();
      if (remaining <= 0) return false;
      await delay(Math.min(OFFLINE_REACHABILITY_PROBE_INTERVAL_MS, remaining), signal);
    }
  };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
