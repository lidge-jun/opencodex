import { timingSafeEqual } from "node:crypto";
import { BlockList, createServer, connect, isIP, type Server, type Socket } from "node:net";

/**
 * Loopback HTTP CONNECT proxy for Claude Code.
 *
 * Claude Code honours `HTTPS_PROXY` and opens `CONNECT <host>:443` for every upstream. This
 * proxy splices tunnels for the intercepted hosts onto the local TLS listener (which holds a
 * leaf certificate for them) and blindly relays every other tunnel to its real destination,
 * so telemetry and OAuth refresh stay native and opaque to opencodex. Picker mode may
 * terminate only claude.ai tunnels, selected independently for each connection.
 *
 * Only CONNECT is served. Plain proxied HTTP requests are refused: Claude Code never sends
 * them, and answering them would turn this socket into a generic forward proxy.
 */

export const CLAUDE_INTERCEPT_HOSTS = ["api.anthropic.com"] as const;

const MAX_HEAD_BYTES = 8 * 1024;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

export interface ConnectProxyOptions {
  /** Loopback port of the TLS listener that terminates intercepted tunnels. */
  interceptPort: number;
  /**
   * Per-install bearer carried as HTTP Basic proxy credentials. Omit only for listeners whose
   * clients cannot present proxy credentials at all; an unauthenticated CONNECT proxy stays an
   * open loopback relay, so every consumer that can carry the credential must set this.
   */
  authToken?: string | (() => string | null);
  /** Hostnames (lowercase) whose 443 tunnels are spliced onto `interceptPort`. */
  interceptHosts?: readonly string[];
  /** Per-connection override, consulted before interceptHosts; null keeps the default. */
  selectTunnel?: (host: string, port: number, request: ConnectRequestInfo) => TunnelDecision | null | Promise<TunnelDecision | null>;
  /** Test seam: dial the real destination for a blind tunnel. */
  dialUpstream?: (host: string, port: number) => Socket;
}

export type TunnelDecision = { kind: "intercept"; port: number } | { kind: "blind" };

/** What the CONNECT head says about its client, for tunnel choice only. Never logged. */
export interface ConnectRequestInfo {
  /** The CONNECT request's User-Agent header, or null when it sent none. */
  userAgent: string | null;
}

/**
 * Chromium (Claude Desktop's app) sends its browser User-Agent on CONNECT; the Claude Code
 * processes Desktop spawns send none. The two trust different CAs, so the tunnel choice uses it.
 *
 * This is a routing hint, not a trust boundary: a local client can send any User-Agent. Neither
 * answer grants anything a local process lacks already. A non-browser tunnel reaches the
 * api.anthropic.com intercept, which the Claude Code proxy offers every local process; a browser
 * tunnel reaches the claude.ai relay, which verifies upstream and injects no credential. A client
 * that lies only breaks its own TLS, because each terminator presents a certificate only its
 * intended client trusts.
 */
export function isBrowserConnect(request: ConnectRequestInfo): boolean {
  return request.userAgent !== null && /^Mozilla\//.test(request.userAgent);
}

function connectRequestInfo(head: string): ConnectRequestInfo {
  const match = /\r\nuser-agent:[ \t]*([^\r\n]*)/i.exec(head);
  return { userAgent: match ? match[1]!.trim() : null };
}

type ResolvedConnectProxyOptions = Required<Pick<ConnectProxyOptions, "interceptPort" | "interceptHosts" | "dialUpstream">>
  & Pick<ConnectProxyOptions, "selectTunnel" | "authToken">;

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

