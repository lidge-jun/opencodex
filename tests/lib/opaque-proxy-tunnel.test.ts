import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
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
