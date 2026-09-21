import { BlockList, createServer, connect, isIP, type Server, type Socket } from "node:net";

/**
 * Loopback HTTP CONNECT proxy for Claude Code.
 *
 * Claude Code honours `HTTPS_PROXY` and opens `CONNECT <host>:443` for every upstream. This
 * proxy splices tunnels for the intercepted hosts onto the local TLS listener (which holds a
 * leaf certificate for them) and blindly relays every other tunnel to its real destination,
 * so telemetry, OAuth refresh and claude.ai traffic stay native and opaque to opencodex.
 *
 * Only CONNECT is served. Plain proxied HTTP requests are refused: Claude Code never sends
 * them, and answering them would turn this socket into a generic forward proxy.
 */

export const CLAUDE_INTERCEPT_HOSTS = ["api.anthropic.com"] as const;

const MAX_HEAD_BYTES = 8 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

export interface ConnectProxyOptions {
  /** Loopback port of the TLS listener that terminates intercepted tunnels. */
  interceptPort: number;
  /** Hostnames (lowercase) whose 443 tunnels are spliced onto `interceptPort`. */
  interceptHosts?: readonly string[];
  /** Test seam: dial the real destination for a blind tunnel. */
  dialUpstream?: (host: string, port: number) => Socket;
}

export interface ConnectProxyHandle {
  port: number;
  close(): Promise<void>;
}

interface ConnectTarget {
  host: string;
  port: number;
}

/** Parse `CONNECT host:port HTTP/1.1` from a request head; `null` for anything else. */
export function parseConnectRequestLine(head: string): ConnectTarget | null {
  const requestLine = head.split("\r\n", 1)[0] ?? "";
  const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/.exec(requestLine);
  if (!match) return null;
  const authority = match[1]!;
  // Bracketed IPv6 (`[::1]:443`) and plain `host:port`.
  const ipv6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(authority);
  const hostPort = ipv6 ?? /^([^:]+):(\d{1,5})$/.exec(authority);
  if (!hostPort) return null;
  const port = Number(hostPort[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: hostPort[1]!.toLowerCase().replace(/\.$/, ""), port };
}

// 127/8 and ::1, which `BlockList` also matches in IPv4-mapped form (`::ffff:127.0.0.1`,
// `::ffff:7f00:1`). The unspecified addresses dial the local host too.
const LOCAL_TARGETS = new BlockList();
LOCAL_TARGETS.addSubnet("127.0.0.0", 8, "ipv4");
LOCAL_TARGETS.addAddress("0.0.0.0", "ipv4");
LOCAL_TARGETS.addAddress("::1", "ipv6");
LOCAL_TARGETS.addAddress("::", "ipv6");

export function isLoopbackTarget(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = isIP(host);
  if (family !== 0) return LOCAL_TARGETS.check(host, family === 6 ? "ipv6" : "ipv4");
  // `127.1`, `0x7f000001`, `2130706433`: resolver shorthand for a loopback literal, not a name.
  return /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(host);
}

function respond(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function splice(client: Socket, upstream: Socket, pending: Uint8Array): void {
  const teardown = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", teardown);
  upstream.on("error", teardown);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.setTimeout(0);
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  if (pending.length > 0) upstream.write(pending);
  client.pipe(upstream);
  upstream.pipe(client);
}

function handleConnection(socket: Socket, options: Required<Pick<ConnectProxyOptions, "interceptPort" | "interceptHosts" | "dialUpstream">>): void {
  let head: Buffer = Buffer.alloc(0);
  socket.on("error", () => socket.destroy());
  socket.setTimeout(HEAD_TIMEOUT_MS, () => respond(socket, 408, "Request Timeout"));

  const onData = (chunk: Buffer) => {
    head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (head.length > MAX_HEAD_BYTES) {
        socket.off("data", onData);
        respond(socket, 431, "Request Header Fields Too Large");
      }
      return;
    }
    socket.off("data", onData);
    socket.pause();
    const target = parseConnectRequestLine(head.subarray(0, end).toString("latin1"));
    // Bytes after the head belong to the tunnel (a client may pipeline its TLS ClientHello).
    const pending = head.subarray(end + 4);
    if (!target) {
      respond(socket, 405, "Method Not Allowed");
      return;
    }
    if (isLoopbackTarget(target.host)) {
      respond(socket, 403, "Forbidden");
      return;
    }
    const intercept = target.port === 443 && options.interceptHosts.includes(target.host);
    const upstream = intercept
      ? connect({ host: "127.0.0.1", port: options.interceptPort })
      : options.dialUpstream(target.host, target.port);
    let established = false;
    const connectTimer = setTimeout(() => {
      if (!established) {
        upstream.destroy();
        respond(socket, 504, "Gateway Timeout");
      }
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    upstream.once("error", () => {
      clearTimeout(connectTimer);
      if (!established) respond(socket, 502, "Bad Gateway");
    });
    upstream.once("connect", () => {
      established = true;
      clearTimeout(connectTimer);
      if (socket.destroyed) {
        upstream.destroy();
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      splice(socket, upstream, pending);
      socket.resume();
    });
  };
  socket.on("data", onData);
}

/** Bind the CONNECT proxy on 127.0.0.1. Rejects when the port is unavailable. */
export function startConnectProxy(port: number, options: ConnectProxyOptions): Promise<ConnectProxyHandle> {
  const resolved = {
    interceptPort: options.interceptPort,
    interceptHosts: options.interceptHosts ?? CLAUDE_INTERCEPT_HOSTS,
    dialUpstream: options.dialUpstream ?? ((host: string, targetPort: number) => connect({ host, port: targetPort })),
  };
  return new Promise((resolve, reject) => {
    const server: Server = createServer(socket => handleConnection(socket, resolved));
    const sockets = new Set<Socket>();
    server.on("connection", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.off("error", reject);
      const address = server.address();
      const boundPort = address && typeof address === "object" ? address.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>(done => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
