import type { LinkStore } from "./store";
import type { LinkTunnelStatus } from "./supervisor";
import type { TunnelState } from "./tunnel-state";
import { readCompensation, type CompensationStore } from "./compensation";
import { EMPTY_LINK_CHILD_PARITY, type LinkChildParity } from "./child-parity";
import { linkPeerStatus, type LinkLocalPeer, type LinkPeerStatus } from "./compatibility";
import type { LinkPeerEntry } from "./peer-report";
import type { OcxClientConnectionConfig } from "../types";
import { isLinkIdle, type LinkActivitySnapshot } from "./child-activity";
import { catalogVerdict, type CatalogPull, type CatalogRevision, type CatalogState } from "./child-catalog-freshness";
import type { ChildObservation, ChildOp, ChildOperationSummary } from "./child-observations";
import type { InstallKind, UpdateRoute } from "./child-update-contract";
import type { LinkHoldsSummary } from "./ws-activity-holds";
import { compareStrictSemver, parseStrictSemver } from "../lib/strict-semver";
import type { LinkTrafficCounters } from "./traffic";

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
    childKind?: "full" | "ephemeral";
    /** Exclusive links only (structure/remote-link.md, "Explicit route"); absent on every other row. */
    exclusive?: true;
    explicitRoute?: import("./explicit-route").ExplicitRoute;
    /** Home only: what the link carried from this Child, and the compatibility verdict. */
    peer?: LinkPeerStatus;
    /** Home-initiated links on request (`?diagnostics=1`): retry progress and the last failure. */
    tunnel?: LinkTunnelDiagnostics;
    /** Home rows on request (`?children=1`): versions, update route, catalog freshness, activity and operations. */
    child?: LinkChildOpsStatus;
    /** Links with several routes, on request (`?routes=1`): each route's rest and last outcome. */
    routes?: LinkRouteWire[];
    /** The route the proven tunnel uses and when it was proven; null while none is proven. */
    route?: { name: string; index: number; since: string } | null;
    /** Why the link cannot run its routes right now, or null. */
    routeBlocked?: "ssh_client_unsupported" | "stop_unconfirmed" | null;
    /** Rows on request (`?transport=1`): the live link WebSocket counters (design T4 section 9.3). */
    ws?: LinkWsStatus;
    /** On request (`?traffic=1`): body bytes this machine relayed or served for the link since `since`. */
    traffic?: LinkTrafficCounters;
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

/** One route of a multi-route link on the wire. The class is a fixed word, never ssh output. */
export interface LinkRouteWire {
  name: string;
  eligibleAt: string | null;
  lastOutcome: { class: "transient" | "readiness" | "grant_unobserved" | "forward" | "auth" | "hostkey"; at: string } | null;
}

/**
 * Add route fields to each link the supervisor runs with several routes. Opt-in like `tunnel`:
 * an older `ocx link status` validates rows key by key. Route names are SSH host aliases; this
 * document is served only to the Home's admin token or dashboard session, never over the relay.
 */
export function attachLinkRoutes(dto: LinkStatusDto, supervisorStates: readonly LinkTunnelStatus[]): LinkStatusDto {
  const byId = new Map(supervisorStates.map(status => [status.linkId, status]));
  for (const link of dto.links) {
    const status = byId.get(link.id);
    if (!status || status.direction !== "hub-initiated" || !status.routes) continue;
    const { routes, route, blocked } = status.routes;
    link.routes = routes.map(entry => ({
      name: entry.name,
      eligibleAt: entry.eligibleAt === null ? null : iso(entry.eligibleAt),
      lastOutcome: entry.lastOutcome ? { class: entry.lastOutcome.class, at: iso(entry.lastOutcome.at) } : null,
    }));
    link.route = route ? { name: route.name, index: route.index, since: iso(route.since) } : null;
    link.routeBlocked = blocked;
  }
  return dto;
}

/** Why the Home refused a link WebSocket upgrade, as counted (design T4 section 9.3). */
export type LinkWsRefusal = "aborted" | "draining" | "unauthorized" | "unavailable" | "memory" | "cap" | "failed";
/** Why a link WebSocket closed: the Home's own fence, or the peer's close code. */
export type LinkWsCloseReason = "revoked" | "disabled" | "idle" | "age" | "client" | "dropped" | "other";
/** In memory, display only, reset at restart. */
export interface LinkWsCounters {
  open: number;
  upgrades: number;
  refused: Partial<Record<LinkWsRefusal, number>>;
  closes: Partial<Record<LinkWsCloseReason, number>>;
}
export interface LinkWsStatus extends LinkWsCounters { holds: number }

