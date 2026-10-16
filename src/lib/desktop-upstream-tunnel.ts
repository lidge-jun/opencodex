import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { desktopProxyFor } from "./desktop-proxy-route";
import { dialTunnel, type OpaqueProxyRoute } from "./opaque-proxy-tunnel";

// The shared opaque dialer owns proxy framing; this caller owns fixed-target
// TLS and bounds the entire connection, including the target TLS handshake.
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
      const credentials = url.username || url.password
        ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
        : {};
      const endpoint = { host, port, ...credentials };
      const route: OpaqueProxyRoute = protocol === "https:"
        ? { ...endpoint, kind: "https", proxyCa: options.proxyCa }
        : { ...endpoint, kind: protocol.slice(0, -1) as "http" | "socks5" | "socks5h" };
      const authority = `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`;
      // The route resolver remains authoritative; a failed proxy never becomes DIRECT.
      raw = own(await dialTunnel(authority, route, { signal, timeoutMs: timeout, maxHeaderBytes: 65536 }));
    }
    if (signal.aborted || raw.destroyed) throw fail();
    // This consumer historically closes its writable side after peer EOF. The
    // shared opaque transport preserves half-closes for callers that need them.
    raw.allowHalfOpen = false;
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
