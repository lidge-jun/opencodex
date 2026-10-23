import type { LinkStore } from "./store";
import type { LinkTunnelStatus } from "./supervisor";
import type { TunnelState } from "./tunnel-state";
import { readCompensation, type CompensationStore } from "./compensation";
import { EMPTY_LINK_CHILD_PARITY, type LinkChildParity } from "./child-parity";
import { linkPeerStatus, type LinkLocalPeer, type LinkPeerStatus } from "./compatibility";
import type { LinkPeerEntry } from "./peer-report";
import type { OcxClientConnectionConfig } from "../types";

export type LinkWireState = "connecting" | "connected" | "reconnecting" | "failed" | "idle";

export interface LinkStatusDto {
  role: "standalone" | "home" | "child";
  listener: { state: "off" | "listening" | "failed"; port: number | null };
  links: Array<LinkChildParity & {
    id: string;
    alias: string;
    direction: "hub-initiated" | "client-initiated";
    state: LinkWireState;
    since: string;
    reason: string | null;
    tunnelPort: number;
    /** Home only: what the link carried from this Child, and the compatibility verdict. */
    peer?: LinkPeerStatus;
    /** Home-initiated links on request (`?diagnostics=1`): retry progress and the last failure. */
    tunnel?: LinkTunnelDiagnostics;
  }>;
  child: null | {
    alias: string;
    state: LinkWireState;
    since: string;
    reason: string | null;
  };
  /** This build's version and link protocol, the side every `peer` verdict compares against. */
  local?: LinkLocalPeer;
}

/**
 * The Home's account of one `-R` tunnel: ssh attempts since it was last connected, when the next
 * one is due (null while one runs or none is scheduled), the last state change and the last
 * failure. `cause` is a fixed word from `tunnel-history.ts`, never ssh output.
 */
