import { createLinkRelaySessions, type LinkCatalogServed } from "./link-relay-sessions";
import { createLinkPeerObservations, type LinkPeerEntry } from "../../link/peer-report";
import { createLinkActivity, type LinkActivitySnapshot } from "../../link/child-activity";
import type { Server, WebSocketHandler } from "bun";
import type { RequestPolicyView } from "../auth-cors";
import type { WsData } from "../ws-bridge";
import { createLinkWebsocketGate, type LinkWebsocketGateDeps } from "./link-websocket";
import { linkWebsocketTransportReady } from "./link-websocket-limits";
import { createActivityHolds } from "../../link/ws-activity-holds";
import { resultKeysOf } from "../../codex/websocket-activity";
import { dirname } from "node:path";
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
}

export interface LinkListenerDeps {
  storePath?: string;
  readStore?: (path: string) => LinkStore;
  writeStore?: (path: string, store: LinkStore) => void;
  serve?: (options: Parameters<typeof Bun.serve>[0]) => Server<unknown>;
  warn?: (message: string) => void;
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
  onAuthenticatedCatalog(listener: (apiKeyId: string) => void): () => void;
  notifyAuthenticatedCatalog(apiKeyId: string): void;
  /** What this Home last learned of a Child over the link; empty until it relays a request. */
  peerObservation(linkId: string): LinkPeerEntry;
  /** Relayed model traffic for one link (D5); legacy key admissions count against every link. */
  linkActivity(linkId: string, now: number): LinkActivitySnapshot;
  /** The Home's own revoke path closes this link's WebSockets (4401) in the same task. */
  closeLinkSockets(linkId: string): number;
  /** Resolves once relayed requests already seen have been checked against activity holds. */
  activityHoldsSettled(): Promise<void>;
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
  const authenticatedCatalogListeners = new Set<(apiKeyId: string) => void>();
  const catalogServedListeners = new Set<(served: LinkCatalogServed) => void>();
  let lifecycleStatus: LinkListenerStatus = { state: "off", port: null, reason: null };
  const peers = createLinkPeerObservations();
  // Lifecycle-owned so a rebind keeps the book.
  // Durable link WebSocket holds (design T4 section 5) live beside links.json. Nothing is read or
  // written unless a crash fence exists or a link upgrade arms one.
  const holds = createActivityHolds({
    dir: dirname(storePath),
    linkIds: () => { try { return readStore(storePath).links.map(link => link.id); } catch { return []; } },
  });
  holds.start();
  const activity = createLinkActivity({ held: linkId => holds.count(linkId) });
  // Relayed requests being checked against holds; tests and shutdown can wait for them.
  const holdObservations = new Set<Promise<void>>();

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
    const requestedPort = store.listenerPort ?? 0;
    const linkWebsocket = startContext.responsesWebsocket;
    const sessions = createLinkRelaySessions({ peers, activity, connectionGeneration: linkId => startContext?.connectionGeneration?.(linkId),
      catalogServed: served => { for (const listener of catalogServedListeners) listener(served); }, fingerprints: fingerprintsFor,
      ...(linkWebsocket ? { upgrade: websocketGate.upgrade, websocketAdvertised: websocketEnabled } : {}),
      observeResponsesRequest: (linkId, req) => {
        // Only a link with a releasable hold pays for reading a copy of the request body.
        if (!holds.releasable(linkId)) return;
        const header = req.headers.get("thread-id");
        const observation = req.clone().json().then((body: unknown) => {
          const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
          const metadata = record.client_metadata as Record<string, unknown> | undefined;
          const threadId = header || (metadata && typeof metadata.thread_id === "string" ? metadata.thread_id : "");
          holds.observe(linkId, threadId ? holds.threadHash(threadId) : null, resultKeysOf(record.input));
        }).catch(() => {}).finally(() => { holdObservations.delete(observation); });
        holdObservations.add(observation);
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
    notifyAuthenticatedCatalog(apiKeyId) {
      for (const listener of authenticatedCatalogListeners) listener(apiKeyId);
    },
    peerObservation: linkId => peers.get(linkId),
    linkActivity: (linkId, now) => activity.snapshot(linkId, now),
    // Only the Home's link removal calls this: the link's sockets close and its holds go with it.
    closeLinkSockets: linkId => { const closed = websocketGate.closeLink(linkId); holds.removeLink(linkId); return closed; },
    async activityHoldsSettled() { await Promise.all([...holdObservations]); },
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
