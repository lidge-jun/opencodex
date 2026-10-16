import { createLinkRelaySessions } from "./link-relay-sessions";
import type { Server } from "bun";
import {
  emptyLinkStore,
  readLinkStore,
  type LinkStore,
  writeLinkStore,
} from "../../link/store";
import { linkStorePath } from "../../link/paths";
import { linkRouteAllowed } from "../../link/routes";
import { withConfigMutationLockSync } from "../../config/mutation-lock";

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
}

export interface LinkListenerDeps {
  storePath?: string;
  readStore?: (path: string) => LinkStore;
  writeStore?: (path: string, store: LinkStore) => void;
  serve?: (options: Parameters<typeof Bun.serve>[0]) => Server<unknown>;
  warn?: (message: string) => void;
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
  let lifecycleStatus: LinkListenerStatus = { state: "off", port: null, reason: null };

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
    const sessions = createLinkRelaySessions({ fingerprints: (keyId, linkId) => {
      if (!readStoreForAdmission().links.some(link => link.id === linkId && link.apiKeyId === keyId)) return [];
      return startContext?.keyFingerprints?.(keyId) ?? [];
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
    status() {
      return { ...lifecycleStatus };
    },
    close,
    async stop() {
      stopped = true;
      // Process shutdown is deliberately forceful, unlike last-link removal. Every
      // authenticated socket is closed, and the client transport cannot reconnect it.
      relaySessions?.abortReservations();
      if (listener) await listener.stop(true);
      await close();
      startContext = undefined;
      setStatus("off", null, null);
    },
  };
}
