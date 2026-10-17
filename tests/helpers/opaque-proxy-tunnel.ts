import assert from "node:assert/strict";
import net, { type AddressInfo, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import type { OpaqueProxyRoute } from "../../src/lib/opaque-proxy-tunnel";

/** Each case owns its listeners, peers, client sockets, and fixture timers. */
export class TunnelFixtureScope {
  private cleanups: Array<() => void | Promise<void>> = [];
  after(cleanup: () => void | Promise<void>): void { this.cleanups.push(cleanup); }
  own<T extends Socket>(socket: T): T {
    socket.on("error", () => {});
    this.after(() => { socket.destroy(); });
    return socket;
  }
  later(callback: () => void, ms: number): void {
    const timer = setTimeout(callback, ms);
    this.after(() => clearTimeout(timer));
  }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "tunnel fixture cleanup failed");
  }
}

export const target = "fixture.invalid:443";
export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate() && performance.now() < deadline) await wait(5);
  assert.ok(predicate(), "fixture condition did not settle");
}

export async function listen(scope: TunnelFixtureScope, server: Server, sockets = new Set<Socket>()): Promise<number> {
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  scope.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

export async function deadProxy(kind: OpaqueProxyRoute["kind"] = "http"): Promise<OpaqueProxyRoute> {
  // An OS-assigned local port, closed before the candidate is used. No destination DNS lookup.
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return { kind, host: "127.0.0.1", port } as OpaqueProxyRoute;
}

export async function readBytes(socket: Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const done = () => {
      socket.pause();
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
    };
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < count) return;
      done();
      if (data.length > count) socket.unshift(data.subarray(count));
      resolve(data.subarray(0, count));
    };
    const onEnd = () => { done(); reject(new Error(`early end: ${data.length}/${count}`)); };
    const onError = (error: Error) => { done(); reject(error); };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.resume();
  });
}

export async function echo(socket: Socket, payload: Buffer, slowRead = false): Promise<void> {
  const chunks: Buffer[] = [];
  const ended = once(socket, "end");
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  if (slowRead) socket.pause();
  socket.end(payload);
  if (slowRead) { await wait(35); socket.resume(); }
  await ended;
  const received = Buffer.concat(chunks);
  assert.equal(received.length, payload.length);
  assert.equal(digest(received), digest(payload));
}

export type HttpFixtureMode = "echo" | "hang" | "407" | "403" | "malformed" | "oversize"
  | "bad-header" | "partial-refusal" | "partial-timeout" | "banner" | "drop" | "slow";

export async function httpProxy(scope: TunnelFixtureScope, mode: HttpFixtureMode = "echo") {
  const sockets = new Set<Socket>();
  const seen = { calls: 0, bytes: 0, payloads: [] as Buffer[], authorities: [] as string[] };
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let pending = Buffer.alloc(0), writes = 0, ended = false;
    socket.once("end", () => { ended = true; if (!writes) socket.end(); });
    const handshake = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.removeListener("data", handshake);
      seen.calls++;
      const headers = pending.subarray(0, end).toString();
      assert.match(headers, /^CONNECT fixture\.invalid:443 HTTP\/1\.1\r\nHost: fixture\.invalid:443$/);
      seen.authorities.push(headers.split("\r\n")[0]);
      if (mode === "hang") return;
      if (mode === "407" || mode === "403") { socket.end(`HTTP/1.1 ${mode} Refused\r\nContent-Length: 0\r\n\r\n`); return; }
      if (mode === "malformed") { socket.end("NOT HTTP\r\n\r\n"); return; }
      if (mode === "oversize") { socket.write("HTTP/1.1 200 OK\r\nX: " + "x".repeat(9000)); return; }
      if (mode === "bad-header") { socket.end("HTTP/1.1 200 OK\r\nInvalidHeader\r\n\r\n"); return; }
      if (mode === "partial-refusal") { socket.end("HTTP/1.1 407 Refused\r\nIncomplete"); return; }
      if (mode === "partial-timeout") { socket.write("HTTP/1.1 4"); return; }
      // Coalesce early opaque bytes with the CONNECT response to exercise unshift ownership.
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n" + (mode === "banner" ? "opaque-banner" : ""));
      const payload = (data: Buffer) => {
        seen.bytes += data.length;
        seen.payloads.push(data);
        if (mode === "drop") { socket.destroy(); return; }
        if (mode === "slow") {
          writes++;
          socket.pause();
          scope.later(() => {
            writes--;
            if (socket.destroyed) return;
            socket.write(data);
            if (ended && !writes) socket.end(); else socket.resume();
          }, 3);
        } else socket.write(data);
      };
      socket.on("data", payload);
      const head = pending.subarray(end + 4);
      if (head.length) payload(head);
    };
    socket.on("data", handshake);
  });
  const port = await listen(scope, server, sockets);
  return { candidate: { host: "127.0.0.1", port } satisfies OpaqueProxyRoute, seen, sockets };
}
