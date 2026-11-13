import { createLinkRelaySessions, type LinkCatalogServed } from "./link-relay-sessions";
import { createLinkPeerObservations, type LinkPeerEntry } from "../../link/peer-report";
import { createLinkActivity, type LinkActivitySnapshot } from "../../link/child-activity";
import type { Server, WebSocketHandler } from "bun";
import type { RequestPolicyView } from "../auth-cors";
import type { WsData } from "../ws-bridge";
import { createLinkWebsocketGate, linkLogRefs, marksResent, upstreamCompleted, type LinkWebsocketGateDeps } from "./link-websocket";
import type { StoredMark } from "../../link/ws-activity-holds";
import { LINK_TURN_HEADER, registerLinkTurnToken, releaseLinkTurnToken } from "../link-turn";
import { LINK_WS_LIMITS, linkWebsocketTransportReady } from "./link-websocket-limits";
import { createActivityHolds, type ClearHoldsResult, type LinkHoldsSummary } from "../../link/ws-activity-holds";
import type { LinkWsCounters } from "../../link/status-projection";
import { resultKeysOf } from "../../codex/websocket-activity";
import { dirname } from "node:path";
import { createLinkTrafficBook, type LinkTrafficCounters } from "../../link/traffic";
import { buildPeerFeatures } from "../../remote/features";
import { decodeRequestBody } from "../request-decompress";
import {
  emptyLinkStore,
  readLinkStore,
  type LinkStore,
  writeLinkStore,
} from "../../link/store";
import { linkStorePath } from "../../link/paths";
import { linkRouteAllowed } from "../../link/routes";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import { registerFallbackLinkResolver } from "../../routing/fallback-policy";
import { captureChildRouteDefaults } from "../../routing/home-route-intent";

export const LINK_INGRESS_HOSTNAME = "opencodex-link.invalid";

/** Internal signal: the store's port differs from the port this bind landed on. */
class LinkListenerPortMismatchError extends Error {
  constructor(storedPort: number, boundPort: number) {
    super(`stored port ${storedPort} differs from bound port ${boundPort}`);
    this.name = "LinkListenerPortMismatchError";
  }
}

export interface LinkListenerStartContext<T> {
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  maxRequestBodySize: number;
  keyFingerprints?: (apiKeyId: string) => readonly string[];
  /** The Home supervisor's current tunnel connection for a link (relay-auth.ts). */
  connectionGeneration?: (linkId: string) => string | undefined;
  /** The Responses WebSocket over the link (link-websocket.ts); route fakes omit it. */
  responsesWebsocket?: {
    /** The shared Responses handler the public listener uses; link sockets wrap it. */
    handler: WebSocketHandler<WsData>;
    /** linkResponsesWebsocketEnabled on the live config. */
    enabled(): boolean;
    policy(): RequestPolicyView;
  };
  /** The features named on every relay-auth answer; this build's served features when absent. */
  homeFeatures?: () => readonly string[];
}

export interface LinkListenerDeps {
  storePath?: string;
  readStore?: (path: string) => LinkStore;
  writeStore?: (path: string, store: LinkStore) => void;
  serve?: (options: Parameters<typeof Bun.serve>[0]) => Server<unknown>;
  warn?: (message: string) => void;
  /** Freezes every default Children inherit (native switches and file ownership) before this listener can serve route intent. */
  captureRouteDefaults?: () => void;
  /** Delay before retry `attempt` (0-based) of a failed capture; tests shorten it. */
  captureRetryDelayMs?: (attempt: number) => number;
  /** Test seams for the link WebSocket gate: limits, timers, socket reservation, drain state. */
  websocket?: Pick<LinkWebsocketGateDeps, "limits" | "timers" | "reserveSocket" | "draining">;
}

export type LinkListenerStatus = {
  state: "off" | "listening" | "failed";
  port: number | null;
  reason: string | null;
};

export function linkListenerOwnsTarget(status: LinkListenerStatus): boolean {
  return status.state === "listening" && status.port !== null;
}

