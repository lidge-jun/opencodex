import assert from "node:assert/strict";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { createCertificateAuthority, issueServerLeaf } from "../../src/claude/intercept/local-ca";
import type { OpaqueProxyRoute } from "../../src/lib/opaque-proxy-tunnel";
import { listen, TunnelFixtureScope } from "./opaque-proxy-tunnel";

// Runtime-only keys, never persisted or added to an OS trust store. Proxy and target
// use separate leaf identities; clients explicitly trust only this fixture CA.
const commonName = "opaque tunnel fixture CA";
const authority = createCertificateAuthority({ commonName, validityDays: 1 });
export const ca = authority.certPem;
const originIdentity = issueServerLeaf(authority, commonName, ["origin.fixture.invalid"]);
const wrongProxyIdentity = issueServerLeaf(authority, commonName, ["wrong.fixture.invalid"]);
const proxyIdentity = issueServerLeaf(authority, commonName, ["127.0.0.1"]);
export const credentials = { username: "fixture-user", password: "fixture-páss" };
const basic = "Basic " + Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");
export type ProxyKind = "http" | "https" | "socks5" | "socks5h";
export const proxyKinds: readonly ProxyKind[] = ["http", "https", "socks5", "socks5h"];

export async function origin(scope: TunnelFixtureScope, { slow = false, drop = false } = {}) {
  const sockets = new Set<Socket>(), received: Buffer[] = [];
  let calls = 0;
  const server = tls.createServer({ key: originIdentity.keyPem, cert: originIdentity.certPem, allowHalfOpen: true }, socket => {
    calls++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    let writes = 0, ended = false;
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      if (drop) { socket.destroy(); return; }
      if (slow) {
        writes++;
        socket.pause();
        scope.later(() => {
          writes--;
          if (socket.destroyed) return;
          socket.write(chunk);
          if (ended && !writes) socket.end(); else socket.resume();
        }, 2);
      } else socket.write(chunk);
    });
    socket.once("end", () => { ended = true; if (!writes) socket.end(); });
  });
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  const port = await listen(scope, server, sockets);
  return { port, authority: `origin.fixture.invalid:${port}`, received, calls: () => calls };
}

type ProxyOptions = {
  mode?: "ok" | "hang" | "partial" | "refuse" | "policy" | "early-large";
  destination?: Awaited<ReturnType<typeof origin>>;
  requireAuth?: boolean;
  fragmented?: boolean;
  wrongIdentity?: boolean;
};