/** `?transport=1`: every row gets `ws`; a Home without counters reports zeros. Rows are the current links only. */
export function attachLinkTransport(dto: LinkStatusDto, counters: (linkId: string) => LinkWsCounters | null,
  holds: (linkId: string) => number): LinkStatusDto {
  for (const link of dto.links) {
    const current = counters(link.id) ?? { open: 0, upgrades: 0, refused: {}, closes: {} };
    link.ws = { open: current.open, upgrades: current.upgrades, refused: { ...current.refused }, closes: { ...current.closes }, holds: holds(link.id) };
  }
  return dto;
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

/** Add `traffic` to every row (#3023). A Home counts in its hub-link listener, a Child in its link transport. */
export function attachLinkTraffic(dto: LinkStatusDto, traffic: (linkId: string) => LinkTrafficCounters): LinkStatusDto {
  for (const link of dto.links) link.traffic = traffic(link.id);
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

/** One Home row's `child` block. `codex` stays null until the Child reports its Codex state (wp8). */
export interface LinkChildOpsStatus {
  homeVersion: string; runningVersion: string | null; installedVersion: string | null; installKind: InstallKind | null;
  versionSkew: "same" | "behind" | "ahead" | "unknown";
  update: { route: UpdateRoute | null; reason: string | null; observedAt: string | null };
  catalog: { state: CatalogState; pulledAt: number | null; homeChangedAt: number | null };
  codex: null;
  activity: { idle: boolean; inFlight: number; lastDataEndAt: number | null };
  activeJob: { jobId: string; op: ChildOp; state: "queued" | "running" } | null;
  lastOperation: ChildOperationSummary | null;
  /** Link WebSocket activity holds and their reasons (D8); present only while something holds the link. */
  holds?: LinkHoldsSummary;
}

export interface LinkChildOpsSources {
  homeVersion: string; now: number; idleAfterMs: number;
  peerVersion(linkId: string): string | null; observation(linkId: string): ChildObservation | null;
  activity(linkId: string): LinkActivitySnapshot | null; catalogPull(linkId: string): CatalogPull | null;
  revision: CatalogRevision | null; activeJob(linkId: string): LinkChildOpsStatus["activeJob"];
  /** Optional: a Home without link WebSocket holds omits the key on every row. */
  holds?(linkId: string): LinkHoldsSummary | null;
}

function versionSkew(version: string | null, homeVersion: string): LinkChildOpsStatus["versionSkew"] {
  const child = parseStrictSemver(version);
  const home = parseStrictSemver(homeVersion);
  if (!child || !home) return "unknown";
  const order = compareStrictSemver(child, home);
  return order === 0 ? "same" : order < 0 ? "behind" : "ahead";
}

/** The newer of the relay's in-memory pull and the cached one. */
function latestPull(memory: CatalogPull | null, cached: ChildObservation | null): CatalogPull | null {
  const stored = cached?.catalogPulledAt != null && cached.catalogPulledEtag != null ? { at: cached.catalogPulledAt, etag: cached.catalogPulledEtag } : null;
  if (!memory) return stored;
  return stored && stored.at > memory.at ? stored : memory;
}

/**
 * Home rows only. Skew compares installed ?? running with homeVersion; ocx-child and unparsable versions are "unknown".
 * An entry observe never wrote (source "inspect" with route "none", the default a carried-only write creates) reads as
 * not observed. Missing activity reads busy, never idle.
 */
export function attachLinkChildOps(dto: LinkStatusDto, sources: LinkChildOpsSources): LinkStatusDto {
  if (dto.role !== "home") return dto;
  for (const link of dto.links) {
    const cached = sources.observation(link.id);
    const observed = cached && !(cached.source === "inspect" && cached.updateRoute === "none") ? cached : null;
    const runningVersion = parseStrictSemver(sources.peerVersion(link.id)) ? sources.peerVersion(link.id) : null;
    const installedVersion = observed?.installedVersion ?? null;
    const installKind = observed?.installKind ?? null;
    const ocxChild = installKind === "ocx-child" || link.childKind === "ephemeral";
    const pull = latestPull(sources.catalogPull(link.id), cached);
    const snapshot = sources.activity(link.id);
    const held = sources.holds?.(link.id) ?? null;
    link.child = {
      homeVersion: sources.homeVersion, runningVersion, installedVersion, installKind,
      versionSkew: ocxChild ? "unknown" : versionSkew(installedVersion ?? runningVersion, sources.homeVersion),
      update: observed ? { route: observed.updateRoute, reason: observed.updateReason, observedAt: observed.observedAt } : { route: null, reason: null, observedAt: null },
      catalog: { state: catalogVerdict(pull?.etag ?? null, cached?.catalogSyncedEtag ?? null, sources.revision), pulledAt: pull?.at ?? null,
        homeChangedAt: sources.revision?.changedAt ?? null },
      codex: null,
      activity: snapshot ? { idle: isLinkIdle(snapshot, sources.now, sources.idleAfterMs), inFlight: snapshot.inFlight, lastDataEndAt: snapshot.lastDataEndAt }
        : { idle: false, inFlight: 0, lastDataEndAt: null },
      activeJob: sources.activeJob(link.id),
      lastOperation: cached?.lastOperation ?? null,
      ...(held ? { holds: held } : {}),
    };
  }
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
  if (status.routes?.blocked === "ssh_client_unsupported" && !status.routes.route) {
    return { state: "failed", since: new Date(tunnel.kind === "idle" ? Date.parse(record.createdAt) : tunnel.since).toISOString(), reason: "ssh_client_unsupported" };
  }
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
    ...(record.childKind ? { childKind: record.childKind } : {}),
    ...(record.exclusive ? { exclusive: true as const } : {}),
    ...(record.explicitRoute ? { explicitRoute: { ...record.explicitRoute } } : {}),
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
