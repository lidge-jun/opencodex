import { createServer } from "node:https";
import { connect as connectTls } from "node:tls";
import { Readable, type Duplex } from "node:stream";
import type { PemKeyPair } from "../../claude/intercept/local-ca";
import { forwardHeadersForUpstream } from "../../claude/intercept/listener";
import { effectiveProxyFor } from "../../lib/proxy-env";

const ORIGIN = "https://chatgpt.com";
const STRIP = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "alt-svc", "proxy-authenticate"]);
export interface DesktopRelayOptions {
  leaf: PemKeyPair;
  fetchImpl: typeof fetch;
  /** Test-only TLS peer; the production destination is fixed, never taken from a request. */
  websocketPeer?: { host: string; port: number; ca: string };
}

/** Transparent HTTP and raw upgraded-socket relay. Only fetchImpl owns usage policy. */
export async function startDesktopRelay(options: DesktopRelayOptions) {
  // Preserve all app features together. Until the shared proxy-aware WS transport lands,
  // refuse this optional integration rather than silently bypass configured egress.
  if (!options.websocketPeer && effectiveProxyFor(new URL(ORIGIN), process.env)) throw new Error("desktop_compatibility_egress_proxy_unsupported");
  const sockets = new Set<Duplex>(), requests = new Set<AbortController>();
  const server = createServer({ cert: options.leaf.certPem, key: options.leaf.keyPem, ALPNProtocols: ["http/1.1"] });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const valid = (host: string | undefined, path: string | undefined) =>
    (host === "chatgpt.com" || host === "chatgpt.com:443") && !!path && path.startsWith("/") && !path.startsWith("//");
  server.on("request", (req, res) => {
    if (!valid(req.headers.host, req.url)) { res.writeHead(421); res.end(); return; }
    const abort = new AbortController(); requests.add(abort);
    const finish = () => { requests.delete(abort); abort.abort(); };
    res.once("close", finish); req.once("error", finish);
    void (async () => {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const method = req.method ?? "GET";
      const response = await options.fetchImpl(ORIGIN + req.url, {
        method, headers: forwardHeadersForUpstream(headers), redirect: "manual", signal: abort.signal,
        // Node's and Bun's declarations disagree on BYOB overloads; both implement Web streams.
        body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
        // @ts-expect-error Node-compatible streaming fetch requires half duplex.
        duplex: "half",
      });
      if (res.destroyed) { await response.body?.cancel(); return; }
      const output: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => { if (!STRIP.has(key) && key !== "set-cookie") output[key] = value; });
      const cookies = response.headers.getSetCookie(); if (cookies.length) output["set-cookie"] = cookies;
      res.writeHead(response.status, output);
      if (!response.body || method === "HEAD") { await response.body?.cancel(); res.end(); return; }
      const body = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
      body.once("error", () => res.destroy()); res.once("close", () => body.destroy()); body.pipe(res);
    })().catch(() => {
      if (res.headersSent) res.destroy(); else { res.writeHead(502, { "Content-Length": "0" }); res.end(); }
    });
  });
  server.on("upgrade", (req, client, head) => {
    if (!valid(req.headers.host, req.url)) { client.end("HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
    const peer = options.websocketPeer;
    const upstream = connectTls({ host: peer?.host ?? "chatgpt.com", port: peer?.port ?? 443,
      servername: "chatgpt.com", ca: peer?.ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
    sockets.add(upstream);
    let established = false;
    const fail = () => {
      if (!established && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      else client.destroy();
      upstream.destroy();
    };
    upstream.setTimeout(10_000, fail);
    upstream.once("secureConnect", () => {
      if (client.destroyed) { upstream.destroy(); return; }
      established = true; upstream.setTimeout(0);
      const lines = [`${req.method ?? "GET"} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!/^proxy-(?:authorization|connection)$/i.test(req.rawHeaders[i]!)) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.once("error", fail); client.once("error", () => upstream.destroy());
    upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
    client.once("close", () => upstream.destroy());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { server.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("desktop_compatibility_listener_unavailable");
  let closing: Promise<void> | null = null;
  return { port: address.port, close() {
    if (closing) return closing;
    for (const abort of requests) abort.abort();
    for (const socket of sockets) socket.destroy();
    closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); return closing;
  } };
}
