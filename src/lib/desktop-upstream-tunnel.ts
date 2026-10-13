import { connect as tcpConnect, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from "node:tls";
import { desktopProxyFor } from "./desktop-proxy-route";
import { socks5Credentials, socks5Handshake } from "./socks5-handshake";

// Shares the SOCKS exchange extracted by lcxhh521 in PR #5947 (efdccdbfac3f).
// Lifecycle here additionally bounds the entire dial and handles close/abort/header limits.
export interface DesktopTunnelOptions {
  proxy?: string | false;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Isolated test peers; production always uses verified TLS to chatgpt.com:443. */
  target?: { host: string; port: number };
  ca?: string;
  proxyCa?: string;
}
const fail = () => new Error("desktop_upstream_connection_failed");
class HandshakeReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private failure: Error | null = null;
  private waiting: { ready: () => boolean; resolve: () => void; reject: (error: Error) => void } | null = null;
  private onData = (chunk: Buffer) => {
    if (this.buffer.length + chunk.length > 65536) { this.onFailure(); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.waiting?.ready()) { const current = this.waiting; this.waiting = null; current.resolve(); }
  };
  private onFailure = () => { this.failure = fail(); const current = this.waiting; this.waiting = null; current?.reject(this.failure); };
  constructor(private socket: Socket, private signal: AbortSignal) {
    socket.on("data", this.onData); socket.once("error", this.onFailure); socket.once("end", this.onFailure); socket.once("close", this.onFailure);
    signal.addEventListener("abort", this.onFailure, { once: true }); if (signal.aborted) this.onFailure(); socket.resume();
  }
  write(bytes: Uint8Array | string): void { if (this.failure) throw this.failure; this.socket.write(bytes); }
  private async until(ready: () => boolean): Promise<void> {
    if (this.failure) throw this.failure;
    if (ready()) return;
    if (this.waiting) throw fail();
    await new Promise<void>((resolve, reject) => { this.waiting = { ready, resolve, reject }; });
  }
  private take(length: number): Buffer { const out = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length); return out; }
  async readExact(length: number): Promise<Buffer> { await this.until(() => this.buffer.length >= length); return this.take(length); }
  async readHead(): Promise<string> { await this.until(() => this.buffer.indexOf("\r\n\r\n") >= 0); return this.take(this.buffer.indexOf("\r\n\r\n") + 4).toString("latin1"); }
  dispose(): void {
    this.socket.pause(); this.socket.removeListener("data", this.onData); this.socket.removeListener("error", this.onFailure);
    this.socket.removeListener("end", this.onFailure); this.socket.removeListener("close", this.onFailure);
    this.signal.removeEventListener("abort", this.onFailure);
    if (this.buffer.length) this.socket.unshift(this.buffer); this.buffer = Buffer.alloc(0); this.onFailure();
  }
}
function waitConnected(socket: Socket, event: "connect" | "secureConnect", signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const dispose = () => { socket.off(event, done); socket.off("error", failure); socket.off("close", failure); signal.removeEventListener("abort", failure); };
    const done = () => { dispose(); resolve(); };
    const failure = () => { dispose(); reject(fail()); };
    socket.once(event, done); socket.once("error", failure); socket.once("close", failure);
    signal.addEventListener("abort", failure, { once: true }); if (signal.aborted) failure();
  });
}
/** Fixed-destination TLS dial for native desktop upgraded sockets. No logs or direct fallback. */
export async function dialDesktopUpstream(options: DesktopTunnelOptions = {}): Promise<TLSSocket> {
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw fail();
  const cancel = new AbortController(), timer = setTimeout(() => cancel.abort(), timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, cancel.signal]) : cancel.signal;
  const sockets = new Set<Socket>();
  const own = <T extends Socket>(socket: T): T => { sockets.add(socket); socket.on("error", () => {}); return socket; };
  const destroy = () => { for (const socket of sockets) socket.destroy(); };
  signal.addEventListener("abort", destroy, { once: true });
  try {
    if (signal.aborted) throw fail();
    const proxy = options.proxy === undefined ? desktopProxyFor(new URL("https://chatgpt.com")) : options.proxy;
    const target = options.target ?? { host: "chatgpt.com", port: 443 };
    let raw: Socket;
    if (proxy === false) {
      raw = own(tcpConnect(target)); await waitConnected(raw, "connect", signal);
    } else {
      const url = new URL(proxy), protocol = url.protocol;
      if (!["http:", "https:", "socks5:", "socks5h:"].includes(protocol) || !url.hostname || url.search || url.hash || url.pathname !== "" && url.pathname !== "/") throw fail();
      const host = url.hostname.replace(/^\[|\]$/g, ""), port = Number(url.port) || (protocol === "https:" ? 443 : protocol.startsWith("socks") ? 1080 : 80);
      raw = own(tcpConnect({ host, port })); await waitConnected(raw, "connect", signal);
      if (protocol === "https:") {
        raw = own(tlsConnect({ socket: raw, servername: isIP(host) ? undefined : host, ca: options.proxyCa,
          rejectUnauthorized: true, checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate), ALPNProtocols: ["http/1.1"] }));
        await waitConnected(raw, "secureConnect", signal);
      }
      const reader = new HandshakeReader(raw, signal);
      try {
        if (protocol.startsWith("socks")) await socks5Handshake(reader, target, socks5Credentials(url));
        else {
          const authority = `${target.host}:${target.port}`;
          const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
          if (url.username || url.password) lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`);
          reader.write(lines.join("\r\n") + "\r\n\r\n");
          if (!/^HTTP\/1\.[01] 2\d\d(?: |\r)/.test(await reader.readHead())) throw fail();
        }
      } finally { reader.dispose(); }
    }
    if (signal.aborted || raw.destroyed) throw fail();
    const secured = own(tlsConnect({ socket: raw, servername: "chatgpt.com", ca: options.ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] }));
    // The CONNECT reader paused its stream before handing buffered bytes back. Bun's
    // TLS-over-TLS path needs the outer TLS stream explicitly resumed for the new handshake.
    raw.resume();
    await waitConnected(secured, "secureConnect", signal);
    if (signal.aborted) throw fail();
    return secured;
  } catch { destroy(); throw fail(); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", destroy); }
}
