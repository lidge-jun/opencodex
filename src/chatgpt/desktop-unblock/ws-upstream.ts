import { connect as connectSocket } from "node:net";
import { checkServerIdentity, connect as connectTls } from "node:tls";
import type { RuntimePacPolicy } from "./pac-policy";
import { effectiveProxyFor } from "../../lib/proxy-env";
import { socks5Credentials, socks5Handshake } from "../../lib/socks5-handshake";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

/**
 * Shared socket dialer for the ChatGPT intercept's HTTP and WebSocket transports.
 * Runtime PAC policy owns route selection when configured. Otherwise the legacy
 * environment/config proxy selection remains intact. Direct, HTTP(S) CONNECT and
 * SOCKS5 all terminate in one verified TLS socket handed to the requesting transport.
 */

export const CHATGPT_UPSTREAM_HOST = "chatgpt.com";
export const CHATGPT_UPSTREAM_TLS_PORT = 443;

/** How the tunnel reached chatgpt.com; surfaced for tests and diagnostics. */
export interface UpstreamTunnel {
  socket: TLSSocket;
  route: "direct" | "http-connect" | "socks5";
}

export interface DialUpstreamOptions {
  /** Runtime-owned policy; when present neither environment proxies nor implicit DIRECT apply. */
  policy?: RuntimePacPolicy;
  /** Original upstream URL, including scheme, path and query, for per-request PAC evaluation. */
  requestUrl?: string;
  signal?: AbortSignal;
  /** Absolute response-header deadline (HTTP and WebSocket), milliseconds. */
  headersTimeoutMs?: number;
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

class HttpProxyHandshakeError extends Error {
  override readonly name = "HttpProxyHandshakeError";
}

/**
 * Establish the TLS connection to chatgpt.com the relay pipes frames through.
 * Resolves null when the TCP dial, the proxy handshake, or the TLS handshake fails
 * within the timeout, so the fetch handler can answer the app with a plain 502
 * instead of hanging the upgrade.
 */
export async function dialUpstreamTunnel(options: DialUpstreamOptions = {}): Promise<UpstreamTunnel | null> {
  const timeout = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const { signal } = options;
  try {
    signal?.throwIfAborted();
    const proxies = options.policy
      ? await resolvePolicy(options.policy, options.requestUrl ?? `https://${CHATGPT_UPSTREAM_HOST}/`, signal)
      : [options.proxy !== undefined ? options.proxy : effectiveProxyFor(new URL(`https://${CHATGPT_UPSTREAM_HOST}`), process.env)];
    const target = options.target ?? { host: CHATGPT_UPSTREAM_HOST, port: CHATGPT_UPSTREAM_TLS_PORT };
    for (const proxy of proxies) {
      signal?.throwIfAborted();
      const route: UpstreamTunnel["route"] = proxy === null ? "direct" : socks5Route(proxy) ? "socks5" : "http-connect";
      try {
        const raw = await dialRaw(target, proxy, route, timeout, options.ca, signal);
        const socket = await wrapTls(raw, CHATGPT_UPSTREAM_HOST, timeout, options.ca, signal);
        if (signal?.aborted) { socket.destroy(); return null; }
        return { socket, route };
      } catch (error) {
        // Only an unreachable TCP/DNS endpoint may advance the policy. Once connected,
        // any CONNECT/SOCKS response, TLS failure or later application failure is final.
        if (!options.policy || !(error instanceof TcpUnavailableError) || signal?.aborted) return null;
      }
    }
  } catch { /* Policy failure, cancellation and malformed settings all fail closed. */ }
  return null;
}

async function resolvePolicy(policy: RuntimePacPolicy, url: string, signal?: AbortSignal): Promise<readonly (string | null)[]> {
  if (!signal) return policy.resolve(url);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new Error("upstream request aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => policy.resolve(url, signal)).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

class TcpUnavailableError extends Error {}
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]);

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

/**
 * Port to dial for a proxy URL. `URL.port` is empty both when the port is omitted and when it
 * equals the scheme default, so `http://proxy:80` must fall back to 80, never to an invented
 * 8080; that would diverge from the fetch tunnel, which honors the URL as written.
 */
export function proxyDialPort(proxyUrl: URL, route: UpstreamTunnel["route"]): number {
  const explicit = Number(proxyUrl.port);
  if (explicit) return explicit;
  if (route === "socks5") return 1080;
  return proxyUrl.protocol === "https:" ? 443 : 80;
}

async function dialRaw(target: RawTarget, proxy: string | null, route: UpstreamTunnel["route"], timeout: number, ca: string | undefined, signal?: AbortSignal): Promise<Socket> {
  if (route === "direct") return tcpConnect(target.host, target.port, timeout, signal);
  const proxyUrl = new URL(proxy!);
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, "");
  const proxyPort = proxyDialPort(proxyUrl, route);
  const proxySocket = await tcpConnect(proxyHost, proxyPort, timeout, signal);
  // An https:// proxy speaks TLS on its own port before any handshake, so the CONNECT
  // request must ride that TLS session, with the proxy's hostname as the SNI.
  const plain = proxyUrl.protocol === "https:" ? await wrapTls(proxySocket, proxyHost, timeout, ca, signal) : proxySocket;
  if (plain !== proxySocket) {
    plain.once("error", () => proxySocket.destroy());
  }
  const reader = new ProxyHandshakeReader(plain, timeout, signal);
  const socks5 = route === "socks5";
  try {
    // A socks5:// URL with credentials must authenticate here exactly as the fetch tunnel
    // would with the same URL; refusing selection instead would disable voice and dictation
    // for proxies fetch traffic handles fine. Credential decoding stays inside the try so a
    // malformed URL destroys the proxy socket instead of leaking it.
    const credentials = socks5 ? socks5Credentials(proxyUrl) : {};
    if (!socks5) await httpConnectThrough(reader, target, proxyUrl);
    else await socks5Handshake(reader, target, credentials);
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

async function tcpConnect(host: string, port: number, timeout: number, signal?: AbortSignal): Promise<Socket> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host, port });
    // A permanent guard covers the microtask gaps between connection, handshake and owner.
    socket.on("error", () => {});
    let settled = false;
    const timer = setTimeout(() => finish(new TcpUnavailableError("TCP connection timed out")), timeout);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("connect", onConnect);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) { socket.destroy(); reject(error); } else resolve(socket);
    };
    const onError = (error: NodeJS.ErrnoException) => finish(UNREACHABLE_CODES.has(error.code ?? "")
      ? new TcpUnavailableError("TCP endpoint is unreachable") : error);
    const onAbort = () => finish(new Error("upstream request aborted"));
    const onClose = () => finish(new Error("TCP connection closed"));
    const onConnect = () => finish();
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("connect", onConnect);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Accumulates proxy-handshake bytes until each awaited step has what it needs, then
 * hands any leftover bytes back to the socket so the TLS layer above sees a clean
 * stream. A socket error, timeout, or a proxy that closes the connection before finishing
 * its reply fails every pending step, so the upgrade answers 502 instead of hanging; after
 * `dispose()` the reader no longer owns the socket's data, end, or close events.
 */
class ProxyHandshakeReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending: { ready: (buffer: Buffer) => boolean; resolve: () => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer) => this.feed(chunk);
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onTimeout = () => this.fail(new Error("proxy handshake timeout"));
  private readonly onAbort = () => this.fail(new Error("upstream request aborted"));
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onClosed = () => this.fail(new Error("proxy closed the connection during the handshake"));

  constructor(private readonly socket: Socket, timeout: number, private readonly signal?: AbortSignal) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onClosed);
    socket.on("close", this.onClosed);
    this.timer = setTimeout(this.onTimeout, timeout);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  write(bytes: Uint8Array | string): void {
    if (this.failure) throw this.failure;
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
    if (this.failure) return;
    if (this.buffer.length + chunk.length > 64 * 1024) { this.fail(new Error("proxy handshake is too large")); return; }
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
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.onAbort);
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.removeListener("end", this.onClosed);
    this.socket.removeListener("close", this.onClosed);
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
  if (proxyUrl.username || proxyUrl.password) {
    let credentials: string;
    try {
      credentials = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64");
    } catch {
      throw new HttpProxyHandshakeError("HTTP proxy credentials contain invalid percent encoding");
    }
    lines.push(`Proxy-Authorization: Basic ${credentials}`);
  }
  reader.write([...lines, "", ""].join(CRLF));
  const head = await reader.readHttpHead();
  const statusLine = head.split(CRLF)[0]!;
  if (!/^HTTP\/1\.[01] 2\d\d(?:[ \t]|$)/.test(statusLine)) throw new Error(`proxy refused CONNECT: ${statusLine}`);
}

/** Verify the named peer explicitly, including IP-literal HTTPS proxies without SNI. */
async function wrapTls(raw: Socket, peer: string, timeout: number, ca: string | undefined, signal?: AbortSignal): Promise<TLSSocket> {
  if (signal?.aborted) { raw.destroy(); signal.throwIfAborted(); }
  return new Promise((resolve, reject) => {
    let tls: TLSSocket;
    try {
      tls = connectTls({
        socket: raw, host: peer, rejectUnauthorized: true,
        ...(!isIpLiteral(peer) ? { servername: peer } : {}), ...(ca ? { ca } : {}),
        checkServerIdentity: (_hostname, cert) => checkServerIdentity(peer, cert),
      });
    } catch (error) { raw.destroy(); reject(error); return; }
    tls.on("error", () => {});
    let settled = false;
    const timer = setTimeout(() => finish(new Error("TLS handshake timeout")), timeout);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      tls.removeListener("error", onError);
      tls.removeListener("close", onClose);
      tls.removeListener("secureConnect", onSecure);
      if (error) { tls.destroy(); raw.destroy(); reject(error); } else resolve(tls);
    };
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(new Error("upstream request aborted"));
    const onClose = () => finish(new Error("TLS connection closed"));
    const onSecure = () => {
      try {
        const identityError = checkServerIdentity(peer, tls.getPeerCertificate());
        finish(!tls.authorized ? new Error("upstream TLS certificate is not trusted") : identityError);
      } catch (error) { finish(error instanceof Error ? error : new Error("TLS identity check failed")); }
    };
    tls.once("error", onError);
    tls.once("close", onClose);
    tls.once("secureConnect", onSecure);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
