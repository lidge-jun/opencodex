import type { Server, ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { encodeWsFrame, parseWsFrames, WEBSOCKET_MAX_FRAME_BYTES, WsOpcode } from "./ws-frame";
import type { WsFrame } from "./ws-frame";
import { CHATGPT_UPSTREAM_HOST, dialUpstreamTunnel } from "./ws-upstream";
import type { DialUpstreamOptions, UpstreamTunnel } from "./ws-upstream";

/**
 * WebSocket upgrade relay for the ChatGPT desktop intercept.
 *
 * The app's voice/dictation stream (wss://chatgpt.com/dictation/stream) and any other
 * WebSocket endpoint on the intercepted apex host reach this listener as HTTP upgrades,
 * which the fetch-based relay cannot carry: it strips hop-by-hop headers. This module
 * performs the upgrade itself. It dials chatgpt.com (directly or through the configured
 * proxy, the same selection as every other outbound request), forwards the app's
 * handshake headers, awaits the upstream's 101, and only then completes the app's own
 * upgrade through Bun's WebSocket stack. From there messages pipe both directions: Bun
 * speaks WebSocket to the app, hand-rolled RFC 6455 framing speaks it to the upstream.
 *
 * Path-agnostic by design: every WebSocket endpoint on the intercepted host takes the
 * same pipe, so endpoints the app adds later need no allowlist. Nothing is logged and
 * no payload is inspected or rewritten.
 */

const HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long a client-initiated close waits for the upstream's closing handshake. */
const CLOSE_DRAIN_MS = 500;
/** Continuation frames accepted for one message before the relay gives up on it. */
const MAX_MESSAGE_CHUNKS = 1024;
/** Total payload bytes accepted for one fragmented message, mirroring the per-frame ceiling. */
const MAX_MESSAGE_BYTES = WEBSOCKET_MAX_FRAME_BYTES;

/**
 * Handshake headers the relay regenerates for the upstream leg. Extensions are dropped
 * so the upstream never negotiates permessage-deflate, which the hand-rolled framing
 * does not implement; Bun negotiates the app leg independently.
 */
const HANDSHAKE_REGENERATED_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
]);

/** Response headers that describe the upstream body or connection, not the relay's reply. */
const REFUSAL_STRIP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "upgrade",
]);

/** Data each upgraded app socket carries: its live relay. */
export interface WsRelaySocketData {
  relay: WsRelay;
}

/**
 * Whether the relay should take a request. Version 13 is the only RFC 6455 version; an
 * upgrade asking for anything else falls through to the HTTP relay unchanged.
 */
export function isRelayableUpgrade(request: Request): boolean {
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return false;
  return request.headers.get("sec-websocket-version") === "13";
}

/**
 * Handshake headers forwarded upstream: everything the app sent except the ones the relay
 * regenerates. Cookies, Origin, User-Agent and the offered subprotocols pass through.
 */
export function forwardedHandshakeHeaders(request: Request): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!HANDSHAKE_REGENERATED_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  return headers;
}

export type UpstreamHandshakeResult =
  | { ok: true; tunnel: UpstreamTunnel; protocol: string | null; early: Buffer }
  /** `head` is the upstream's response head when it answered without upgrading. */
  | { ok: false; head: string | null };

/**
 * Upstream half of the handshake: dial, send the app's request with a fresh key, await
 * the response head. Never throws; a failed dial or a refusal comes back as `ok: false`.
 * On success the tunnel is left paused so frames arriving before the app's socket
 * attaches wait in the socket instead of being dropped.
 */
