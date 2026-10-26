import { afterEach, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter, once } from "node:events";
import tls from "node:tls";
import { dialTunnel, type OpaqueProxyRoute } from "../../src/lib/opaque-proxy-tunnel";
import { deadProxy, digest, echo, httpProxy, listen, readBytes, target, TunnelFixtureScope, until } from "../helpers/opaque-proxy-tunnel";

const scope = new TunnelFixtureScope();
afterEach(() => scope.close());

test("single explicit proxy carries opaque bytes", async () => {
  const live = await httpProxy(scope), socket = scope.own(await dialTunnel(target, live.candidate));
  const expected = Buffer.from([0, 255, 1, 127, 13, 10]);
  const reply = readBytes(socket, expected.length);
  socket.write(expected);
  assert.deepEqual(await reply, expected);
  assert.equal(live.seen.calls, 1);
});

test("failed proxy never opens a direct destination connection", async () => {
  const dead = await deadProxy();
  let directCalls = 0;
  const destination = net.createServer(socket => { directCalls++; socket.destroy(); });
  const port = await listen(scope, destination);
  await assert.rejects(dialTunnel(`127.0.0.1:${port}`, dead), { code: "TRANSPORT" });
  assert.equal(directCalls, 0);
});

for (const mode of ["407", "403", "malformed", "oversize", "bad-header", "partial-refusal", "partial-timeout"] as const) {
  test(`${mode} closes the selected proxy and reports failure`, async () => {
    const proxy = await httpProxy(scope, mode);
    await assert.rejects(dialTunnel(target, proxy.candidate, { timeoutMs: 150, maxHeaderBytes: 8192 }), error => {
      const failure = error as { code: string; status?: number };
      const expected = mode === "407" || mode === "403" || mode === "partial-refusal" ? "REFUSED" : mode === "partial-timeout" ? "TIMEOUT" : "PROTOCOL";
      assert.equal(failure.code, expected);
      if (mode === "407" || mode === "403") assert.equal(failure.status, Number(mode));
      return true;
    });
    assert.equal(proxy.seen.calls, 1);
    await until(() => proxy.sockets.size === 0);
  });
}

test("establishment timeout destroys the hanging socket", async () => {
  const hang = await httpProxy(scope, "hang");
  await assert.rejects(dialTunnel(target, hang.candidate, { timeoutMs: 150 }), { code: "TIMEOUT" });
  assert.equal(hang.seen.calls, 1);
  await until(() => hang.sockets.size === 0);
});

test("caller cancellation closes establishment", async () => {
  const hang = await httpProxy(scope, "hang"), controller = new AbortController();
  const pending = dialTunnel(target, hang.candidate, { signal: controller.signal, timeoutMs: 2000 });
  const check = assert.rejects(pending, { code: "ABORTED" });
  await until(() => hang.seen.calls === 1);
  controller.abort(); await check;
  await until(() => hang.sockets.size === 0);
});

test("already-cancelled request opens no proxy connection", async () => {
  const proxy = await httpProxy(scope), controller = new AbortController();
  controller.abort();
  await assert.rejects(dialTunnel(target, proxy.candidate, { signal: controller.signal }), { code: "ABORTED" });
  assert.equal(proxy.seen.calls, 0);
  assert.equal(proxy.sockets.size, 0);
});

test("early opaque bytes coalesced with CONNECT headers are preserved", async () => {
  const proxy = await httpProxy(scope, "banner"), socket = scope.own(await dialTunnel(target, proxy.candidate));
  const payload = Buffer.from("early-client-bytes");
  const received = readBytes(socket, 13 + payload.length);
  socket.write(payload);
  assert.deepEqual(await received, Buffer.concat([Buffer.from("opaque-banner"), payload]));
  assert.deepEqual(Buffer.concat(proxy.seen.payloads), payload);
});

test("caller half-close preserves a 4 MiB echoed response under backpressure", async () => {
  const proxy = await httpProxy(scope, "slow"), socket = scope.own(await dialTunnel(target, proxy.candidate));
  const payload = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  await echo(socket, payload, true);
  assert.equal(proxy.seen.bytes, payload.length);
  assert.equal(digest(Buffer.concat(proxy.seen.payloads)), digest(payload));
}, 12000);

