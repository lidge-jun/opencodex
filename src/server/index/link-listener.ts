import type { Server } from "bun";
import {
  emptyLinkStore,
  hasLinks,
  readLinkStore,
  type LinkStore,
  writeLinkStore,
} from "../../link/store";
import { linkStorePath } from "../../link/paths";

export const LINK_INGRESS_HOSTNAME = "opencodex-link.invalid";

export interface LinkListenerStartContext<T> {
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  maxRequestBodySize: number;
}

export interface LinkListenerDeps {
  storePath?: string;
  readStore?: (path: string) => LinkStore;
  writeStore?: (path: string, store: LinkStore) => void;
  serve?: (options: Parameters<typeof Bun.serve>[0]) => Server<unknown>;
  warn?: (message: string) => void;
}

export interface LinkListenerLifecycle<T> {
  ownsListener(server: Server<T>): boolean;
  start(ctx: LinkListenerStartContext<T>): void;
  ensureStarted(): Promise<void>;
  linkAdmissionKeyIds(): ReadonlySet<string>;
  close(): Promise<void>;
  stop(): Promise<void>;
}

const CONTEXT_PATHS = new Set([
  "/v1/alpha/history/v2/list_windows",
  "/v1/alpha/history/v2/list_items",
  "/v1/alpha/history/v2/read_item",
  "/v1/alpha/history/v2/search_contents",
  "/v1/alpha/notes/v2/thread_hint",
  "/v1/alpha/notes/v2/list_files_by_prefix",
  "/v1/alpha/notes/v2/read_file",
  "/v1/alpha/notes/v2/search_contents",
  "/v1/alpha/notes/v2/append_to_file",
  "/v1/alpha/notes/v2/write_file",
]);

/** The link socket is an HTTP data plane; every upgrade header is rejected first. */
export function linkRouteAllowed(url: URL, req: Request): boolean {
  if (req.headers.has("upgrade")) return false;
  const { pathname } = url;
  if (pathname === "/readyz") return req.method === "GET";
  if (pathname === "/v1/catalog" || pathname === "/v1/hub-state") {
    return req.method === "GET" || req.method === "HEAD";
  }
  if (pathname === "/v1/usage" || pathname === "/v1/models") return req.method === "GET";
  if (pathname === "/v1/responses" || pathname === "/v1/responses/compact"
    || pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens"
    || pathname === "/v1/chat/completions" || pathname === "/v1/audio/transcriptions"
    || pathname === "/v1/alpha/search" || pathname === "/v1/images/generations"
    || pathname === "/v1/images/edits" || pathname === "/v1/live"
    || pathname === "/v1/realtime/calls" || CONTEXT_PATHS.has(pathname)) {
    return req.method === "POST";
  }
  return req.method === "GET" && pathname.startsWith("/v1/opencodex/artifacts/");
}

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
  let startContext: LinkListenerStartContext<T> | undefined;
  let ensureFlight: Promise<void> | undefined;
  let closeFlight: Promise<void> | undefined;
  let stopped = false;

  const reportFailure = (operation: string, error: unknown): void => {
    warn(`⚠ hub-link listener ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
  };

  const readStoreForAdmission = (): LinkStore => {
    try { return readStore(storePath); } catch { return emptyLinkStore(); }
  };

  const bindIfNeeded = (): void => {
    if (listener || !startContext) return;
    let store: LinkStore;
    try {
      const active = deps.readStore ? readStore(storePath).links.length > 0 : hasLinks(storePath);
      if (!active) return;
      store = readStore(storePath);
    } catch (error) {
      reportFailure("store read", error);
      return;
    }
    if (store.links.length === 0) return;
    const requestedPort = store.listenerPort ?? 0;
    let bound: Server<unknown>;
    try {
      bound = serve({
        hostname: "127.0.0.1",
        port: requestedPort,
        maxRequestBodySize: startContext.maxRequestBodySize,
        fetch: (req: Request, server: Server<unknown>) => startContext!.dispatch(req, server as Server<T>),
      } as Parameters<typeof Bun.serve>[0]);
    } catch (error) {
      reportFailure("bind", error);
      return;
    }
    if (store.listenerPort === null) {
      const port = bound.port;
      if (!port || port === 0) {
        closeWithoutAwait(bound);
        reportFailure("bind", new Error("Bun did not report a concrete listener port"));
        return;
      }
      try {
        writeStore(storePath, { ...store, listenerPort: port });
      } catch (error) {
        closeWithoutAwait(bound);
        reportFailure("listenerPort persistence", error);
        return;
      }
    }
    listener = bound as Server<T>;
  };

  const ensureStarted = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (ensureFlight) return ensureFlight;
    const flight = (async () => {
      if (closeFlight) await closeFlight;
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
      listener = null;
      if (current) await current.stop(true);
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
    close,
    async stop() {
      stopped = true;
      await close();
      startContext = undefined;
    },
  };
}
