/**
 * TLS terminator for claude.ai.
 *
 * The listener port is a plain TCP front that reads each connection's TLS ClientHello and splices
 * it, unterminated, to one of two loopback servers. A client offering `h2` (Chromium's ordinary
 * requests) reaches an HTTP/2 server, so Desktop multiplexes every claude.ai request over one
 * connection as it does against Anthropic's own edge. When this listener spoke only HTTP/1.1,
 * Desktop's long-lived SSE subscriptions took all six of Chromium's per-origin connections and every
 * later claude.ai request queued in the client until it timed out (#6511). Everything else (no ALPN,
 * HTTP/1.1 only, WebSocket connections, a ClientHello the front cannot read) reaches the native
 * HTTP/1.1 server, unchanged. Upstream is one HTTP/1.1 request per client request on both paths.
 * Only the bounded bootstrap response is held; other bodies and upgraded sockets relay as streams.
 */
import { createSecureServer } from "node:http2";
import type { Http2ServerRequest, Http2ServerResponse, ServerHttp2Session } from "node:http2";
import { createServer, request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { clientHelloOffersH2 } from "./client-hello";
import type { PemKeyPair } from "./local-ca";
import {
  BOOTSTRAP_MAX_ENCODED_BYTES, isPickerBootstrapRequest, narrowBootstrapAcceptEncoding,
  rewriteBootstrapBody, rewrittenHeaders,
} from "./picker-bootstrap";
import type { PickerModelEntry } from "./picker-bootstrap";

export interface PickerListenerOptions {
  leaf: PemKeyPair;
  models: () => readonly PickerModelEntry[];
  upstream?: { host: string; port: number; servername: string; ca?: string };
  /** Test seam: encoded bootstrap cap; production uses BOOTSTRAP_MAX_ENCODED_BYTES. */
  maxEncodedBytes?: number;
  /** Test seam: concurrent upstream requests; production uses PICKER_MAX_ACTIVE_UPSTREAMS. */
  maxActiveUpstreams?: number;
  log?: (line: string) => void;
}
export interface PickerListenerHandle { port: number; close(): Promise<void> }

// Browser session cookies can exceed the HTTP compatibility layer's 16 KiB default.
// Keep both sides bounded, while allowing ordinary desktop session headers through.
export const PICKER_MAX_HEADER_BYTES = 64 * 1024;
/**
 * Upstream requests in flight across the listener. HTTP/2 lets one connection open many streams,
 * and each relays as its own upstream connection, so the budget caps that fan-out well above what
 * Desktop uses (a handful of SSE subscriptions plus bursts of ordinary calls).
 */
export const PICKER_MAX_ACTIVE_UPSTREAMS = 256;
/** Advertised per HTTP/2 connection; Chromium queues further requests rather than failing them. */
export const PICKER_MAX_CONCURRENT_STREAMS = 100;
/** A connection that has not sent a complete ClientHello by then is dropped. */
const CLIENT_HELLO_TIMEOUT_MS = 10_000;

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

type RelayRequest = IncomingMessage | Http2ServerRequest;
type RelayResponse = ServerResponse | Http2ServerResponse;

const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ORIGIN_FORM_TARGET = /^\/[\x21-\x7e]*$/;

/**
 * HTTP/2 carries method and path as header values, which Bun accepts more loosely than an
 * HTTP/1.1 request line can express. Only a method token and an origin-form target relay.
 */
export function isRelayableH2Target(method: string | undefined, path: string | undefined): boolean {
  return method !== undefined && path !== undefined && METHOD_TOKEN.test(method) && ORIGIN_FORM_TARGET.test(path);
}

function filteredHeaders(raw: readonly string[], omit: ReadonlySet<string> = new Set()): string[] {
  const named = new Set<string>();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === "connection") {
      for (const name of raw[i + 1]!.split(",")) named.add(name.trim().toLowerCase());
    }
  }
  const result: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (!HOP_HEADERS.has(name) && !named.has(name) && !omit.has(name)) {
      result.push(raw[i]!, raw[i + 1]!);
    }
  }
  return result;
}

function hasJsonContentType(raw: readonly string[]): boolean {
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === "content-type") {
      return /^(?:application\/json|[^;\s]+\+json)(?:\s*;|\s*$)/i.test(raw[i + 1]!);
    }
  }
  return false;
}

function contentEncoding(raw: readonly string[]): string | undefined {
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === "content-encoding") return raw[i + 1]!;
  }
  return undefined;
}

