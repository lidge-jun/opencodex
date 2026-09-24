import type { Server } from "bun";
import {
  emptyLinkStore,
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

export type LinkListenerStatus = {
  state: "off" | "listening" | "failed";
  port: number | null;
  reason: string | null;
};

export interface LinkListenerLifecycle<T> {
  ownsListener(server: Server<T>): boolean;
  start(ctx: LinkListenerStartContext<T>): void;
  ensureStarted(): Promise<void>;
  linkAdmissionKeyIds(): ReadonlySet<string>;
  status(): LinkListenerStatus;
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
    let bound: Server<unknown>;
    try {
      bound = serve({
        hostname: "127.0.0.1",
        port: requestedPort,
        maxRequestBodySize: startContext.maxRequestBodySize,
        fetch: (req: Request, server: Server<unknown>) => startContext!.dispatch(req, server as Server<T>),
      } as Parameters<typeof Bun.serve>[0]);
    } catch (error) {
      reportFailure("bind", error, "bind");
      return;
    }
    if (stopped) {
      closeWithoutAwait(bound);
      return;
    }
    if (store.listenerPort === null) {
      const port = bound.port;
      if (!port || port === 0) {
        closeWithoutAwait(bound);
        reportFailure("bind", new Error("Bun did not report a concrete listener port"), "bind");
        return;
      }
      try {
        const current = readStore(storePath);
        if (current.listenerPort !== null && current.listenerPort !== port) {
          // Another writer fixed a different port while this bind ran. Tunnels target the stored
          // port, so serving on this one would strand them: give it up and let the next
          // ensureStarted() bind the stored port.
          closeWithoutAwait(bound);
          reportFailure("listenerPort persistence", new Error(`stored port ${current.listenerPort} differs from bound port ${port}`), "persist");
          return;
        }
        writeStore(storePath, { ...current, listenerPort: port });
      } catch (error) {
        closeWithoutAwait(bound);
        reportFailure("listenerPort persistence", error, "persist");
        return;
      }
    }
    listener = bound as Server<T>;
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
      listener = null;
      if (current) await current.stop(true);
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
    status() {
      return { ...lifecycleStatus };
    },
    close,
    async stop() {
      stopped = true;
      await close();
      startContext = undefined;
      setStatus("off", null, null);
    },
  };
}