export interface LinkTunnelDiagnostics {
  attempt: number;
  nextRetryAt: string | null;
  lastTransition: { from: LinkWireState; to: LinkWireState; at: string; cause: string | null } | null;
  lastFailure: { cause: string; at: string } | null;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** Add `tunnel` to each Home-initiated link the supervisor reports. */
export function attachLinkTunnelDiagnostics(dto: LinkStatusDto, supervisorStates: readonly LinkTunnelStatus[]): LinkStatusDto {
  const byId = new Map(supervisorStates.map(status => [status.linkId, status]));
  for (const link of dto.links) {
    const status = byId.get(link.id);
    if (!status || status.direction !== "hub-initiated") continue;
    const { state, history } = status;
    const due = (state.kind === "failed" || state.kind === "reconnecting") && state.retryAt !== undefined && state.inFlight !== true
      ? state.retryAt : null;
    link.tunnel = {
      attempt: history?.attempt ?? 0,
      nextRetryAt: due === null ? null : iso(due),
      lastTransition: history?.lastTransition
        ? { from: history.lastTransition.from, to: history.lastTransition.to, at: iso(history.lastTransition.at), cause: history.lastTransition.cause }
        : null,
      lastFailure: history?.lastFailure ? { cause: history.lastFailure.cause, at: iso(history.lastFailure.at) } : null,
    };
  }
  return dto;
}

/** Add this build's identity and, on a Home, each Child's observed peer status. */
export function attachLinkPeers(dto: LinkStatusDto, local: LinkLocalPeer, observation: (linkId: string) => LinkPeerEntry): LinkStatusDto {
  if (dto.role === "home") {
    for (const link of dto.links) link.peer = linkPeerStatus(local, observation(link.id));
  }
  dto.local = local;
  return dto;
}

export interface ClientLinkIdentity { direction: "hub-initiated" | "client-initiated"; alias?: string }

export interface LinkListenerStatusProjection {
  state: "off" | "listening" | "failed";
  port: number | null;
}

export interface LinkStatusConfig {
  runtimeRole?: "standalone" | "hub" | "client";
  client?: Pick<OcxClientConnectionConfig, "transport" | "link" | "serverUrl" | "connectedAt">;
}

function asWireState(state: TunnelState | "client-owned"): LinkWireState {
  if (state === "client-owned") return "idle";
  return state.kind;
}

function stateDetails(
  record: LinkStore["links"][number],
  status: LinkTunnelStatus | undefined,
  compensation?: CompensationStore,
): { state: LinkWireState; since: string; reason: string | null } {
  const failure = compensation?.entries[record.id];
  if (failure) return { state: "failed", since: failure.since, reason: failure.reason };
  if (!status || status.state === "client-owned") {
    return { state: "idle", since: record.createdAt, reason: null };
  }
  if (status.orphan === "orphan-unverified") {
    return { state: "failed", since: record.createdAt, reason: "stale tunnel may hold the port" };
  }
  const tunnel = status.state;
  const reason = tunnel.kind === "failed" ? tunnel.reason : null;
  const since = tunnel.kind === "idle" ? record.createdAt : new Date(tunnel.since).toISOString();
  return { state: asWireState(tunnel), since, reason };
}

/**
 * Project private link state into the exact K16 wire DTO. `clientChild` lets a client-side caller
 * report a child state this module cannot read itself (including an invalid client sidecar); link code
 * stays free of client imports, so the caller supplies it.
 */
export function projectLinkStatus(
  store: LinkStore,
  supervisorStates: readonly LinkTunnelStatus[],
  listenerStatus: LinkListenerStatusProjection,
  config: LinkStatusConfig,
  compensation: CompensationStore = readCompensation(),
  clientChild: LinkStatusDto["child"] = null,
  identity: ClientLinkIdentity | null = null,
  /** The Home's view of each Child's last apply (OCX-6); every field is null without a report. */
  parity: (linkId: string) => LinkChildParity = () => EMPTY_LINK_CHILD_PARITY,
): LinkStatusDto {
  const byId = new Map(supervisorStates.map(status => [status.linkId, status]));
  const links = store.links.map(record => ({
    id: record.id,
    alias: record.alias,
    direction: record.direction,
    ...stateDetails(record, byId.get(record.id), compensation),
    tunnelPort: record.tunnelPort,
    ...parity(record.id),
  }));
  const childRecord = config.runtimeRole === "client"
    ? (config.client?.transport === "link" ? store.links.find(record => record.id === config.client?.link?.linkId) : store.links[0])
    : undefined;
  const projectedClientChild = config.runtimeRole === "client" ? clientChild : null;
  const childStatus = childRecord
    ? stateDetails(childRecord, byId.get(childRecord.id), compensation)
    : undefined;
  const role = config.runtimeRole === "client"
    ? "child"
    : store.links.length > 0 ? "home" : "standalone";
  // Home owns the record and reverse SSH process. The Child's persisted connection supplies
  // identity and port, while an optional caller observation supplies live tunnel state.
  const client = config.runtimeRole === "client" && config.client?.transport === "link" ? config.client : undefined;
  const child = projectedClientChild ?? (childRecord && childStatus ? { alias: childRecord.alias, ...childStatus }
    : client?.link ? { alias: identity?.alias ?? client.serverUrl, state: "idle" as const, since: client.connectedAt, reason: null } : null);
  if (client?.link && child && identity) {
    const active = links.find(link => link.id === client.link!.linkId);
    const projected = {
      id: client.link.linkId, direction: identity.direction, tunnelPort: client.link.tunnelPort, ...child, alias: identity.alias ?? child.alias,
      ...parity(client.link.linkId),
    };
    if (active) Object.assign(active, projected, compensation.entries[active.id] && childRecord ? stateDetails(childRecord, byId.get(active.id), compensation) : {});
    else links.push(projected);
  }
  return {
    role,
    listener: { state: listenerStatus.state, port: listenerStatus.port },
    links,
    child,
  };
}