test("failure after establishment and application bytes never reconnects or replays", async () => {
  const drop = await httpProxy(scope, "drop"), socket = scope.own(await dialTunnel(target, drop.candidate));
  const ended = once(socket, "end");
  socket.write("unique-turn-payload"); socket.resume(); await ended; socket.end();
  assert.equal(drop.seen.bytes, 19);
  assert.equal(drop.seen.calls, 1);
});

test("configuration requires one route and a well-formed authority", async () => {
  const proxy = await httpProxy(scope);
  for (const authority of ["target", "target:0", "target:65536", "target:443\r\nInjected: yes"]) {
    await assert.rejects(dialTunnel(authority, proxy.candidate), { code: "TARGET" });
  }
  await assert.rejects(dialTunnel(target, [] as unknown as OpaqueProxyRoute), { code: "CONFIG" });
  await assert.rejects(dialTunnel(target, undefined as unknown as OpaqueProxyRoute), { code: "CONFIG" });
  assert.equal(proxy.seen.calls, 0);
});

/** Feed exact transport fragments without relying on OS packet boundaries. */
class HeaderSocket extends EventEmitter {
  destroyed = false;
  readonly queued: Buffer[] = [];
  readonly writes: string[] = [];
  pause() { return this; }
  resume() { return this; }
  write(bytes: string | Buffer) { this.writes.push(String(bytes)); return true; }
  unshift(bytes: Buffer) { this.queued.unshift(bytes); }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  feed(bytes: Buffer) {
    if (this.destroyed) return;
    if (this.listenerCount("data")) this.emit("data", bytes);
    else this.queued.push(bytes);
  }
}

function inspectHeaderFragments(chunks: Buffer[], maxHeaderBytes = 65536, secure = false) {
  const socket = new HeaderSocket();
  const copies = { concatCalls: 0, concatBytes: 0, copiedBytes: 0, allocations: [] as number[] };
  const originalConcat = Buffer.concat;
  const originalCopy = Buffer.prototype.copy;
  const originalAlloc = Buffer.allocUnsafe;
  let measuring = false;
  const connect = secure
    ? spyOn(tls, "connect").mockImplementation((options: tls.ConnectionOptions) => {
      assert.equal(options.rejectUnauthorized, true);
      assert.deepEqual(options.ALPNProtocols, ["http/1.1"]);
      assert.equal(typeof options.checkServerIdentity, "function");
      return socket as unknown as tls.TLSSocket;
    })
    : spyOn(net, "createConnection").mockImplementation(() => socket as unknown as net.Socket);
  const concat = spyOn(Buffer, "concat").mockImplementation((list, length) => {
    const result = originalConcat(list, length);
    if (measuring) { copies.concatCalls++; copies.concatBytes += result.length; }
    return result;
  });
  const copy = spyOn(Buffer.prototype, "copy").mockImplementation(function (this: Buffer, target, targetStart, sourceStart, sourceEnd) {
    const size = originalCopy.call(this, target, targetStart, sourceStart, sourceEnd);
    if (measuring) copies.copiedBytes += size;
    return size;
  });
  const allocate = spyOn(Buffer, "allocUnsafe").mockImplementation(size => {
    if (measuring) copies.allocations.push(size);
    return originalAlloc(size);
  });
  let pending: Promise<net.Socket>;
  try {
    pending = dialTunnel(target, { host: "127.0.0.1", port: 1, kind: secure ? "https" : "http" }, { maxHeaderBytes });
    // Observe a refusal immediately, while still restoring every spy synchronously.
    void pending.catch(() => {});
    socket.emit(secure ? "secureConnect" : "connect");
    measuring = true;
    for (const chunk of chunks) socket.feed(chunk);
    measuring = false;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    measuring = false;
    allocate.mockRestore(); copy.mockRestore(); concat.mockRestore(); connect.mockRestore();
  }
  return { socket, copies, pending };
}

function paddedConnectHeader(size: number): Buffer {
  const prefix = "HTTP/1.1 200 Connection Established\r\nX-Fixture: ";
  return Buffer.from(prefix + "x".repeat(size - Buffer.byteLength(prefix) - 4) + "\r\n\r\n");
}

