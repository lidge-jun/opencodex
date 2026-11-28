import { serviceApiTokenFingerprint } from "../../lib/service-secrets";
import type { Server, WebSocketHandler } from "bun";
import type { OcxConfig } from "../../types";
import type { RequestPolicyView } from "../auth-cors";
import type { WsData } from "../ws-bridge";
import { linkResponsesWebsocketEnabled } from "../../config/feature-flags";
import {
  createClaudeInterceptLifecycle,
  type ClaudeInterceptLifecycle,
} from "./claude-intercept-lifecycle";
import {
  createLinkListenerLifecycle,
  linkListenerOwnsTarget,
  linkRouteAllowed,
  type LinkListenerDeps,
  type LinkListenerLifecycle,
  type LinkListenerStatus,
} from "./link-listener";
import { createLinkSupervisor, type LinkSupervisor } from "../../link/supervisor";
import { flushLinkDiagnostics, recordLinkDiagnostic } from "../../link/diagnostics";
import { linkManagementRouteAllowed } from "../../link/management-routes";
import { linkChildParityRouteAllowed } from "../../link/child-parity";
import { saveConfigPreservingClaudeCode } from "../../config/live-reconcile";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { startJevQuotaActivation } from "../../combos/jev-quota-activation";
import { createLocalControlListener } from "./local-control-listener";
import { createCatalogPullRecorder, type CatalogPull, type CatalogPullRecorder } from "../../link/child-catalog-freshness";
import type { LinkActivitySnapshot } from "../../link/child-activity";
import type { CatalogRevisionMonitor } from "../../link/child-catalog-freshness";
import type { ChildOpsHostBinding } from "../../link/child-ops-host";
import { createRouteProofRegistry } from "../../link/route-proof";
export { LINK_INGRESS_HOSTNAME } from "./link-listener";
import type { ServerIngress } from "./serve-options";
import { linkHomeFeatures } from "../../remote/features";

export interface OptionalListenerStartContext<T> {
  startProxy?: typeof import("../../claude/intercept/connect-proxy").startConnectProxy;
  config: OcxConfig;
  publicPort: number;
  requestedPort?: number;
  maxRequestBodySize: number;
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  /** The shared Responses WebSocket handler and the hub-link policy, for the link WebSocket. */
  websocket?: WebSocketHandler<WsData>;
  linkPolicy?: () => RequestPolicyView;
}

export interface OptionalListenerSet<T> {
  ensureClaudeIntercept(): ReturnType<ClaudeInterceptLifecycle<T>["ensure"]>;
  claudeInterceptOutcome(): ReturnType<ClaudeInterceptLifecycle<T>["lastOutcome"]>;
  ingressOf(server: Server<T>): ServerIngress | undefined;
  linkRouteAllowed(url: URL, req: Request): boolean;
  linkAdmissionKeyIds(): ReadonlySet<string>;
  onAuthenticatedCatalog(listener: (apiKeyId: string, routeProofId?: string) => void): () => void;
  notifyAuthenticatedCatalog(apiKeyId: string, routeProofId?: string): void;
  peerObservation(linkId: string): import("../../link/peer-report").LinkPeerEntry;
  linkActivity(linkId: string, now: number): LinkActivitySnapshot;
  /** Close one link's Responses WebSockets with 4401; the revoke route calls it after its commit. */
  closeLinkSockets(linkId: string): number;
  /** The link's WebSocket activity holds and their reasons; null when nothing holds it (D8). */
  linkHolds(linkId: string): import("../../link/ws-activity-holds").LinkHoldsSummary | null;
  /** The operator's clear of one link's activity holds (D8). */
  clearLinkHolds(linkId: string): import("../../link/ws-activity-holds").ClearHoldsResult;
  /** The link's live WebSocket counters (design 9.3). */
  linkTransport(linkId: string): import("../../link/status-projection").LinkWsCounters;
  linkTraffic(linkId: string): import("../../link/traffic").LinkTrafficCounters;
  /** The last relayed catalog pull of a link in this process; null before start or before any pull. */
  catalogPull(linkId: string): CatalogPull | null;
  /** Write every catalog pull still held in memory; a failed write is logged and kept for the next attempt. */
  flushCatalogPulls(): void;
  status(): LinkListenerStatus;
  linkStatus(): LinkListenerStatus;
  linkSupervisor(): LinkSupervisor;
  start(ctx: OptionalListenerStartContext<T>): void;
  /**
   * Synchronous rollback for a startup that failed after `start`. The local control socket holds a
   * live lease, and `startServer` cannot await a teardown, so that lease is released here instead of
   * being left for a successor to mistake for a running runtime.
   */
  abortStart(): void;
  ensureStarted(): Promise<void>;
  close(): Promise<void>;
  registerSupervisorStop(stop: () => Promise<void>): () => void;
  stop(): Promise<void>;
}

