import { lstatSync } from "node:fs";
import { isMissingPathError } from "../config/atomic-write";
import { readClientLinkState, childLinkMarkerPath, isChildInitiatedLink } from "./link-state";
import type { ClientLinkIdentity } from "../link/status-projection";
import type { LinkStatusDto } from "../link/status-projection";
import type { ClientLinkState } from "./link-state";
import type { ClientLinkSupervisorStatus } from "./link-tunnel";
import { EMPTY_LINK_CHILD_PARITY } from "../link/child-parity";
import type { OcxClientConnectionConfig } from "../types";

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
    // The keyed probe's finding (the Home refused the key, did not answer, or reports its own
    // readiness as not ready) names the cause better than the tunnel state, so it wins; otherwise
    // a failed tunnel shows its own reason.
    reason: supervisor.probe ?? (tunnel.kind === "failed" ? tunnel.reason : null),
  };
}

/**
 * The connected Child's own link as a status row, for `?traffic=1` (#3023), which attaches its
 * counters to it. Only a Child-initiated link writes a sidecar, so:
 * - a sidecar for this link names the SSH alias, the direction and the tunnel state;
 * - an unreadable sidecar, or one naming another link, leaves the alias unknown and the row failed
 *   (`sidecar_invalid`, `sidecar_mismatch`);
 * - no sidecar while the durable Child-initiated marker names this link (or cannot be read) is a
 *   lost sidecar: failed (`sidecar_missing`), alias unknown;
 * - otherwise no sidecar is a Home-initiated link, which owns no tunnel here and reads idle since it
 *   connected, as the management projection reads it.
 * Parity fields are the Home's view and stay empty.
 */
export function projectClientLinkRow(
  connection: Pick<OcxClientConnectionConfig, "serverUrl" | "connectedAt"> & { link: { linkId: string; tunnelPort: number } },
  sidecar: ClientLinkSidecarRead,
  child: LinkStatusDto["child"],
  now: number,
  childInitiated: (linkId: string) => boolean = (linkId: string) => isChildInitiatedLink(linkId),
  /** The Home's recorded name for a Home-initiated row; never the loopback URL this Child connects to. */
  homeName: string | null = null,
): LinkStatusDto["links"][number] {
  const base = { id: connection.link.linkId, tunnelPort: connection.link.tunnelPort, ...EMPTY_LINK_CHILD_PARITY };
  if (sidecar === null && childInitiated(connection.link.linkId)) {
    return { ...base, alias: "unknown", direction: "client-initiated", state: "failed", since: new Date(now).toISOString(), reason: "sidecar_missing" };
  }
  if (sidecar === null) {
    return { ...base, alias: homeName ?? "unknown", direction: "hub-initiated", state: "idle", since: connection.connectedAt, reason: null };
  }
  if (sidecar === "invalid" || sidecar.linkId !== connection.link.linkId) {
    const reason = sidecar === "invalid" ? "sidecar_invalid" : "sidecar_mismatch";
    return { ...base, alias: "unknown", direction: "client-initiated", state: "failed", since: new Date(now).toISOString(), reason };
  }
  const state = child ?? { state: "idle" as const, since: new Date(now).toISOString(), reason: null };
  return { ...base, alias: sidecar.alias, direction: "client-initiated", state: state.state, since: state.since, reason: state.reason };
}

/** Only client-owned evidence can establish who owns the tunnel. Unreadable evidence stays unknown. */
export function clientLinkStatusIdentity(linkId: string): ClientLinkIdentity | null {
  try {
    const sidecar = readClientLinkState();
    if (sidecar) return sidecar.linkId === linkId ? { direction: "client-initiated", alias: sidecar.alias } : null;
    try { lstatSync(childLinkMarkerPath()); return null; }
    catch (error) { return isMissingPathError(error) ? { direction: "hub-initiated" } : null; }
  } catch { return null; }
}
