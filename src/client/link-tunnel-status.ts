/**
 * Whether this Remote Link Child's tunnel can carry a request right now, for `ocx connect status`.
 *
 * The durable connection record says only that this machine was linked. A Home-initiated tunnel
 * drops whenever the Child sleeps, and `Connection: connected` kept reading healthy while every
 * relayed request failed with 503 home_unreachable (#8470). The running Child already computes the
 * verdict for its own /readyz (`src/client/link-readiness.ts`, served by the machine listener), so
 * this asks it instead of probing the tunnel a second time. The answer is a fixed word: nothing a
 * listener sends beyond LINK_READINESS_REASONS reaches the terminal.
 */
import { LINK_RELAY_AUTH_TIMEOUT_MS } from "../link/relay-auth";
import { directLocalHttpFetch } from "../server/direct-local-http";
import { findLiveProxy, probeHostname, validateReadyzBody, type LiveProxy } from "../server/proxy-liveness";
import { isLinkReadinessReason, type LinkReadinessReason } from "./link-readiness";

export type LinkTunnelStatus =
  | { state: "up" }
  | { state: "down"; reason: LinkReadinessReason }
  | { state: "unknown"; reason: "runtime_not_running" | "runtime_unreadable" | "link_unverified" };

export interface LinkTunnelStatusDeps {
  findLive?: () => Promise<LiveProxy | null>;
  fetchImpl?: typeof fetch;
  /** Resolves after `ms`; the wait for a relay preflight the runtime has not finished yet. */
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * /readyz answers `link_unverified` when its preflight is still running after its 500 ms wait. That
 * preflight ends within LINK_RELAY_AUTH_TIMEOUT_MS of this read's start, no earlier than 500 ms in,
 * and its verdict is reused for LINK_READINESS_TTL_MS (5 s). One more read timed from the FIRST
 * read's start lands after the preflight can finish and inside the cached verdict: anywhere in
 * [start + 5000, start + 5500] works, so this aims at the middle. Timing it from the first read's
 * return instead could miss the cache and start a second Home probe (#8496 review).
 */
const SECOND_READ_AFTER_START_MS = LINK_RELAY_AUTH_TIMEOUT_MS + 250;
const READ_TIMEOUT_MS = 2_000;

export async function probeLinkTunnelStatus(deps: LinkTunnelStatusDeps = {}): Promise<LinkTunnelStatus> {
  let live: LiveProxy | null;
  try { live = await (deps.findLive ?? findLiveProxy)(); } catch { live = null; }
  // Only the Child's machine listener reports a link verdict; anything else on the port cannot.
  if (!live || live.role !== "client") return { state: "unknown", reason: "runtime_not_running" };
  const target = live;
  const fetchImpl = deps.fetchImpl ?? directLocalHttpFetch;
  const read = async (): Promise<LinkTunnelStatus> => {
    try {
      const host = target.probeHostname ? probeHostname(target.probeHostname) : probeHostname(target.hostname);
      const response = await fetchImpl(`http://${host}:${target.port}/readyz`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      const parsed = validateReadyzBody(body, target.port, target.pid ? { expectedPid: target.pid } : {});
      const link = parsed ? (body as { link?: unknown }).link : undefined;
      if (!parsed || !link || typeof link !== "object") return { state: "unknown", reason: "runtime_unreadable" };
      const { state, reason } = link as { state?: unknown; reason?: unknown };
      if (state === "available" && parsed.status === "ready" && response.status === 200) return { state: "up" };
      if (state === "unavailable" && response.status === 503 && isLinkReadinessReason(reason)) return { state: "down", reason };
      return { state: "unknown", reason: "runtime_unreadable" };
    } catch {
      return { state: "unknown", reason: "runtime_unreadable" };
    }
  };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const first = await read();
  if (first.state !== "down" || first.reason !== "link_unverified") return first;
  const wait = Math.max(0, startedAt + SECOND_READ_AFTER_START_MS - now());
  await (deps.delay ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(wait);
  const second = await read();
  return second.state === "down" && second.reason === "link_unverified"
    ? { state: "unknown", reason: "link_unverified" }
    : second;
}