export async function performUpstreamHandshake(
  request: Request,
  dialOptions: DialUpstreamOptions = {},
): Promise<UpstreamHandshakeResult> {
  const tunnel = await dialUpstreamTunnel(dialOptions);
  if (!tunnel) return { ok: false, head: null };
  const url = new URL(request.url);
  const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${CHATGPT_UPSTREAM_HOST}`];
  forwardedHandshakeHeaders(request).forEach((value, name) => lines.push(`${name}: ${value}`));
  lines.push(
    "Connection: Upgrade",
    "Upgrade: websocket",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
  );
  tunnel.socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  const response = await readResponseHead(tunnel.socket, HANDSHAKE_TIMEOUT_MS);
  if (response === null || !/^HTTP\/1\.[01] 101\b/.test(response.head)) {
    tunnel.socket.destroy();
    return { ok: false, head: response?.head ?? null };
  }
  const protocol = /^sec-websocket-protocol:[ \t]*([^\r\n]+)/im.exec(response.head)?.[1]?.trim() ?? null;
  return { ok: true, tunnel, protocol, early: response.early };
}

/** Read through the blank line; bytes after it are the first frames. Pauses the socket. */
export function readResponseHead(socket: TLSSocket, timeoutMs: number): Promise<{ head: string; early: Buffer } | null> {
  return new Promise(resolve => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result: { head: string; early: Buffer } | null) => {
      if (settled) return;
      settled = true;
      socket.removeListener("data", onData);
      socket.removeListener("error", onFailure);
      socket.removeListener("close", onFailure);
      // Until WsRelay.attach() installs its own handlers (or the socket is destroyed), a late
      // 'error' with no listener is thrown by the emitter and would take the whole proxy down.
      socket.on("error", () => {});
      socket.setTimeout(0);
      socket.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end !== -1) finish({ head: buffer.subarray(0, end).toString("latin1"), early: buffer.subarray(end + 4) });
    };
    const onFailure = () => finish(null);
    socket.on("data", onData);
    socket.once("error", onFailure);
    socket.once("close", onFailure);
    socket.setTimeout(timeoutMs, onFailure);
  });
}

/**
 * One live relay between an upgraded app socket and its upstream tunnel. Upstream
 * fragments are reassembled into whole messages because Bun's server socket sends whole
 * messages; text stays text and binary stays binary in both directions.
 */
export class WsRelay {
  private client: ServerWebSocket<WsRelaySocketData> | null = null;
  private pendingParse: Buffer = Buffer.alloc(0);
  private fragmentation: { opcode: WsOpcode; chunks: Buffer[]; bytes: number } | null = null;
  private clientClosed = false;
  private closed = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly tunnel: UpstreamTunnel,
    private readonly early: Buffer,
  ) {}

  /** Bun's `open` handler: start piping, beginning with any frames that beat the upgrade. */
  attach(client: ServerWebSocket<WsRelaySocketData>): void {
    this.client = client;
    const socket = this.tunnel.socket;
    socket.on("data", this.onTunnelData);
    socket.on("error", this.onTunnelFailure);
    socket.on("close", this.onTunnelFailure);
    if (this.early.length > 0) this.onTunnelData(this.early);
    socket.resume();
  }

  /** Bun's `message` handler: app -> upstream, message type preserved. */
  clientMessage(message: string | Buffer): void {
    if (this.clientClosed || this.closed) return;
    const frame = typeof message === "string"
      ? encodeWsFrame(WsOpcode.TEXT, Buffer.from(message, "utf8"))
      : encodeWsFrame(WsOpcode.BINARY, message);
    this.tunnel.socket.write(frame);
  }

  /** Bun's `close` handler: forward the app's close, then give the upstream a moment to answer. */
  clientClose(code: number, reason: string): void {
    if (this.clientClosed || this.closed) return;
    this.clientClosed = true;
    const reasonBytes = Buffer.from(reason ?? "", "utf8");
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(sendableCloseCode(code), 0);
    reasonBytes.copy(payload, 2);
    this.tunnel.socket.write(encodeWsFrame(WsOpcode.CLOSE, payload));
    this.drainTimer = setTimeout(() => this.shutdown(), CLOSE_DRAIN_MS);
  }

  /** Tear down a relay whose app-side upgrade never completed. */
  abort(): void {
    this.shutdown();
  }

  private readonly onTunnelData = (chunk: Buffer): void => {
    const { frames, violation, rest } = parseWsFrames(chunk, this.pendingParse);
    this.pendingParse = rest;
    for (const frame of frames) this.handleUpstreamFrame(frame);
    if (violation !== null) this.failClient(1002, "upstream protocol error");
  };

  /** Upstream vanished without a closing handshake: the app sees an abnormal closure. */
  private readonly onTunnelFailure = (): void => {
    if (this.closed) return;
    this.shutdown();
    try {
      this.client?.terminate();
    } catch {
      // Already gone.
    }
  };

  private handleUpstreamFrame(frame: WsFrame): void {
    if (this.closed) return;
    const { opcode, fin, payload } = frame;
    if (opcode === WsOpcode.TEXT || opcode === WsOpcode.BINARY) {
      // A new data frame mid-fragmentation is a protocol violation; the relay restarts
      // assembly rather than tearing the connection down over it.
      this.fragmentation = { opcode, chunks: [payload], bytes: payload.length };
      if (fin) this.flushMessage();
      return;
    }
    if (opcode === WsOpcode.CONTINUATION) {
      if (this.fragmentation === null) return;
      this.fragmentation.chunks.push(payload);
      this.fragmentation.bytes += payload.length;
      if (this.fragmentation.chunks.length > MAX_MESSAGE_CHUNKS || this.fragmentation.bytes > MAX_MESSAGE_BYTES) {
        this.failClient(1009, "message too fragmented");
        return;
      }
      if (fin) this.flushMessage();
      return;
    }
    if (opcode === WsOpcode.PING) {
      this.tunnel.socket.write(encodeWsFrame(WsOpcode.PONG, payload));
      return;
    }
    if (opcode === WsOpcode.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      this.shutdown();
      try {
        this.client?.close(sendableCloseCode(code), reason);
      } catch {
        // The app already closed.
      }
    }
    // PONG: a keepalive answer to nothing the relay sent; ignore.
  }

  private flushMessage(): void {
    const { opcode, chunks } = this.fragmentation!;
    this.fragmentation = null;
    const message = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    try {
      // Send the Buffer itself: for a view, `message.buffer` spans bytes outside the message.
      if (opcode === WsOpcode.TEXT) this.client!.send(message.toString("utf8"));
      else this.client!.send(message);
    } catch {
      this.onTunnelFailure();
    }
  }

  private failClient(code: number, reason: string): void {
    if (this.closed) return;
    this.shutdown();
    try {
      this.client?.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  private shutdown(): void {
    this.closed = true;
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.tunnel.socket.destroy();
  }
}

/**
 * Codes an endpoint may put in a close frame. 1005/1006/1015 are reserved for reporting
 * and 1004 is undefined; anything outside the registered and application ranges maps to 1000.
 */
export function sendableCloseCode(code: number): number {
  if (code === 1004 || code === 1005 || code === 1006 || code === 1015) return 1000;
  if (code >= 1000 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

/**
 * The listener's fetch-handler entry for WebSocket upgrades. The upstream handshake
 * finishes first, so the app's upgrade only succeeds once chatgpt.com has accepted;
 * an unreachable or refusing upstream surfaces as an ordinary failed upgrade.
 */
export async function handleWebSocketUpgrade(
  request: Request,
  server: Server<WsRelaySocketData>,
  dialOptions: DialUpstreamOptions = {},
): Promise<Response | undefined> {
  const handshake = await performUpstreamHandshake(request, dialOptions);
  if (!handshake.ok) return refusalResponse(handshake.head);
  const relay = new WsRelay(handshake.tunnel, handshake.early);
  const upgraded = server.upgrade(request, {
    data: { relay },
    // Bun rejects an empty headers object, so omit it when there is no subprotocol.
    ...(handshake.protocol ? { headers: { "sec-websocket-protocol": handshake.protocol } } : {}),
  });
  if (!upgraded) {
    relay.abort();
    return new Response("websocket upgrade failed", { status: 400 });
  }
  return undefined;
}

/** Answer a failed upstream handshake: the upstream's own status and headers, or a 502. */
function refusalResponse(head: string | null): Response {
  if (head === null) return new Response("chatgpt upstream unreachable", { status: 502 });
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  const status = match ? Number(match[1]) : 502;
  // A Response cannot carry a 1xx status; anything but 101 still means "no upgrade".
  const safeStatus = status >= 200 && status <= 599 ? status : 502;
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (!REFUSAL_STRIP_HEADERS.has(name.toLowerCase())) headers.append(name, line.slice(colon + 1).trim());
  }
  return new Response(null, { status: safeStatus, statusText: match?.[2] ?? "", headers });
}
