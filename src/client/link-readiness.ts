/**
 * Whether a Remote Link Child can serve relayed requests right now, for its `GET /readyz`.
 *
 * `/healthz` keeps meaning "this process answers". A Child whose tunnel is down still answers it,
 * yet every relayed turn fails with 503, so readiness is where that shows: not ready, with one
 * fixed reason word. Nothing here carries ssh output, host names, ports or keys.
 *
 * - A Child-initiated link reads its own tunnel supervisor; no network traffic.
 * - A Home-initiated link has no local tunnel to inspect (the Home runs `ssh -R`), so it runs
 *   the credential-free relay preflight through the tunnel port. One preflight runs at a time, a
 *   verdict is reused for `LINK_READINESS_TTL_MS`, and a request waits at most
 *   `LINK_READINESS_WAIT_MS` for a running preflight before it answers `link_unverified`. An
 *   unauthenticated caller can therefore cause at most one preflight per TTL.
 */
import { LINK_RELAY_AUTH_TIMEOUT_MS } from "../link/relay-auth";
import { isLinkPort } from "../link/ports";
import { probeLinkRelayPreflight, type BoundLinkRelayTarget, type LinkRelayPreflightResult } from "./link-relay-transport";
import type { ClientLinkSupervisorStatus } from "./link-tunnel";

export type LinkReadinessReason =
  | "tunnel_idle" | "tunnel_connecting" | "tunnel_failed" | "tunnel_unavailable" | "sidecar_invalid"
  | "home_unreachable" | "home_unauthorized" | "link_auth_failed" | "link_credential_unavailable"
  | "link_unverified";

export type LinkReadiness = { ready: true } | { ready: false; reason: LinkReadinessReason };

export const LINK_READINESS_TTL_MS = 5_000;
export const LINK_READINESS_WAIT_MS = 500;

const READY: LinkReadiness = { ready: true };
const notReady = (reason: LinkReadinessReason): LinkReadiness => ({ ready: false, reason });

/**
 * A Child-initiated link from its supervisor. The keyed probe the supervisor runs every 30 seconds
 * while connected is display-only for the tunnel, but a Home that stopped answering or refuses the
 * key cannot serve a turn, so readiness follows it. A Home whose own startup readiness is pending
 * still serves relayed requests (the probe's `home_not_ready`), so that reads ready.
 */
export function clientInitiatedLinkReadiness(status: ClientLinkSupervisorStatus): LinkReadiness {
  if (status.kind === "failed") return notReady("sidecar_invalid");
  if (status.kind === "stopped") return notReady("tunnel_idle");
  const { state, probe } = status;
  if (state.kind === "connected") {
    if (probe === "home_unreachable") return notReady("home_unreachable");
    if (probe === "unauthorized") return notReady("home_unauthorized");
    return READY;
  }
  if (state.kind === "connecting" || state.kind === "reconnecting") return notReady("tunnel_connecting");
  if (state.kind === "failed") return notReady(state.inFlight ? "tunnel_connecting" : "tunnel_failed");
  return notReady("tunnel_idle");
}

function fromPreflight(result: LinkRelayPreflightResult): LinkReadiness {
  if (result === "ok") return READY;
  return notReady(result === "unreachable" ? "home_unreachable" : "link_auth_failed");
}

export interface HomeInitiatedLinkReadinessDeps {
  target: Omit<BoundLinkRelayTarget, "admissionKey">;
  linkKey: () => string | null;
  probe?: (target: BoundLinkRelayTarget, options: { timeoutMs: number }) => Promise<LinkRelayPreflightResult>;
  now?: () => number;
  /** Resolves after `ms`; the wait for a running preflight. */
  delay?: (ms: number) => Promise<void>;
}

/** The readiness of a Home-initiated link, from a shared, rate-limited relay preflight. */
export function createHomeInitiatedLinkReadiness(deps: HomeInitiatedLinkReadinessDeps): () => Promise<LinkReadiness> {
  const probe = deps.probe ?? probeLinkRelayPreflight;
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? (ms => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  }));
  let last: { at: number; verdict: LinkReadiness } | undefined;
  let flight: Promise<LinkReadiness> | undefined;
  const run = (admissionKey: string): Promise<LinkReadiness> => {
    flight ??= probe({ ...deps.target, admissionKey }, { timeoutMs: LINK_RELAY_AUTH_TIMEOUT_MS })
      .then(fromPreflight, () => notReady("home_unreachable"))
      .then(verdict => {
        last = { at: now(), verdict };
        return verdict;
      })
      .finally(() => { flight = undefined; });
    return flight;
  };
  return async () => {
    if (!isLinkPort(deps.target.tunnelPort)) return notReady("tunnel_unavailable");
    let admissionKey: string | null;
    try { admissionKey = deps.linkKey(); } catch { admissionKey = null; }
    if (!admissionKey) return notReady("link_credential_unavailable");
    const at = now();
    if (last && at >= last.at && at - last.at < LINK_READINESS_TTL_MS) return last.verdict;
    const unverified = notReady("link_unverified");
    return await Promise.race([run(admissionKey), delay(LINK_READINESS_WAIT_MS).then(() => unverified)]);
  };
}
