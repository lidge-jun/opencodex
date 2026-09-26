import type { LinkStatusDto } from "../link/status-projection";
import type { ClientLinkState } from "./link-state";
import type { ClientLinkSupervisorStatus } from "./link-tunnel";

/** What the status route read from the client sidecar: the state, none, or an unreadable file. */
export type ClientLinkSidecarRead = ClientLinkState | null | "invalid";

/**
 * The K16 status document of a connected Child, built from its own sidecar and tunnel
 * supervisor. A client-initiated Child has no `links.json` record, so the Home-side projection
 * (`projectLinkStatus`) cannot describe it; this one runs in the Child's own listener instead.
 * A Home-initiated Child has no sidecar and reports `child: null`.
 */
export function projectClientLinkChild(
  sidecar: ClientLinkSidecarRead,
  supervisor: ClientLinkSupervisorStatus,
  now: number,
): LinkStatusDto {
  return { role: "child", listener: { state: "off", port: null }, links: [], child: childState(sidecar, supervisor, now) };
}

function childState(sidecar: ClientLinkSidecarRead, supervisor: ClientLinkSupervisorStatus, now: number): LinkStatusDto["child"] {
  const alias = sidecar && sidecar !== "invalid" ? sidecar.alias : "unknown";
  if (sidecar === "invalid" || supervisor.kind === "failed") {
    return { alias, state: "failed", since: new Date(now).toISOString(), reason: "sidecar_invalid" };
  }
  if (!sidecar) return null;
  if (supervisor.kind === "stopped") return { alias, state: "idle", since: new Date(now).toISOString(), reason: null };
  const tunnel = supervisor.state;
  return {
    alias,
    state: tunnel.kind,
    since: new Date(tunnel.kind === "idle" ? now : tunnel.since).toISOString(),
    reason: tunnel.kind === "failed" ? tunnel.reason : null,
  };
}
