import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { UpstreamRetryEvidenceError } from "./upstream-retry";

/** Longest configurable offline wait (#7958): five minutes, the span of a laptop sleep/Wi-Fi hop. */
export const MAX_OFFLINE_RESEND_WAIT_SEC = 300;
/** Interval between reachability probes while offline. */
export const OFFLINE_REACHABILITY_PROBE_INTERVAL_MS = 1_000;

/**
 * Only a DNS resolution failure qualifies (#7958): DNS answering again is exactly the evidence that
 * failure lacked. A refused or unreachable connection would resend into the same failure, and with
 * an outbound proxy a direct reachability probe would not test the path the request takes.
 */
const DNS_FAILURE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const MAX_CAUSE_DEPTH = 3;

/** A DNS resolution failure, read from `code` through a bounded cause chain; never from message text. */
export function isDnsResolutionFailure(error: unknown): boolean {
  let current: unknown = error instanceof UpstreamRetryEvidenceError ? undefined : error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && DNS_FAILURE_CODES.has(code)) return true;
    current = current.cause;
  }
  return false;
}

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
  /** Abortable timer that ends a probe still pending when the wait runs out. */
  expire?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
 * Opt-in offline wait for one request (#7958). After a send fails because the destination's name
 * did not resolve (`isDnsResolutionFailure`), poll its DNS until it resolves or `maxWaitMs` passes,
 * then allow one resend. An IP-literal destination never qualifies: DNS proves nothing about it.
 * Nothing was delivered, so the resend cannot repeat an upstream effect; the caller's send budget
 * still counts it. A rejection that is not pre-connect, a second failure, an exhausted wait or a
 * client abort returns the original failure.
 */
export function createOfflineResendWait(url: string, maxWaitMs: number): OfflineResendWait | undefined {
  if (!(maxWaitMs > 0)) return undefined;
  let hostname: string;
  try { hostname = new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { return undefined; }
  if (isIP(hostname) !== 0) return undefined;
  let claimed = false;
  return async (error, signal) => {
    if (claimed || !isDnsResolutionFailure(error)) return false;
    claimed = true;
    const deps = testDependencies ?? {};
    const resolveHost = deps.resolveHost ?? ((host: string) => lookup(host));
    const delay = deps.delay ?? abortableDelay;
    const expire = deps.expire ?? abortableDelay;
    const now = deps.now ?? Date.now;
    const deadline = now() + maxWaitMs;
    for (;;) {
      signal?.throwIfAborted();
      let remaining = deadline - now();
      if (remaining <= 0) return false;
      // A stalled system resolver must not outlive the wait or the client: race each probe against
      // the remaining budget and cancellation, and accept a success only inside the budget.
      const settle = new AbortController();
      const raceSignal = signal ? AbortSignal.any([signal, settle.signal]) : settle.signal;
      const expiry = expire(remaining, raceSignal).then(() => "expired" as const);
      let outcome: boolean | "expired";
      try {
        outcome = await Promise.race([resolveHost(hostname).then(() => true, () => false), expiry]);
      } finally {
        settle.abort();
        expiry.catch(() => { /* cancelled with the race */ });
      }
      if (outcome === "expired") return false;
      if (outcome) return now() <= deadline;
      remaining = deadline - now();
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