export async function protocolProxy(scope: TunnelFixtureScope, kind: ProxyKind, {
  mode = "ok", destination, requireAuth = true, fragmented = false, wrongIdentity = false,
}: ProxyOptions = {}) {
  const sockets = new Set<Socket>();
  const seen = { connections: 0, handshakes: 0, auth: 0, targets: [] as Array<{ host: string; port: number }>, opaque: [] as Buffer[], applicationBytes: 0, clientEnds: 0 };
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const handle = (socket: Socket) => {
    socket.allowHalfOpen = true;
    own(socket);
    seen.handshakes++;
    let buffer = Buffer.alloc(0), stage = 0;
    const send = (bytes: Buffer | number[]) => {
      const data = Buffer.from(bytes);
      if (!fragmented) socket.write(data);
      else for (let i = 0; i < data.length; i++) {
        scope.later(() => { if (!socket.destroyed) socket.write(data.subarray(i, i + 1)); }, i);
      }
    };
    socket.once("end", () => { seen.clientEnds++; });
    const onEnd = () => socket.end();
    socket.once("end", onEnd);
    const tunnel = (host: string, port: number, head = Buffer.alloc(0)) => {
      seen.targets.push({ host, port });
      socket.removeListener("data", onData);
      socket.pause();
      if (mode === "early-large") {
        socket.write(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), Buffer.alloc(192 * 1024, 0xa5)]));
        return;
      }
      assert.ok(destination, "test destination required");
      assert.equal(host, "origin.fixture.invalid");
      assert.equal(port, destination.port);
      // All target routing stays on loopback. The .invalid name is forwarded verbatim.
      const upstream = own(net.connect({ port: destination.port, host: "127.0.0.1", allowHalfOpen: true }));
      upstream.once("connect", () => {
        const connected = kind.startsWith("socks")
          ? Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
          : Buffer.from("HTTP/1.1 200 Established\r\n\r\n");
        send(connected);
        scope.later(() => {
          if (socket.destroyed || upstream.destroyed) return;
          socket.removeListener("end", onEnd);
          socket.on("data", (chunk: Buffer) => seen.opaque.push(chunk));
          socket.once("close", () => { if (!socket.readableEnded) upstream.destroy(); });
          upstream.once("close", () => { if (!upstream.readableEnded) socket.destroy(); });
          socket.once("error", () => upstream.destroy());
          upstream.once("error", () => socket.destroy());
          if (head.length) socket.unshift(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        }, fragmented ? connected.length + 3 : 0);
      });
    };
    const onData = (data: Buffer) => {
      seen.applicationBytes += data.length;
      buffer = Buffer.concat([buffer, data]);
      if (mode === "hang") return;
      if (mode === "partial") {
        socket.removeListener("data", onData);
        socket.write(kind.startsWith("socks") ? Buffer.from([5]) : "HTTP/1.1 4");
        return;
      }
      if (!kind.startsWith("socks")) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString("latin1");
        if (mode === "refuse" || (requireAuth && !header.includes(`Proxy-Authorization: ${basic}`))) {
          socket.end("HTTP/1.1 407 Authentication Required\r\n\r\n");
          return;
        }
        if (requireAuth) seen.auth++;
        const requested = /^CONNECT ([^ ]+) HTTP\/1\.1/.exec(header)?.[1];
        assert.ok(requested);
        const colon = requested.lastIndexOf(":");
        tunnel(requested.slice(0, colon), Number(requested.slice(colon + 1)), buffer.subarray(end + 4));
        return;
      }
      for (;;) {
        if (stage === 0) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          assert.equal(buffer[0], 5);
          if (requireAuth) assert.ok(buffer.subarray(2, 2 + buffer[1]).includes(2));
          buffer = buffer.subarray(2 + buffer[1]);
          send([5, requireAuth ? 2 : 0]);
          stage = requireAuth ? 1 : 2;
        } else if (stage === 1) {
          if (buffer.length < 2) return;
          const userLength = buffer[1];
          if (buffer.length < 3 + userLength) return;
          const passwordLength = buffer[2 + userLength];
          if (buffer.length < 3 + userLength + passwordLength) return;
          const username = buffer.subarray(2, 2 + userLength).toString();
          const password = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
          assert.equal(buffer[0], 1);
          buffer = buffer.subarray(3 + userLength + passwordLength);
          if (mode === "refuse" || username !== credentials.username || password !== credentials.password) {
            socket.end(Buffer.from([1, 1]));
            return;
          }
          seen.auth++;
          send([1, 0]);
          stage = 2;
        } else if (stage === 2) {
          if (buffer.length < 5 || buffer.length < 7 + buffer[4]) return;
          assert.deepEqual([...buffer.subarray(0, 4)], [5, 1, 0, 3]);
          const length = buffer[4];
          const host = buffer.subarray(5, 5 + length).toString();
          const port = buffer.readUInt16BE(5 + length);
          if (mode === "policy") { socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
          tunnel(host, port, buffer.subarray(7 + length));
          stage = 3;
          return;
        } else return;
      }
    };
    socket.on("data", onData);
  };
  // Pre-handshake TLS peers auto-close; half-close is enabled only after secureConnect.
  const server = kind === "https"
    ? tls.createServer({ key: (wrongIdentity ? wrongProxyIdentity : proxyIdentity).keyPem, cert: (wrongIdentity ? wrongProxyIdentity : proxyIdentity).certPem }, handle)
    : net.createServer({ allowHalfOpen: true }, handle);
  server.on("connection", () => { seen.connections++;  });
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  const port = await listen(scope, server, sockets);
  const base = { host: "127.0.0.1", port };
  let route: OpaqueProxyRoute;
  switch (kind) {
    case "https": route = { ...base, kind, proxyCa: ca }; break;
    case "http": route = { ...base, kind }; break;
    default: route = { ...base, kind }; break;
  }
  const candidate: OpaqueProxyRoute = requireAuth ? { ...route, ...credentials } : route;
  return { candidate, seen, sockets };
}

export async function securedClient(scope: TunnelFixtureScope, raw: Socket, servername = "origin.fixture.invalid", trust = ca) {
  scope.own(raw);
  const options = { socket: raw, servername, ca: trust, rejectUnauthorized: true, allowHalfOpen: true };
  const socket = scope.own(tls.connect(options));
  raw.resume();
  await once(socket, "secureConnect");
  assert.equal(socket.authorized, true);
  return socket;
}
