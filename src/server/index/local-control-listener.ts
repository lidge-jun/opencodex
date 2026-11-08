import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "bun";
import { isLoopbackHostname } from "../../codex/loopback-target";
import { assertNotRealHomeUnderTest } from "../../lib/test-home-guard";
import {
  LOCAL_CONTROL_SOCKET_PATH_MAX,
  isPrivateSocketDir,
  localControlSocketPath,
  localControlSocketSupported,
} from "../../lib/local-control-socket";
import type { OcxConfig } from "../../types";

/**
 * The one request the local control socket serves (#8184). `ocx link status` needs admin-token
 * authority on trusted loopback ingress, which a hub whose public listener is not loopback cannot
 * give it: the hub management listener is reached through Tailscale Serve, so it must never count
 * as trusted loopback (#6913). The socket is a separate ingress with that trust, limited to this
 * read and still requiring the admin token.
 */
export function localControlRouteAllowed(url: URL, req: Request): boolean {
  return req.method === "GET" && url.pathname === "/api/link/status" && !req.headers.has("upgrade");
}

/** A loopback public listener already gives the CLI trusted ingress; only other binds need this. */
export function localControlSocketWanted(config: Pick<OcxConfig, "hostname">): boolean {
  return localControlSocketSupported() && !isLoopbackHostname(config.hostname ?? "127.0.0.1");
}

export interface LocalControlStartContext<T> {
  config: OcxConfig;
  publicPort: number;
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  configDir?: string;
}

export interface LocalControlListener<T> {
  ownsListener(server: Server<T>): boolean;
  socketPath(): string | null;
  start(ctx: LocalControlStartContext<T>): void;
  stop(): Promise<void>;
}

function preparePrivateDir(dir: string): void {
  assertNotRealHomeUnderTest(dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) {
    throw new Error("socket directory is not a directory owned by this user");
  }
  chmodSync(dir, 0o700);
  if (!isPrivateSocketDir(dir)) throw new Error("socket directory could not be made private");
}

/** A socket left by a runtime that died on this port; anything that is not our socket is refused. */
function removeStaleSocket(path: string): void {
  let stat;
  try { stat = lstatSync(path); } catch { return; }
  if (!stat.isSocket() || stat.uid !== process.getuid!()) throw new Error("socket path is occupied");
  unlinkSync(path);
}

const notFound = () => Response.json(
  { error: { code: "not_found", message: "The local control socket serves only GET /api/link/status." } },
  { status: 404 },
);

export function createLocalControlListener<T>(): LocalControlListener<T> {
  let server: Server<T> | null = null;
  let path: string | null = null;
  return {
    ownsListener: candidate => server !== null && candidate === server,
    socketPath: () => path,
    start(ctx) {
      if (server || !localControlSocketWanted(ctx.config)) return;
      const target = localControlSocketPath(ctx.publicPort, ctx.configDir);
      if (target.length > LOCAL_CONTROL_SOCKET_PATH_MAX) {
        console.warn("[local-control] socket path is too long; ocx link status will use the TCP listener");
        return;
      }
      try {
        preparePrivateDir(dirname(target));
        removeStaleSocket(target);
        server = Bun.serve<T, never>({
          unix: target,
          maxRequestBodySize: 0,
          fetch(req, requestServer) {
            let url: URL;
            try { url = new URL(req.url); } catch { return notFound(); }
            return localControlRouteAllowed(url, req) ? ctx.dispatch(req, requestServer) : notFound();
          },
        });
        // The private directory is the access boundary; the socket mode is a second fence.
        chmodSync(target, 0o600);
        path = target;
      } catch (error) {
        const failed = server;
        server = null;
        if (failed) void failed.stop(true);
        console.warn(`[local-control] socket unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async stop() {
      const running = server;
      const socket = path;
      server = null;
      path = null;
      if (running) await running.stop(true);
      if (socket) {
        try { removeStaleSocket(socket); } catch { /* not ours any more; leave it */ }
      }
    },
  };
}