for (const secure of [false, true]) {
  test(`${secure ? "HTTPS" : "HTTP"} CONNECT copies fragmented headers linearly`, async () => {
    const header = paddedConnectHeader(65536);
    const chunks = Array.from({ length: header.length / 1024 }, (_, index) => header.subarray(index * 1024, (index + 1) * 1024));
    const before = Buffer.from(header);
    const fixture = inspectHeaderFragments(chunks, header.length, secure);
    await fixture.pending;
    assert.deepEqual(header, before, "borrowed input must not be mutated");
    assert.equal(fixture.copies.concatCalls, 0);
    assert.ok(fixture.copies.copiedBytes < 3 * header.length, JSON.stringify(fixture.copies));
    assert.ok(fixture.copies.allocations.every(size => size <= header.length));
    assert.equal(fixture.socket.listenerCount("data"), 0);
    fixture.socket.destroy();
  });
}

test("CONNECT complete headers borrow the original chunk without a copy", async () => {
  const header = paddedConnectHeader(64);
  const packet = Buffer.concat([header, Buffer.from("opaque-target-banner")]);
  const fixture = inspectHeaderFragments([packet], 64);
  await fixture.pending;
  assert.equal(fixture.copies.concatCalls, 0);
  assert.equal(fixture.copies.copiedBytes, 0);
  assert.equal(fixture.copies.allocations.length, 0);
  assert.deepEqual(Buffer.concat(fixture.socket.queued), packet.subarray(64));
  assert.equal(fixture.socket.queued[0]!.buffer, packet.buffer);
  fixture.socket.destroy();
});

test("CONNECT split delimiters and both sides of the header cap preserve opaque bytes", async () => {
  const header = paddedConnectHeader(96);
  const payload = Buffer.alloc(4096);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  const packet = Buffer.concat([header, payload]);
  for (const cap of [96, 128, 65536]) {
    for (let split = 1; split < header.length; split++) {
      const fixture = inspectHeaderFragments([packet.subarray(0, split), Buffer.alloc(0), packet.subarray(split)], cap);
      await fixture.pending;
      assert.deepEqual(Buffer.concat(fixture.socket.queued), payload, `cap=${cap} split=${split}`);
      assert.equal(fixture.socket.listenerCount("data"), 0);
      fixture.socket.destroy();
    }
  }
});

test("CONNECT over-limit input is refused without copying its oversized tail", async () => {
  const packet = Buffer.from("HTTP/1.1 200 OK\r\nX-Fixture: " + "x".repeat(1024 * 1024));
  const fixture = inspectHeaderFragments([packet.subarray(0, 8), packet.subarray(8)], 64);
  await assert.rejects(fixture.pending, { code: "PROTOCOL" });
  assert.equal(fixture.socket.destroyed, true);
  assert.equal(fixture.copies.concatCalls, 0);
  assert.ok(fixture.copies.copiedBytes <= 64);
  assert.ok(fixture.copies.allocations.every(size => size <= 64));
});

test("CONNECT partial status, refusal, and malformed headers still fail closed", async () => {
  for (const [wire, code] of [
    ["HTTP/1.1 407 Refused\r\nUnfinished", "REFUSED"],
    ["NOT HTTP\r\n\r\n", "PROTOCOL"],
    ["HTTP/1.1 200 OK\r\nInvalidHeader\r\n\r\n", "PROTOCOL"],
  ]) {
    const bytes = Buffer.from(wire!);
    const fixture = inspectHeaderFragments(Array.from(bytes, byte => Buffer.from([byte])));
    await assert.rejects(fixture.pending, { code });
    assert.equal(fixture.socket.destroyed, true);
    assert.equal(fixture.socket.listenerCount("data"), 0);
  }
});

test("CONNECT real socket preserves a large early payload after a split at the header ceiling", async () => {
  const header = paddedConnectHeader(128);
  const payload = Buffer.alloc(128 * 1024);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  const server = net.createServer({ allowHalfOpen: true }, peer => {
    let request = "";
    const onData = (bytes: Buffer) => {
      request += bytes.toString("latin1");
      if (!request.includes("\r\n\r\n")) return;
      peer.removeListener("data", onData);
      peer.write(header.subarray(0, header.length - 2));
      scope.later(() => { if (!peer.destroyed) peer.write(Buffer.concat([header.subarray(-2), payload])); }, 5);
    };
    peer.on("data", onData);
    peer.once("end", () => peer.end());
  });
  const port = await listen(scope, server);
  const socket = scope.own(await dialTunnel(target, { host: "127.0.0.1", port }, { maxHeaderBytes: header.length }));
  assert.deepEqual(await readBytes(socket, payload.length), payload);
});
