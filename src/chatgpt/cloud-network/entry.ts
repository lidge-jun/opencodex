import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { dialTunnel, type OpaqueProxyRoute } from "../../lib/opaque-proxy-tunnel";
import { CLOUD_HOST } from "./contract";

const TARGET = { host: CLOUD_HOST, port: 443 };

/** Proxy string to opaque route; validation errors surface as a failed dial, not a fallback. */
function proxyRoute(proxy: string): OpaqueProxyRoute {
  const url = new URL(proxy);
  const protocol = url.protocol;
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(protocol)) throw new Error(`Unsupported cloud proxy protocol: ${protocol}`);
  const credentials = url.username || url.password
    ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
    : {};
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port) || (protocol === "https:" ? 443 : protocol.startsWith("socks") ? 1080 : 80),
    ...credentials,
    kind: protocol === "https:" ? "https" : protocol.startsWith("socks") ? protocol.slice(0, -1) as "socks5" | "socks5h" : "http",
  } as OpaqueProxyRoute;
}

/** The runtime binds loopback 443; isolated tests supply ephemeral ports. */
export async function startCloudEntry({ proxy, port }: { proxy: string; port: number }) {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const establishment = new AbortController();
  let stopped = false;
  const dial = async () => {
    try {
      return await dialTunnel(`${TARGET.host}:${TARGET.port}`, proxyRoute(proxy), { signal: establishment.signal });
    } catch {
      return null;
    }
  };
  const stop = async () => {
    stopped = true;
    establishment.abort();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  };
  const accept = async (client: Socket) => {
    sockets.add(client);
    client.pause();
    client.on("error", () => client.destroy());
    client.once("close", () => sockets.delete(client));
    const upstream = await dial();
    if (!upstream || stopped || client.destroyed) { upstream?.destroy(); client.destroy(); return; }
    sockets.add(upstream);
    upstream.on("error", () => { client.destroy(); upstream.destroy(); });
    upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
    client.once("close", () => upstream.destroy());
    // Stream.pipe supplies backpressure. The desktop, not this entry, owns TLS/SNI.
    client.pipe(upstream).pipe(client);
    client.resume();
    upstream.resume();
  };
  try {
    const endpoints = [];
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(client => { void accept(client); });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port, ipv6Only: host === "::1" }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      endpoints.push({ host, port: (server.address() as AddressInfo).port });
    }
    const probe = await dial();
    if (!probe) throw new Error("Cloud CONNECT preflight failed; no mapping applied");
    probe.destroy();
    return { endpoints, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