function respond(socket: Socket, status: number, reason: string, headers: Readonly<Record<string, string>> = {}): void {
  if (socket.destroyed) return;
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
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

function proxyAuthorized(head: string, token: string): boolean {
  const header = head.split("\r\n").find(line => /^proxy-authorization:/i.test(line));
  const supplied = header?.slice(header.indexOf(":") + 1).trim();
  const expected = `Basic ${Buffer.from(`opencodex:${token}`).toString("base64")}`;
  if (!supplied) return false;
  // Compare byte lengths, not string lengths: the head decodes latin1 and Buffer.from
  // re-encodes utf-8, so a non-ASCII header can match in characters while differing in
  // bytes — and timingSafeEqual throws on a length mismatch instead of returning false.
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

function handleConnection(socket: Socket, options: ResolvedConnectProxyOptions): void {
  let head: Buffer = Buffer.alloc(0);
  socket.on("error", () => socket.destroy());
  socket.setTimeout(HEAD_TIMEOUT_MS, () => respond(socket, 408, "Request Timeout"));

  const onData = (chunk: Buffer) => {
    head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    // The cap holds however the head arrives: across reads or in one oversized read.
    if (end === -1 || end + 4 > MAX_HEAD_BYTES) {
      if (head.length > MAX_HEAD_BYTES) {
        socket.off("data", onData);
        respond(socket, 431, "Request Header Fields Too Large");
      }
      return;
    }
    socket.off("data", onData);
    socket.pause();
    const requestHead = head.subarray(0, end).toString("latin1");
    const target = parseConnectRequestLine(requestHead);
    // Bytes after the head belong to the tunnel (a client may pipeline its TLS ClientHello).
    let pending = head.subarray(end + 4);
    if (!target) {
      respond(socket, 405, "Method Not Allowed");
      return;
    }
    if (options.authToken !== undefined) {
      let token: string | null = null;
      try { token = typeof options.authToken === "function" ? options.authToken() : options.authToken; }
      catch { /* unavailable credential must never fall back to an unauthenticated proxy */ }
      if (!token || !proxyAuthorized(requestHead, token)) {
        respond(socket, 407, "Proxy Authentication Required", { "Proxy-Authenticate": 'Basic realm="OpenCodex"' });
        return;
      }
    }
    if (isLoopbackTarget(target.host)) {
      respond(socket, 403, "Forbidden");
      return;
    }
    const dialFor = (selected: TunnelDecision | null): void => {
      if (socket.destroyed) return;
      const choice = selected ?? (target.port === 443 && options.interceptHosts.includes(target.host)
        ? { kind: "intercept" as const, port: options.interceptPort }
        : { kind: "blind" as const });
      const upstream = choice.kind === "intercept"
        ? connect({ host: "127.0.0.1", port: choice.port })
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
    if (!options.selectTunnel) {
      dialFor(null);
      return;
    }
    let decision: ReturnType<NonNullable<ConnectProxyOptions["selectTunnel"]>>;
    try {
      decision = options.selectTunnel(target.host, target.port, connectRequestInfo(head.subarray(0, end).toString("latin1")));
    } catch {
      dialFor({ kind: "blind" });
      return;
    }
    if (!decision || typeof (decision as Promise<TunnelDecision | null>).then !== "function") {
      dialFor(decision as TunnelDecision | null);
      return;
    }
    // A paused socket does not notice a peer FIN until its readable side is drained.
    // Hold later tunnel bytes here so a departing client cannot trigger a stale dial.
    const onPendingReadable = () => {
      let chunk: Buffer | null;
      while ((chunk = socket.read() as Buffer | null) !== null) {
        if (pending.length + chunk.length > MAX_PENDING_BYTES) {
          socket.destroy();
          return;
        }
        pending = Buffer.concat([pending, chunk]);
      }
    };
    const onPendingEnd = () => socket.destroy();
    socket.on("readable", onPendingReadable);
    socket.once("end", onPendingEnd);
    void Promise.resolve(decision).catch(() => ({ kind: "blind" as const })).then(choice => {
      socket.off("readable", onPendingReadable);
      socket.off("end", onPendingEnd);
      dialFor(choice);
    });
  };
  socket.on("data", onData);
}

/** Bind the CONNECT proxy on 127.0.0.1. Rejects when the port is unavailable. */
export function startConnectProxy(port: number, options: ConnectProxyOptions): Promise<ConnectProxyHandle> {
  const resolved: ResolvedConnectProxyOptions = {
    interceptPort: options.interceptPort,
    authToken: options.authToken,
    interceptHosts: options.interceptHosts ?? CLAUDE_INTERCEPT_HOSTS,
    selectTunnel: options.selectTunnel,
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