/**
 * Request headers for the HTTP/1.1 upstream. An HTTP/2 request has pseudo-headers instead of a
 * request line, names its origin in `:authority` (which replaces any Host, RFC 9113 8.3.1) and
 * may split Cookie into crumbs (8.2.3); HTTP/1.1 needs one Host and one Cookie header.
 */
function upstreamRequestHeaders(req: RelayRequest, omit: ReadonlySet<string>): string[] {
  if (req.httpVersionMajor !== 2) return filteredHeaders(req.rawHeaders, omit);
  const rest: string[] = [];
  const cookies: string[] = [];
  let authority: string | undefined;
  let host: string | undefined;
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    const value = req.rawHeaders[i + 1]!;
    if (name === ":authority") authority = value;
    else if (name === "host") host = value;
    else if (name === "cookie") cookies.push(value);
    else if (!name.startsWith(":")) rest.push(req.rawHeaders[i]!, value);
  }
  const headers = filteredHeaders(rest, omit);
  headers.unshift("Host", authority ?? host ?? "claude.ai");
  if (cookies.length > 0) headers.push("Cookie", cookies.join("; "));
  return headers;
}

function listenLoopback(server: TcpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("picker listener has no port"));
      else resolve(address.port);
    });
  });
}

function closeServer(server: TcpServer): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
}