export interface LinkListenerLifecycle<T> {
  ownsListener(server: Server<T>): boolean;
  start(ctx: LinkListenerStartContext<T>): void;
  ensureStarted(): Promise<void>;
  linkAdmissionKeyIds(): ReadonlySet<string>;
  /** A key-admitted catalog request; routeProofId is a multi-route readiness proof it carried (src/link/route-proof.ts). */
  onAuthenticatedCatalog(listener: (apiKeyId: string, routeProofId?: string) => void): () => void;
  notifyAuthenticatedCatalog(apiKeyId: string, routeProofId?: string): void;
  /** What this Home last learned of a Child over the link; empty until it relays a request. */
  peerObservation(linkId: string): LinkPeerEntry;
  /** Relayed model traffic for one link (D5); legacy key admissions count against every link. */
  linkActivity(linkId: string, now: number): LinkActivitySnapshot;
  /** The Home's own revoke path closes this link's WebSockets (4401) in the same task. */
  closeLinkSockets(linkId: string): number;
  /** Design 9.3: the link's live WebSocket counters (display only, reset at restart). */
  linkTransport(linkId: string): LinkWsCounters;
  /** The link's WebSocket activity holds and their reasons; null when nothing holds it (D8). */
  linkHolds(linkId: string): LinkHoldsSummary | null;
  /** The operator's clear of one link's activity holds (D8); never called automatically. */
  clearLinkHolds(linkId: string): ClearHoldsResult;
  /** Resolves once relayed requests already seen have been checked against activity holds. */
  activityHoldsSettled(): Promise<void>;
  /** Body bytes each link carried since this lifecycle started (#3023); zeros before any traffic. */
  linkTraffic(linkId: string): LinkTrafficCounters;
  /** A Child read a whole 200 `GET /v1/catalog` body through the relay. */
  onCatalogServed(listener: (served: LinkCatalogServed) => void): () => void;
  status(): LinkListenerStatus;
  close(): Promise<void>;
  stop(): Promise<void>;
}

export { linkRouteAllowed } from "../../link/routes";

function closeWithoutAwait<T>(server: Server<T>): void {
  try { void server.stop(true).catch(() => {}); } catch { /* preserve the bind failure */ }
}

