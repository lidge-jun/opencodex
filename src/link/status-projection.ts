import type { LinkStore } from "./store";
import type { LinkTunnelStatus } from "./supervisor";
import type { TunnelState } from "./tunnel-state";
import { readCompensation, type CompensationStore } from "./compensation";

export type LinkWireState = "connecting" | "connected" | "reconnecting" | "failed" | "idle";

export interface LinkStatusDto {
  role: "standalone" | "home" | "child";
  listener: { state: "off" | "listening" | "failed"; port: number | null };
  links: Array<{
    id: string;
    alias: string;
    direction: "hub-initiated" | "client-initiated";
    state: LinkWireState;
    since: string;
    reason: string | null;
    tunnelPort: number;
  }>;
  child: null | {
    alias: string;
    state: LinkWireState;
    since: string;
    reason: string | null;
  };
}

export interface LinkListenerStatusProjection {
  state: "off" | "listening" | "failed";
  port: number | null;
}

export interface LinkStatusConfig {
  runtimeRole?: "standalone" | "hub" | "client";
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
 * report a child state this module cannot read itself (an invalid client sidecar); link code
 * stays free of client imports, so the caller supplies it.
 */
export function projectLinkStatus(
  store: LinkStore,
  supervisorStates: readonly LinkTunnelStatus[],
  listenerStatus: LinkListenerStatusProjection,
  config: LinkStatusConfig,
  compensation: CompensationStore = readCompensation(),
  clientChild: LinkStatusDto["child"] = null,
): LinkStatusDto {
  const byId = new Map(supervisorStates.map(status => [status.linkId, status]));
  const links = store.links.map(record => ({
    id: record.id,
    alias: record.alias,
    direction: record.direction,
    ...stateDetails(record, byId.get(record.id), compensation),
    tunnelPort: record.tunnelPort,
  }));
  const childRecord = config.runtimeRole === "client" ? store.links[0] : undefined;
  const invalidClientSidecar = config.runtimeRole === "client" ? clientChild : null;
  const childStatus = childRecord
    ? stateDetails(childRecord, byId.get(childRecord.id), compensation)
    : undefined;
  const role = config.runtimeRole === "client"
    ? "child"
    : store.links.length > 0 ? "home" : "standalone";
  return {
    role,
    listener: { state: listenerStatus.state, port: listenerStatus.port },
    links,
    child: invalidClientSidecar ?? (childRecord && childStatus ? { alias: childRecord.alias, ...childStatus } : null),
  };
}