export async function startPickerListener(options: PickerListenerOptions): Promise<PickerListenerHandle> {
  const upstream = options.upstream ?? { host: "claude.ai", port: 443, servername: "claude.ai" };
  const cap = options.maxEncodedBytes ?? BOOTSTRAP_MAX_ENCODED_BYTES;
  const maxActiveUpstreams = options.maxActiveUpstreams ?? PICKER_MAX_ACTIVE_UPSTREAMS;
  let activeUpstreams = 0;
  const upgrades = new Set<Duplex>();
  const spliced = new Set<Socket>();
  const h2Sockets = new Set<Duplex>();
  const sessions = new Set<ServerHttp2Session>();
  const server = createServer({ cert: options.leaf.certPem, key: options.leaf.keyPem, ALPNProtocols: ["http/1.1"], maxHeaderSize: PICKER_MAX_HEADER_BYTES });
  // ALPN h2 only; no enableConnectProtocol, so Chromium opens WebSockets as HTTP/1.1 connections,
  // which the front sends to `server`. An over-budget header block is refused natively per stream
  // (Bun counts name + value + 32 bytes per field) before the request handler runs.
  const h2Server = createSecureServer({
    cert: options.leaf.certPem, key: options.leaf.keyPem,
    settings: { maxHeaderListSize: PICKER_MAX_HEADER_BYTES, maxConcurrentStreams: PICKER_MAX_CONCURRENT_STREAMS },
  });
  // Track sockets from accept (a handshake that never completes too) and after TLS, so a forced
  // shutdown reaches every one of them.
  for (const event of ["connection", "secureConnection"] as const) {
    h2Server.on(event, (socket: Duplex) => {
      h2Sockets.add(socket);
      socket.once("close", () => h2Sockets.delete(socket));
    });
  }
  h2Server.on("session", (session: ServerHttp2Session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
    options.log?.("picker session h2");
  });

  const relay = (req: RelayRequest, relayRes: RelayResponse) => {
    // The HTTP/2 compat response has every ServerResponse member used here; only writeHead's
    // reason phrase differs, and sendHead branches on it.
    const res = relayRes as ServerResponse;
    const h2 = req.httpVersionMajor === 2;
    // Refusals answer with an empty response and a fixed log line that carries no request data.
    const refuse = (status: 400 | 503) => {
      res.writeHead(status, { "Content-Length": "0" });
      res.end();
      options.log?.(`picker request refused ${status}`);
    };
    if (h2 && !isRelayableH2Target(req.method, req.url)) { refuse(400); return; }
    if (activeUpstreams >= maxActiveUpstreams) { refuse(503); return; }
    const method = req.method ?? "GET";
    let pathname: string;
    // A target like "//[" reads as an authority and throws; refuse it like any unrelayable target.
    try { pathname = new URL(req.url ?? "/", "https://claude.ai").pathname; } catch { refuse(400); return; }
    const bootstrap = isPickerBootstrapRequest(method, pathname);
    const category = bootstrap ? "bootstrap" : "other";
    let logged = false;
    const log = (status: number) => {
      if (!logged) options.log?.(`picker ${method} ${category} ${status}`);
      logged = true;
    };
    // Set once the client side closes before the response finished: the upstream error that
    // tearing it down raises is then expected, not a relay failure to answer or log.
    let clientGone = false;
    const fail = () => {
      if (clientGone) return;
      if (res.headersSent) res.destroy();
      else { res.writeHead(502, { "Content-Length": "0" }); res.end(); log(502); }
    };
    const omit = bootstrap ? new Set(["accept-encoding"]) : new Set<string>();
    const headers = upstreamRequestHeaders(req, omit);
    if (bootstrap) headers.push("Accept-Encoding", narrowBootstrapAcceptEncoding());
    let upReq: ReturnType<typeof httpsRequest>;
    try {
      // The HTTP/1.1 client validates the method, path and header values synchronously.
      upReq = httpsRequest({
        host: upstream.host, port: upstream.port, servername: upstream.servername,
        ca: upstream.ca, rejectUnauthorized: true, agent: false,
        method, path: req.url, headers, maxHeaderSize: PICKER_MAX_HEADER_BYTES,
        }, upRes => {
        const status = upRes.statusCode ?? 502;
        const originalHeaders = filteredHeaders(upRes.rawHeaders);
        const sendHead = (raw: string[]) => {
          if (res.headersSent) return;
          // HTTP/2 has no reason phrase; its compat writeHead takes the same flat raw header array.
          if (h2) (relayRes as Http2ServerResponse).writeHead(status, raw as unknown as Record<string, string>);
          else res.writeHead(status, upRes.statusMessage, raw);
          log(status);
        };
        upRes.on("error", fail);
        if (!bootstrap || status !== 200 || !hasJsonContentType(upRes.rawHeaders)) {
          sendHead(originalHeaders);
          upRes.pipe(res);
          return;
        }
        const held: Buffer[] = [];
        let size = 0;
        let handedOff = false;
        const onData = (chunk: Buffer) => {
          if (size + chunk.length > cap) {
            upRes.pause();
            upRes.off("data", onData);
            handedOff = true;
            sendHead(originalHeaders);
            for (const part of held) res.write(part);
            res.write(chunk);
            upRes.pipe(res);
            return;
          }
          held.push(chunk);
          size += chunk.length;
        };
        upRes.on("data", onData);
        upRes.once("end", () => {
          if (handedOff) return;
          const original = Buffer.concat(held, size);
          let outcome = "unchanged";
          const rewritten = rewriteBootstrapBody(original, contentEncoding(upRes.rawHeaders), options.models(), result => {
            outcome = result.kind === "rewritten" ? `rewritten(+${result.added})` : `unchanged:${result.reason}`;
          });
          sendHead(rewritten === null ? originalHeaders : rewrittenHeaders(originalHeaders, rewritten.length));
          options.log?.(`picker ${method} bootstrap ${outcome}`);
          res.end(rewritten ?? original);
        });
      });
    } catch {
      refuse(400);
      return;
    }
    // One budget slot per upstream request, released once by whichever end finishes first.
    activeUpstreams++;
    let released = false;
    const release = () => { if (!released) { released = true; activeUpstreams--; } };
    upReq.once("close", release);
    res.once("close", release);
    if (h2) (req as Http2ServerRequest).stream.once("close", release);
    upReq.on("error", error => {
      if ((error as NodeJS.ErrnoException).code === "HPE_HEADER_OVERFLOW") {
        options.log?.(`picker ${method} ${category} upstream:headers-too-large`);
      }
      fail();
    });
    req.on("error", () => upReq.destroy());
    const onClientClose = () => {
      if (!res.writableEnded) clientGone = true;
      upReq.destroy();
    };
    res.on("close", () => { if (!res.writableEnded) onClientClose(); });
    // Bun's compat response skips its close event for a HEAD reset before end(); the stream's own
    // close always fires. Destroying an upstream request that already completed is a no-op.
    if (h2) (req as Http2ServerRequest).stream.once("close", onClientClose);
    req.pipe(upReq);
  };
  server.on("request", relay);
  h2Server.on("request", relay);

  server.on("upgrade", (req, client, head) => {
    const method = req.method ?? "GET";
    const target = tlsConnect({
      host: upstream.host, port: upstream.port, servername: upstream.servername,
      ca: upstream.ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"],
    });
    upgrades.add(client);
    upgrades.add(target);
    let established = false;
    let upgradeLogged = false;
    let responseStart = "";
    const logUpgrade = (status: number) => {
      if (upgradeLogged) return;
      upgradeLogged = true;
      options.log?.(`picker ${method} other ${status}`);
    };
    const onResponseData = (chunk: Buffer) => {
      responseStart += chunk.toString("latin1");
      const end = responseStart.indexOf("\r\n");
      if (end >= 0) {
        target.off("data", onResponseData);
        const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(responseStart.slice(0, end));
        logUpgrade(status ? Number(status[1]) : 502);
      } else if (responseStart.length > 128) {
        target.off("data", onResponseData);
        logUpgrade(502);
      }
    };
    const fail = () => {
      if (!established && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      else client.destroy();
      target.destroy();
      logUpgrade(502);
    };
    target.on("data", onResponseData);
    target.once("secureConnect", () => {
      established = true;
      target.write(`${method} ${req.url ?? "/"} HTTP/1.1\r\n`);
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        if (/^proxy-(?:authorization|connection)$/i.test(req.rawHeaders[i]!)) continue;
        target.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      target.write("\r\n");
      if (head.length) target.write(head);
      client.pipe(target).pipe(client);
    });
    target.once("error", fail);
    client.once("error", () => target.destroy());
    target.once("close", () => { upgrades.delete(target); if (!upgradeLogged) logUpgrade(502); client.destroy(); });
    client.once("close", () => { upgrades.delete(client); target.destroy(); });
  });

  let http1Port = 0;
  let h2Port = 0;
  // The front never terminates TLS: it reads the ClientHello, then splices the untouched bytes
  // to the chosen server through a loopback socket, so both directions keep stream backpressure.
  // Ownership: `spliced` holds every front and bridge socket from accept until close; close()
  // destroys them, the h2 sessions and their TLS sockets, and the HTTP/1.1 server's connections.
  let closing = false;
  const front = createTcpServer(client => {
    if (closing) { client.destroy(); return; }
    spliced.add(client);
    client.once("close", () => spliced.delete(client));
    client.on("error", () => client.destroy());
    // An absolute deadline: trickled bytes cannot hold an unfinished ClientHello open.
    const deadline = setTimeout(() => client.destroy(), CLIENT_HELLO_TIMEOUT_MS);
    client.once("close", () => clearTimeout(deadline));
    let head: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
      const offersH2 = clientHelloOffersH2(head);
      if (offersH2 === null) return;
      client.off("data", onData);
      // Paused, a FIN or later bytes wait in the readable buffer and follow `head` once piped.
      client.pause();
      clearTimeout(deadline);
      const inner = tcpConnect({ host: "127.0.0.1", port: offersH2 ? h2Port : http1Port });
      spliced.add(inner);
      const teardown = () => { client.destroy(); inner.destroy(); };
      inner.on("error", teardown);
      client.on("error", teardown);
      // pipe() forwards each FIN after the queued bytes; a side that closes without having ended
      // its peer (reset, dial failure) tears the peer down instead of leaving it open.
      inner.once("close", () => { spliced.delete(inner); if (!client.writableEnded) client.destroy(); });
      client.once("close", () => { if (!inner.writableEnded) inner.destroy(); });
      inner.once("connect", () => {
        inner.setNoDelay(true);
        client.setNoDelay(true);
        // Every byte read during the peek (ClientHello and anything coalesced after it), once.
        inner.write(head);
        client.pipe(inner);
        inner.pipe(client);
        client.resume();
      });
    };
    client.on("data", onData);
  });

  const servers: TcpServer[] = [server, h2Server, front];
  // One forced shutdown for close() and for a failed start, shared by concurrent callers: destroy
  // every tracked socket and session (a graceful HTTP/2 close would wait on open SSE streams
  // forever), force the HTTP/1.1 server's connections closed while its native handle still exists
  // (Bun's close() drops it), then stop accepting and wait for the servers to report closed.
  let stopped: Promise<void> | null = null;
  const shutdown = () => {
    stopped ??= (async () => {
      closing = true;
      for (const socket of upgrades) socket.destroy();
      for (const socket of spliced) socket.destroy();
      for (const session of sessions) session.destroy();
      for (const socket of h2Sockets) socket.destroy();
      server.closeAllConnections();
      await Promise.all(servers.map(closeServer));
    })();
    return stopped;
  };
  try {
    http1Port = await listenLoopback(server);
    h2Port = await listenLoopback(h2Server);
    const port = await listenLoopback(front);
    return { port, close: shutdown };
  } catch (error) {
    await shutdown();
    throw error;
  }
}