/** The Child-ops host and the status rows' catalog monitor, loaded together on a Home with links (050). */
export type ChildOpsHostLoader = () => Promise<{
  startChildOpsHost: (binding: ChildOpsHostBinding) => () => void;
  catalogRevision: () => CatalogRevisionMonitor;
}>;

/** Dynamic imports only: a Home without links never loads src/link/child-ops-* (INV-LINK-CHILD-OPS-01). */
const loadChildOpsHost: ChildOpsHostLoader = async () => {
  const [host, routes] = await Promise.all([import("../../link/child-ops-host"), import("../management/link-child-ops-routes")]);
  return { startChildOpsHost: host.startChildOpsHost, catalogRevision: routes.catalogRevisionForRoutes };
};

export function createOptionalListenerSet<T>(linkDeps: LinkListenerDeps = {},
  childOps: { load?: ChildOpsHostLoader } = {}): OptionalListenerSet<T> {
  const claudeIntercept: ClaudeInterceptLifecycle<T> = createClaudeInterceptLifecycle<T>();
  const linkListener: LinkListenerLifecycle<T> = createLinkListenerLifecycle<T>(linkDeps);
  const localControl = createLocalControlListener<T>();
  let activeConfig: OcxConfig | undefined;
  let stopJevQuotaActivation: (() => void) | undefined;
  // Readiness proofs of multi-route candidates: registered by the supervisor, admitted by the
  // hub-link catalog admission below, valid only under the link's current tunnel generation.
  const routeProofs = createRouteProofRegistry({ generationOf: linkId => supervisor.connectionGeneration?.(linkId) });
  const supervisor = createLinkSupervisor({
    // Tunnel state changes and their causes reach <configDir>/link/diagnostics.jsonl (bounded).
    diagnostic: recordLinkDiagnostic,
    flushDiagnostics: flushLinkDiagnostics,
    routeProof: routeProofs,
    apiKeys: () => activeConfig?.apiKeys ?? [],
    revokeApiKey: id => {
      if (!activeConfig) return false;
      const before = activeConfig.apiKeys ?? [];
      if (!before.some(key => key.id === id)) return false;
      activeConfig.apiKeys = before.filter(key => key.id !== id);
      try {
        saveConfigPreservingClaudeCode(activeConfig);
        reconcileLiveStateStores();
      } catch (error) {
        activeConfig.apiKeys = before;
        throw error;
      }
      return true;
    },
  });
  let unregisterSupervisorAdmission: (() => void) | undefined;
  let unregisterRouteProofs: (() => void) | undefined;
  let supervisorStop: (() => Promise<void>) | undefined;
  let catalogPulls: CatalogPullRecorder | undefined;
  let unregisterCatalogPulls: (() => void) | undefined;
  let stopChildOps: (() => void) | undefined;
  // Bumped by stop() and by every "not owned" sync, so an import still in flight cannot start a host afterwards.
  let childOpsGeneration = 0;
  /**
   * The Child-ops host runs exactly while the link listener owns its socket, which it does only when links.json has
   * links. start() stays synchronous: the import is not awaited (the startServer no-await window, AGENTS.md).
   */
  const syncChildOpsHost = (): void => {
    if (!linkListenerOwnsTarget(linkListener.status())) {
      childOpsGeneration += 1;
      stopChildOps?.();
      stopChildOps = undefined;
      return;
    }
    if (stopChildOps) return;
    const generation = ++childOpsGeneration;
    void (childOps.load ?? loadChildOpsHost)()
      .then(loaded => {
        if (generation !== childOpsGeneration || stopChildOps || !activeConfig || !linkListenerOwnsTarget(linkListener.status())) return;
        const config = activeConfig;
        stopChildOps = loaded.startChildOpsHost({
          config: () => activeConfig ?? config,
          supervisorStatus: () => supervisor.status(),
          listenerStatus: () => linkListener.status(),
          activity: (linkId, now) => linkListener.linkActivity(linkId, now),
          catalogRevision: loaded.catalogRevision,
          peer: linkId => linkListener.peerObservation(linkId),
        });
      })
      // A host that fails to load leaves manual operations working and the status rows unchanged.
      .catch(error => { console.warn(`[link] child ops host did not start error=${error instanceof Error ? error.name : "unknown"}`); });
  };

  return {
    ensureClaudeIntercept: () => claudeIntercept.ensure(),
    claudeInterceptOutcome: () => claudeIntercept.lastOutcome(),
    ingressOf(server) {
      if (linkListener.ownsListener(server)) return "hub-link";
      if (claudeIntercept.ownsListener(server)) return "claude-intercept";
      if (localControl.ownsListener(server)) return "local-control";
      return undefined;
    },
    // The Home's link listener admits the data plane plus the read-only management relay
    // (#6957). The Child's own ingress keeps the data-only table, so a local caller on the Child
    // cannot reach the Home's management reads without the Child's dashboard session. The one
    // write is the Child's apply report (OCX-6), which changes only an in-memory status field.
    linkRouteAllowed: (url, req) => linkRouteAllowed(url, req) || linkManagementRouteAllowed(url, req)
      || linkChildParityRouteAllowed(url, req),
    linkAdmissionKeyIds: () => linkListener.linkAdmissionKeyIds(),
    onAuthenticatedCatalog: listener => linkListener.onAuthenticatedCatalog(listener),
    notifyAuthenticatedCatalog: (apiKeyId, routeProofId) => linkListener.notifyAuthenticatedCatalog(apiKeyId, routeProofId),
    peerObservation: linkId => linkListener.peerObservation(linkId),
    linkActivity: (linkId, now) => linkListener.linkActivity(linkId, now),
    closeLinkSockets: linkId => linkListener.closeLinkSockets(linkId),
    linkHolds: linkId => linkListener.linkHolds(linkId),
    clearLinkHolds: linkId => linkListener.clearLinkHolds(linkId),
    linkTransport: linkId => linkListener.linkTransport(linkId),
    linkTraffic: linkId => linkListener.linkTraffic(linkId),
    catalogPull: linkId => catalogPulls?.pulled(linkId) ?? null,
    flushCatalogPulls: () => { catalogPulls?.flush(); },
    status: () => linkListener.status(),
    linkStatus: () => linkListener.status(),
    linkSupervisor: () => supervisor,
    start(ctx) {
      activeConfig = ctx.config;
      localControl.start({ config: ctx.config, publicPort: ctx.publicPort, dispatch: ctx.dispatch });
      linkListener.start({ dispatch: ctx.dispatch, maxRequestBodySize: ctx.maxRequestBodySize,
        connectionGeneration: linkId => supervisor.connectionGeneration?.(linkId),
        homeFeatures: () => linkHomeFeatures(activeConfig),
        ...(ctx.websocket && ctx.linkPolicy ? { responsesWebsocket: {
          handler: ctx.websocket,
          enabled: () => activeConfig !== undefined && linkResponsesWebsocketEnabled(activeConfig),
          policy: ctx.linkPolicy,
        } } : {}),
        keyFingerprints: apiKeyId => {
          const entry = activeConfig?.apiKeys?.find(candidate => candidate.id === apiKeyId);
          if (!entry?.key) return [];
          const fingerprints = [serviceApiTokenFingerprint(entry.key)];
          const pending = entry.pendingRotation;
          if (pending && Date.parse(pending.expiresAt) > Date.now()) fingerprints.push(serviceApiTokenFingerprint(pending.key));
          return fingerprints;
        },
      });
      unregisterSupervisorAdmission ??= linkListener.onAuthenticatedCatalog(apiKeyId => supervisor.notifyAuthenticatedRequest?.(apiKeyId));
      unregisterRouteProofs ??= linkListener.onAuthenticatedCatalog((apiKeyId, routeProofId) => {
        if (routeProofId !== undefined) routeProofs.admit(apiKeyId, routeProofId);
      });
      // Only the hub-link relay fires this, so a Home without links records nothing.
      catalogPulls ??= createCatalogPullRecorder({ storePath: linkDeps.storePath });
      unregisterCatalogPulls ??= linkListener.onCatalogServed(served => catalogPulls!.record(served));
      if (linkListenerOwnsTarget(linkListener.status())) {
        supervisor.start();
        syncChildOpsHost();
      }
      supervisorStop = () => supervisor.stop();
      claudeIntercept.start({
        startProxy: ctx.startProxy,
        config: ctx.config,
        publicPort: ctx.publicPort,
        requestedPort: ctx.requestedPort,
        maxRequestBodySize: ctx.maxRequestBodySize,
        dispatch: ctx.dispatch,
      });
      // Last, after every listener started: JEV advisory quota follows the live config while serving.
      stopJevQuotaActivation = startJevQuotaActivation(ctx.config);
    },
    abortStart() {
      try { localControl.abort(); } catch { /* the startup error is the one worth reporting */ }
    },
    ensureStarted: () => linkListener.ensureStarted().then(() => syncChildOpsHost()),
    close: () => linkListener.close().then(() => syncChildOpsHost()),
    registerSupervisorStop(stop) {
      supervisorStop = stop;
      return () => {
        if (supervisorStop === stop) supervisorStop = undefined;
      };
    },
    async stop() {
      let failure: unknown;
      // First, before any other await. The local control socket's ownership record is released
      // synchronously inside this call, and the shutdown that follows can take a long time: a
      // supervisor stop over SSH, a link drain, the intercept pair. The public listener is already
      // closed by then, so an independent `ocx start` sees a free port and no runtime record; if
      // the lease were still held by this live pid it would read as a live owner and that
      // successor would refuse the port for good.
      try { await localControl.stop(); } catch (error) { failure = error; }
      // Synchronous: no automatic Child job is submitted once the supervisor starts tearing tunnels down.
      childOpsGeneration += 1;
      stopChildOps?.();
      stopChildOps = undefined;
      if (supervisorStop) {
        try { await supervisorStop(); } catch (error) { failure ??= error; }
      }
      try { await linkListener.stop(); } catch (error) { failure ??= error; }
      try { await claudeIntercept.stop(); } catch (error) { failure ??= error; }
      unregisterSupervisorAdmission?.();
      unregisterSupervisorAdmission = undefined;
      unregisterRouteProofs?.();
      unregisterRouteProofs = undefined;
      unregisterCatalogPulls?.();
      unregisterCatalogPulls = undefined;
      catalogPulls?.flush();
      stopJevQuotaActivation?.();
      stopJevQuotaActivation = undefined;
      if (failure) throw failure;
    },
  };
}