export function createLinkListenerLifecycle<T>(deps: LinkListenerDeps = {}): LinkListenerLifecycle<T> {
  const storePath = deps.storePath ?? linkStorePath();
  const readStore = deps.readStore ?? readLinkStore;
  const writeStore = deps.writeStore ?? writeLinkStore;
  const serve = deps.serve ?? (options => Bun.serve(options));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  let listener: Server<T> | null = null;
  let relaySessions: ReturnType<typeof createLinkRelaySessions> | undefined;
  let startContext: LinkListenerStartContext<T> | undefined;
  let ensureFlight: Promise<void> | undefined;
  let closeFlight: Promise<void> | undefined;
  let stopped = false;
  const authenticatedCatalogListeners = new Set<(apiKeyId: string, routeProofId?: string) => void>();
  const catalogServedListeners = new Set<(served: LinkCatalogServed) => void>();
  let lifecycleStatus: LinkListenerStatus = { state: "off", port: null, reason: null };
  const peers = createLinkPeerObservations();
  // Lifecycle-owned so a rebind keeps the book.
  // Durable link WebSocket holds (design T4 section 5) live beside links.json. Nothing is read or
  // written unless a crash fence exists or a link upgrade arms one.
  const holds = createActivityHolds({
    dir: dirname(storePath),
    limits: LINK_WS_LIMITS,
    // null, not []: an unreadable store must not let crash evidence be cleaned without its links.
    linkIds: () => { try { return readStore(storePath).links.map(link => link.id); } catch { return null; } },
  });
  holds.start();
  const activity = createLinkActivity({ held: linkId => holds.count(linkId) });
  // Relayed requests being checked against holds; tests and shutdown can wait for them.
  const holdObservations = new Set<Promise<void>>();
  const traffic = createLinkTrafficBook("content-length");

  const setStatus = (state: LinkListenerStatus["state"], port: number | null, reason: string | null): void => {
    lifecycleStatus = { state, port, reason };
  };

  const reportFailure = (operation: string, error: unknown, reason: string): void => {
    setStatus("failed", null, reason);
    warn(`⚠ hub-link listener ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
  };

  const readStoreForAdmission = (): LinkStore => {
    try { return readStore(storePath); } catch { return emptyLinkStore(); }
  };
  // The one fingerprint predicate: relay-auth verification, session consumption, and the link
  // WebSocket's per-frame authorization check all read links.json uncached through it.
  const fingerprintsFor = (keyId: string, linkId: string): readonly string[] => {
    if (!readStoreForAdmission().links.some(link => link.id === linkId && link.apiKeyId === keyId)) return [];
    return startContext?.keyFingerprints?.(keyId) ?? [];
  };
  // The release gate comes first: until the bounded pump lands, the switch admits nothing.
  const websocketEnabled = (): boolean => linkWebsocketTransportReady() && startContext?.responsesWebsocket?.enabled() === true;
  const websocketGate = createLinkWebsocketGate({
    ...deps.websocket,
    // The same lifecycle-owned book relayed HTTP turns count in, so restart gates see link sockets.
    activity,
    holds,
    enabled: websocketEnabled,
    policy: () => startContext!.responsesWebsocket!.policy(),
    authorized: identity => fingerprintsFor(identity.keyId, identity.linkId).includes(identity.fingerprint),
  });
  // OCX-11: the fallback policy resolves a link data key to its link id through this slot.
  const releaseFallbackLinkResolver = registerFallbackLinkResolver(keyId =>
    readStoreForAdmission().links.find(link => link.apiKeyId === keyId)?.id);

  // Children read route intent through this listener, and that read is pure: it never captures.
  // So a failed capture (a busy config lock, a damaged route-intent.json, unresolved Aside
  // ownership) is owed and retried with backoff until it succeeds, the listener closes or stops,
  // and again on every ensureStarted. Meanwhile every Home-only writer still captures first.
  let routeDefaultsOwed = false;
  let captureAttempt = 0;
  let captureRetry: ReturnType<typeof setTimeout> | undefined;
  const retryDelay = deps.captureRetryDelayMs ?? (attempt => Math.min(1_000 * 2 ** attempt, 300_000));
  const captureRouteDefaults = (): void => {
    if (captureRetry) { clearTimeout(captureRetry); captureRetry = undefined; }
    try {
      (deps.captureRouteDefaults ?? captureChildRouteDefaults)();
      routeDefaultsOwed = false;
      captureAttempt = 0;
    } catch (error) {
      if (!routeDefaultsOwed) warn(`⚠ Child route defaults were not captured; retrying: ${error instanceof Error ? error.message : String(error)}`);
      routeDefaultsOwed = true;
      if (stopped) return;
      captureRetry = setTimeout(() => {
        captureRetry = undefined;
        if (!stopped && routeDefaultsOwed) captureRouteDefaults();
      }, retryDelay(captureAttempt++));
      (captureRetry as { unref?: () => void }).unref?.();
    }
  };

  const bindIfNeeded = (): void => {
    if (stopped || listener || !startContext) return;
    let store: LinkStore;
    try {
      store = readStore(storePath);
    } catch (error) {
      reportFailure("store read", error, "bind");
      return;
    }
    if (store.links.length === 0) {
      setStatus("off", null, null);
      return;
    }
    // Capture the Children's defaults from the Home's switches and integrations as they stand at
    // startup, before any Home-only command can move one. A failure leaves the listener up and is
    // retried (see above).
    captureRouteDefaults();
    const requestedPort = store.listenerPort ?? 0;
    const linkWebsocket = startContext.responsesWebsocket;
    // The resolved inbound limit (index.ts resolves maxInboundBodyBytes), fixed at bind like the public listener's. The
    // handler re-resolves the live config per request, so after a live raise without a restart a coded body between the
    // two limits is accepted but releases no hold until the next bind: the safe direction (the link stays in flight).
    const inboundLimit = startContext.maxRequestBodySize;
    const sessions = createLinkRelaySessions({ peers, activity, traffic, homeFeatures: () => startContext?.homeFeatures?.() ?? buildPeerFeatures(), connectionGeneration: linkId => startContext?.connectionGeneration?.(linkId),
      catalogServed: served => { for (const listener of catalogServedListeners) listener(served); }, fingerprints: fingerprintsFor,
      ...(linkWebsocket ? { upgrade: websocketGate.upgrade, websocketAdvertised: websocketEnabled } : {}),
      observeResponsesRequest: (linkId, req) => {
        const header = req.headers.get("thread-id");
        const threadHashOf = (body: unknown): string | null => {
          const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
          const metadata = record.client_metadata as Record<string, unknown> | undefined;
          const threadId = header || (metadata && typeof metadata.thread_id === "string" ? metadata.thread_id : "");
          try { return threadId ? holds.threadHash(threadId) : null; } catch { return null; }
        };
        // Running marks, and while the feature is on the request-log fields of design 9.1: the pipeline reports this
        // request's expanded input and its terminal (src/server/link-turn.ts), through a token header it removes before
        // anything is forwarded. With the feature off and no marks, no token is set and the request is unchanged.
        let token: string | null = null;
        const logging = websocketEnabled();
        if (logging || holds.hasMarks(linkId)) {
          let resent: StoredMark[] = [];
          let threadHash: string | null = null;
          token = registerLinkTurnToken({
            expanded(body, chain) { threadHash = threadHashOf(body); resent = chain === "unexpanded" ? [] : marksResent(holds, linkId, threadHash, body); },
            expansionFailed() { resent = []; },
            terminal(status, source) { if (resent.length && threadHash && upstreamCompleted(status, source)) holds.releaseMarks(linkId, threadHash, resent); },
            ...(logging ? { pacedReads: true, logFields: (body: unknown) => ({ transport: "http" as const, first: false, ...linkLogRefs(holds, linkId, header?.trim() ?? "", body) }) } : {}),
          });
          try { req.headers.set(LINK_TURN_HEADER, token); } catch { releaseLinkTurnToken(token); token = null; }
        }
        // Pending result keys: only a link with a releasable hold pays for reading a copy of the body. The
        // request settles only holds that exist now, as it begins (a later hold may reuse an id).
        let decide: ((accepted: boolean) => void) | undefined;
        const beganAt = holds.sequence();
        if (holds.releasable(linkId)) {
          const decision = new Promise<boolean>(resolve => { decide = resolve; });
          // The copy is read and decoded only after the handler accepted the request; a refusal, the inbound budget's 503
          // included, cancels it unread (#8608). A Child may send the body coded (#8594); the copy is decoded through the
          // handlers' bounded reader under the same resolved inbound limit, and a body that does not decode releases nothing.
          const encoding = req.headers.get("content-encoding");
          const copy = req.clone();
          const observation = decision.then(async accepted => {
            // Never awaited: a tee's cancel waits for the other half, which a refusal may leave unread.
            if (!accepted) { void copy.body?.cancel().catch(() => {}); return; }
            const raw = new Uint8Array(await copy.arrayBuffer());
            const body = JSON.parse(new TextDecoder().decode(decodeRequestBody(raw, encoding, inboundLimit))) as unknown;
            if (!body || typeof body !== "object") return;
            holds.observe(linkId, threadHashOf(body), resultKeysOf((body as Record<string, unknown>).input), beganAt);
          }).catch(() => {}).finally(() => { holdObservations.delete(observation); });
          holdObservations.add(observation);
        }
        if (token === null && !decide) return;
        // Preparation claimed the token before the handler answered; dropping it again is a no-op,
        // and it keeps a request that never reached preparation from leaving one behind.
        return (accepted: boolean) => { if (token !== null) releaseLinkTurnToken(token); decide?.(accepted); };
      } });
    let bound: Server<unknown>;
    try {
      bound = serve({
        hostname: "127.0.0.1",
        port: requestedPort,
        // The public listener's idle limit (serve-options.ts). Bun's 10 s default would cut a
        // relayed turn that the Home holds or that streams with a long gap.
        idleTimeout: 255,
        maxRequestBodySize: startContext.maxRequestBodySize,
        fetch: (req: Request, server: Server<unknown>) => sessions.dispatch(req, server as Server<T>, startContext!.dispatch),
        // Only a verified link upgrade with the feature on ever reaches server.upgrade (link-websocket.ts).
        ...(linkWebsocket ? { websocket: websocketGate.handler(linkWebsocket.handler) } : {}),
      } as Parameters<typeof Bun.serve>[0]);
    } catch (error) {
      reportFailure("bind", error, "bind");
      return;
    }
    if (stopped) {
      closeWithoutAwait(bound);
      return;
    }
    const port = bound.port;
    if (!port || port === 0) {
      closeWithoutAwait(bound);
      reportFailure("bind", new Error("Bun did not report a concrete listener port"), "bind");
      return;
    }
    try {
      // Revalidate the admission and persist a new port in one mutation section.
      // Even a known-port bind can race the deletion of its last recorded link.
      const needed = withConfigMutationLockSync(() => {
        const current = readStore(storePath);
        if (current.links.length === 0) return false;
        if (current.listenerPort !== null && current.listenerPort !== port) {
          throw new LinkListenerPortMismatchError(current.listenerPort, port);
        }
        if (current.listenerPort === null) writeStore(storePath, { ...current, listenerPort: port });
        return true;
      });
      if (!needed) {
        closeWithoutAwait(bound);
        setStatus("off", null, null);
        return;
      }
    } catch (error) {
      closeWithoutAwait(bound);
      reportFailure("listenerPort persistence", error, "persist");
      return;
    }
    listener = bound as Server<T>;
    relaySessions = sessions;
    websocketGate.accept();
    setStatus("listening", bound.port ?? (requestedPort > 0 ? requestedPort : null), null);
  };

  const ensureStarted = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (ensureFlight) return ensureFlight;
    const flight = (async () => {
      if (closeFlight) await closeFlight;
      if (stopped) return;
      // An unbound listener captures in bindIfNeeded; a bound one retries an owed capture here.
      if (routeDefaultsOwed && listener) captureRouteDefaults();
      bindIfNeeded();
    })();
    ensureFlight = flight.finally(() => {
      if (ensureFlight === sharedFlight) ensureFlight = undefined;
    });
    const sharedFlight = ensureFlight;
    return sharedFlight;
  };

  const close = (): Promise<void> => {
    if (closeFlight) return closeFlight;
    // No link is left to protect: an owed capture is retried at the next bind, not on a timer.
    if (captureRetry) { clearTimeout(captureRetry); captureRetry = undefined; }
    captureAttempt = 0;
    const flight = (async () => {
      if (ensureFlight) await ensureFlight;
      const current = listener;
      // Retain the bound port AND ingress ownership while an authenticated connection is
      // reserved or a dispatched response is still being consumed. No new proofs are issued.
      if (current) {
        // A link WebSocket holds its session lease until its close callback; close them first.
        websocketGate.closeAll();
        await relaySessions?.drain();
        await current.stop(false);
      }
      if (listener === current) { listener = null; relaySessions = undefined; }
      // Closing is the caller saying "no links now": an earlier bind or persist failure no
      // longer describes anything, so the status reads off either way.
      setStatus("off", null, null);
    })();
    closeFlight = flight.finally(() => {
      closeFlight = undefined;
    });
    return closeFlight;
  };

  return {
    ownsListener: server => listener !== null && listener === server,
    start(ctx) {
      startContext = ctx;
      bindIfNeeded();
    },
    ensureStarted,
    linkAdmissionKeyIds() {
      return new Set(readStoreForAdmission().links.map(link => link.apiKeyId));
    },
    onAuthenticatedCatalog(listener) {
      authenticatedCatalogListeners.add(listener);
      return () => { authenticatedCatalogListeners.delete(listener); };
    },
    notifyAuthenticatedCatalog(apiKeyId, routeProofId) {
      for (const listener of authenticatedCatalogListeners) listener(apiKeyId, routeProofId);
    },
    peerObservation: linkId => peers.get(linkId),
    linkActivity: (linkId, now) => activity.snapshot(linkId, now),
    // Only the Home's link removal calls this: the link's sockets close and its holds go with it.
    closeLinkSockets: linkId => { const closed = websocketGate.closeLink(linkId); holds.removeLink(linkId); websocketGate.forgetTransport(linkId); return closed; },
    linkTransport: linkId => websocketGate.transport(linkId),
    linkHolds: linkId => holds.summary(linkId),
    clearLinkHolds: linkId => holds.clear(linkId),
    async activityHoldsSettled() { await Promise.all([...holdObservations]); },
    linkTraffic: linkId => traffic.snapshot(linkId),
    onCatalogServed(listener) {
      catalogServedListeners.add(listener);
      return () => { catalogServedListeners.delete(listener); };
    },
    status() {
      return { ...lifecycleStatus };
    },
    close,
    async stop() {
      stopped = true;
      if (captureRetry) { clearTimeout(captureRetry); captureRetry = undefined; }
      releaseFallbackLinkResolver();
      // Process shutdown is deliberately forceful, unlike last-link removal. Every
      // authenticated socket is closed, and the client transport cannot reconnect it.
      relaySessions?.abortReservations();
      if (listener) await listener.stop(true);
      await close();
      websocketGate.dispose();
      // Sockets are closed and their holds recorded; persist them, then mark the fence clean.
      holds.stop();
      startContext = undefined;
      setStatus("off", null, null);
    },
  };
}
