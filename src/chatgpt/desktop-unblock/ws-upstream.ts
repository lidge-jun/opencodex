import { connect as connectSocket } from "node:net";
import { connect as connectTls } from "node:tls";
import { effectiveProxyFor } from "../../lib/proxy-env";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

/**
 * Upstream transport for the ChatGPT desktop intercept's WebSocket relay.
 *
 * Bun's WebSocket client ignores proxy environment variables and has no proxy option
 * (verified on Bun 1.4.0), so the relay dials chatgpt.com itself over a raw socket it
 * fully controls. The dial honors the same proxy selection as every other outbound
 * request the server makes: `effectiveProxyFor` reads HTTP(S)_PROXY/ALL_PROXY, which
 * `applyProxyEnv` populates from `config.proxy` at startup. A configured http(s) proxy
 * is reached through an HTTP CONNECT tunnel; a SOCKS5 ALL_PROXY through a SOCKS5 CONNECT;
 * no proxy means a direct TLS connection. The VPN's own mode (system proxy / TUN / off)
 * therefore never has to be detected: the tunnel rides whatever egress opencodex already
 * uses for provider traffic.
 */

export const CHATGPT_UPSTREAM_HOST = "chatgpt.com";
export const CHATGPT_UPSTREAM_TLS_PORT = 443;

/** How the tunnel reached chatgpt.com; surfaced for tests and diagnostics. */
export interface UpstreamTunnel {
  socket: TLSSocket;
  route: "direct" | "http-connect" | "socks5";
}

export interface DialUpstreamOptions {
  /** Override the proxy picked from the environment; tests use it to point at a local proxy. */
  proxy?: string | null;
  /** Connect timeout for the TCP dial and the proxy handshake, milliseconds. */
  connectTimeoutMs?: number;
  /** Test seam: dial this address instead of chatgpt.com:443 (SNI still names chatgpt.com). */
  target?: { host: string; port: number };
  /** Test seam: trust this CA for the upstream certificate instead of the system store. */
  ca?: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

const CRLF = "\r\n";

/**
 * Establish the TLS connection to chatgpt.com the relay pipes frames through.
 * Resolves null when the TCP dial, the proxy handshake, or the TLS handshake fails
 * within the timeout, so the fetch handler can answer the app with a plain 502
 * instead of hanging the upgrade.
 */
export async function dialUpstreamTunnel(options: DialUpstreamOptions = {}): Promise<UpstreamTunnel | null> {
  const timeout = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const proxy = options.proxy !== undefined
    ? options.proxy
    : effectiveProxyFor(new URL(`https://${CHATGPT_UPSTREAM_HOST}`), process.env);
  const route: UpstreamTunnel["route"] = socks5Route(proxy) ? "socks5" : proxy ? "http-connect" : "direct";
  try {
    const target = options.target ?? { host: CHATGPT_UPSTREAM_HOST, port: CHATGPT_UPSTREAM_TLS_PORT };
    const raw = await dialRaw(target, proxy, route, timeout, options.ca);
    const socket = await wrapTls(raw, timeout, options.ca);
    return { socket, route };
  } catch {
    return null;
  }
}

interface RawTarget {
  host: string;
  port: number;
}

function socks5Route(proxy: string | null): boolean {
  return proxy !== null && /^socks5h?:\/\//i.test(proxy.trim());
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

async function dialRaw(target: RawTarget, proxy: string | null, route: UpstreamTunnel["route"], timeout: number, ca: string | undefined): Promise<Socket> {
  if (route === "direct") return tcpConnect(target.host, target.port, timeout);
  const proxyUrl = new URL(proxy!);
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, "");
  const proxyPort = Number(proxyUrl.port) || (route === "socks5" ? 1080 : proxyUrl.protocol === "https:" ? 443 : 8080);
  const proxySocket = await tcpConnect(proxyHost, proxyPort, timeout);
  // An https:// proxy speaks TLS on its own port before any handshake, so the CONNECT
  // request must ride that TLS session, with the proxy's hostname as the SNI.
  const plain = proxyUrl.protocol === "https:" ? await wrapProxyTls(proxySocket, proxyHost, timeout, ca) : proxySocket;
  if (plain !== proxySocket) {
    plain.once("error", () => proxySocket.destroy());
  }
  const reader = new ProxyHandshakeReader(plain, timeout);
  try {
    if (route === "http-connect") await httpConnectThrough(reader, target, proxyUrl);
    else await socks5ConnectThrough(reader, target);
  } catch (error) {
    reader.dispose();
    plain.destroy();
    throw error;
  }
  // Handshake done: hand leftover bytes and data events back to the socket so the TLS
  // layer above starts from a clean stream.
  reader.dispose();
  return plain;
}

async function tcpConnect(host: string, port: number, timeout: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host, port });
    const onError = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(timeout, () => onError(new Error("tcp connect timeout")));
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

/**
 * Accumulates proxy-handshake bytes until each awaited step has what it needs, then
 * hands any leftover bytes back to the socket so the TLS layer above sees a clean
 * stream. A socket error or timeout fails every pending step; after `dispose()` the
 * reader no longer owns the socket's data events.
 */
class ProxyHandshakeReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending: { ready: (buffer: Buffer) => boolean; resolve: () => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer) => this.feed(chunk);
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onTimeout = () => this.fail(new Error("proxy handshake timeout"));

  constructor(private readonly socket: Socket, timeout: number) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.setTimeout(timeout, this.onTimeout);
  }

  write(bytes: Buffer | string): void {
    this.socket.write(bytes);
  }

  /** Await until the buffer holds at least `bytes` bytes, then consume exactly that many. */
  readExact(bytes: number): Promise<Buffer<ArrayBufferLike>> {
    return this.wait(buffer => buffer.length >= bytes, () => this.consume(bytes));
  }

  /** Await the full HTTP response head (through the blank line), consuming it. */
  readHttpHead(): Promise<string> {
    return this.wait(
      buffer => buffer.indexOf("\r\n\r\n") !== -1,
      () => this.consume(this.buffer.indexOf("\r\n\r\n") + 4).toString("latin1"),
    );
  }

  /** Only one handshake step is ever outstanding, so one pending slot suffices. */
  private wait<T>(ready: (buffer: Buffer) => boolean, take: () => T): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (ready(this.buffer)) return Promise.resolve(take());
    return new Promise((resolve, reject) => {
      this.pending = { ready, resolve: () => resolve(take()), reject };
    });
  }

  private consume(bytes: number): Buffer<ArrayBufferLike> {
    const consumed: Buffer<ArrayBufferLike> = this.buffer.subarray(0, bytes);
    this.buffer = this.buffer.subarray(bytes);
    return consumed;
  }

  private feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? (chunk satisfies Buffer) : Buffer.concat([this.buffer, chunk]);
    if (this.pending && this.pending.ready(this.buffer)) {
      const waiter = this.pending;
      this.pending = null;
      waiter.resolve();
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    const waiter = this.pending;
    this.pending = null;
    waiter?.reject(error);
  }

  dispose(): void {
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.setTimeout(0);
    if (this.buffer.length > 0) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
    this.fail(new Error("proxy handshake reader disposed"));
  }
}

async function httpConnectThrough(reader: ProxyHandshakeReader, target: RawTarget, proxyUrl: URL): Promise<void> {
  const authority = `${target.host}:${target.port}`;
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    `Proxy-Connection: Keep-Alive`,
  ];
  // Credentials in the proxy URL become Basic Proxy-Authorization; an unauthenticated
  // proxy never sees the header.
  if (proxyUrl.username) {
    const credentials = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${credentials}`);
  }
  reader.write([...lines, "", ""].join(CRLF));
  const head = await reader.readHttpHead();
  const statusLine = head.split(CRLF)[0]!;
  if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) throw new Error(`proxy refused CONNECT: ${statusLine}`);
}

async function socks5ConnectThrough(reader: ProxyHandshakeReader, target: RawTarget): Promise<void> {
  // Byte-level SOCKS5 CONNECT (RFC 1928), no-auth only: proxy selection upstream of this
  // module never picks an authenticated SOCKS proxy it cannot hand to a raw socket.
  reader.write(Buffer.from([0x05, 0x01, 0x00])); // VER, 1 method, NO AUTH
  const greeting = await reader.readExact(2);
  if (greeting[0] !== 0x05 || greeting[1] !== 0x00) throw new Error("SOCKS5 greeting rejected");
  const hostBytes = Buffer.from(target.host, "utf8");
  reader.write(Buffer.from([
    0x05, // VER
    0x01, // CONNECT
    0x00, // RSV
    0x03, // ATYP = domain
    hostBytes.length,
    ...hostBytes,
    target.port >> 8,
    target.port & 0xff,
  ]));
  const replyHead = await reader.readExact(4);
  if (replyHead[0] !== 0x05 || replyHead[1] !== 0x00) throw new Error("SOCKS5 CONNECT refused");
  const atyp = replyHead[3]!;
  const addressLength = atyp === 0x01 ? 4 : atyp === 0x03 ? (await reader.readExact(1))[0]! : 16;
  await reader.readExact(addressLength + 2);
}

async function wrapTls(raw: Socket, timeout: number, ca: string | undefined): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = connectTls({ socket: raw, servername: CHATGPT_UPSTREAM_HOST, ...(ca ? { ca } : {}) });
    const onError = (error: Error) => { tls.destroy(); reject(error); };
    tls.setTimeout(timeout, () => onError(new Error("TLS handshake timeout")));
    tls.once("error", onError);
    tls.once("secureConnect", () => {
      tls.setTimeout(0);
      tls.removeListener("error", onError);
      resolve(tls);
    });
  });
}

/** TLS-wrap the proxy's own socket before the CONNECT handshake (https:// proxy URLs). */
async function wrapProxyTls(raw: Socket, proxyHost: string, timeout: number, ca: string | undefined): Promise<TLSSocket> {
  // An IP-literal proxy has no hostname to name in SNI; node:tls forbids it outright.
  const servername = isIpLiteral(proxyHost) ? undefined : proxyHost;
  return new Promise((resolve, reject) => {
    const tls = connectTls({ socket: raw, ...(servername ? { servername } : {}), ...(ca ? { ca } : {}) });
    const onError = (error: Error) => { tls.destroy(); reject(error); };
    tls.setTimeout(timeout, () => onError(new Error("proxy TLS handshake timeout")));
    tls.once("error", onError);
    tls.once("secureConnect", () => {
      tls.setTimeout(0);
      tls.removeListener("error", onError);
      resolve(tls);
    });
  });
}
