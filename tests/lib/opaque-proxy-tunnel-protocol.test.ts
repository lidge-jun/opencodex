import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { dialTunnel, type OpaqueProxyRoute, type OpaqueTunnelOptions } from "../../src/lib/opaque-proxy-tunnel";
import { deadProxy, digest, echo, readBytes, TunnelFixtureScope, until, wait } from "../helpers/opaque-proxy-tunnel";
import { ca, credentials, origin, protocolProxy, proxyKinds, securedClient } from "../helpers/opaque-proxy-tunnel-protocol";

const scope = new TunnelFixtureScope();
afterEach(() => scope.close());
const dial = (authority: string, route: OpaqueProxyRoute, options: OpaqueTunnelOptions = {}) => dialTunnel(authority, route, options);

for (const kind of proxyKinds) {
  test(`${kind}: real authenticated tunnel carries independently verified opaque target TLS`, async () => {
    const end = await origin(scope); const p = await protocolProxy(scope, kind, { destination: end, fragmented: true });
    const raw = await dial(end.authority, p.candidate);
    const secured = await securedClient(scope, raw); const payload = Buffer.from('origin-only plaintext marker\0\xff'); await echo(secured, payload);
    assert.equal(p.seen.auth, 1); assert.deepEqual(p.seen.targets, [{ host: 'origin.fixture.invalid', port: end.port }]);
    assert.deepEqual(Buffer.concat(end.received), payload);
    assert.equal(Buffer.concat(p.seen.opaque).includes(payload), false, 'proxy must see encrypted target data');
    assert.equal(Buffer.concat(end.received).includes(Buffer.from('Proxy-Authorization')), false);
  }, 7000);
  test(`${kind}: explicit dead route reports failure`, async () => {
    await assert.rejects(dial('origin.fixture.invalid:443', await deadProxy(kind)), error => ['TRANSPORT', 'PROXY_TLS'].includes((error as { code: string }).code));
  }, 5000);
  test(`${kind}: authentication refusal is terminal and credential-safe`, async () => {
    const denied = await protocolProxy(scope, kind, { mode: 'refuse' });
    await assert.rejects(dial('origin.fixture.invalid:443', denied.candidate), error => {
      assert.ok(["REFUSED", "SOCKS_REFUSED"].includes((error as { code: string }).code));
      const diagnostic = String(error) + JSON.stringify(error);
      assert.equal(diagnostic.includes(credentials.username), false);
      assert.equal(diagnostic.includes(credentials.password), false);
      assert.equal(diagnostic.includes(Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")), false);
      return true;
    });
    await until(() => denied.sockets.size === 0);
  }, 5000);
  test(`${kind}: no-response timeout closes the only route`, async () => {
    const hung = await protocolProxy(scope, kind, { mode: 'hang' });
    await assert.rejects(dial('origin.fixture.invalid:443', hung.candidate, { timeoutMs: 200 }), { code: 'TIMEOUT' });
    assert.equal(hung.seen.connections, 1); await until(() => hung.sockets.size === 0);
  }, 5000);
  test(`${kind}: partial response timeout is terminal`, async () => {
    const p = await protocolProxy(scope, kind, { mode: 'partial' });
    await assert.rejects(dial('origin.fixture.invalid:443', p.candidate, { timeoutMs: 150 }), { code: 'TIMEOUT' });
    await until(() => p.sockets.size === 0);
  }, 5000);
  test(`${kind}: caller cancellation closes the selected route`, async () => {
    const p = await protocolProxy(scope, kind, { mode: 'hang' }), controller = new AbortController();
    const result = dial('origin.fixture.invalid:443', p.candidate, { signal: controller.signal });
    const assertion = assert.rejects(result, { code: 'ABORTED' }); await until(() => p.seen.handshakes === 1); controller.abort(); await assertion;
    await until(() => p.sockets.size === 0);
  }, 5000);
  test(`${kind}: target TLS 2 MiB backpressure and half-close preserve bytes`, async () => {
    const end = await origin(scope, { slow: true }), p = await protocolProxy(scope, kind, { destination: end });
    const socket = await dial(end.authority, p.candidate); const secured = await securedClient(scope, socket);
    const payload = Buffer.alloc(2 * 1024 * 1024); for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    await echo(secured, payload, true); assert.equal(digest(Buffer.concat(end.received)), digest(payload));
  }, 12000);
  test(`${kind}: failure after opaque target TLS and application bytes never replays`, async () => {
    const end = await origin(scope, { drop: true }), p = await protocolProxy(scope, kind, { destination: end });
    const socket = await dial(end.authority, p.candidate); const secured = await securedClient(scope, socket);
    const closed = new Promise<void>(resolve => { secured.once('end', resolve); secured.once('close', resolve); secured.once('error', () => resolve()); });
    const payload = Buffer.from('single-committed-operation'); secured.write(payload); secured.resume(); await closed; secured.destroy();
    assert.deepEqual(Buffer.concat(end.received), payload); assert.equal(end.calls(), 1);
  }, 5000);
}

for (const mode of ['untrusted', 'wrong-name']) {
  test(`HTTPS proxy ${mode} certificate is rejected`, async () => {
    const p = await protocolProxy(scope, 'https', { mode: 'hang', wrongIdentity: mode === 'wrong-name' });
    assert.equal(p.candidate.kind, 'https');
    if (p.candidate.kind !== 'https') throw new Error('HTTPS fixture required');
    const bad = { ...p.candidate, ...(mode === 'untrusted' ? { proxyCa: undefined } : {}) };
    await assert.rejects(dial('origin.fixture.invalid:443', bad), error => (error as { code: string }).code === 'PROXY_TLS');
    await until(() => p.sockets.size === 0);
  }, 5000);
}
test('target TLS certificate still rejects a wrong hostname through a verified HTTPS proxy', async () => {
  const end = await origin(scope), p = await protocolProxy(scope, 'https', { destination: end });
  const socket = await dial(end.authority, p.candidate);
  await assert.rejects(securedClient(scope, socket, 'wrong.fixture.invalid'), /certificate|hostname|altnames/i);
}, 5000);
for (const kind of ['socks5', 'socks5h'] as const) {
  test(`${kind}: early opaque bytes beyond 64 KiB survive CONNECT response coalescing`, async () => {
    const p = await protocolProxy(scope, kind, { mode: 'early-large' });
    const socket = await dial('origin.fixture.invalid:443', p.candidate); scope.own(socket);
    assert.deepEqual(await readBytes(socket, 192 * 1024), Buffer.alloc(192 * 1024, 0xa5));
  }, 5000);
  test(`${kind}: explicit SOCKS policy refusal is reported`, async () => {
    const p = await protocolProxy(scope, kind, { mode: 'policy' });
    await assert.rejects(dial('origin.fixture.invalid:443', p.candidate), { code: 'SOCKS_REFUSED' });

  }, 5000);
}
test('stalled HTTPS proxy TLS handshake is bounded, terminal, and cancellable', async () => {
  const plain = await protocolProxy(scope, 'http', { mode: 'hang' });
  const candidate = { kind: 'https' as const, host: '127.0.0.1', port: plain.candidate.port, proxyCa: ca };
  await assert.rejects(dial('origin.fixture.invalid:443', candidate, { timeoutMs: 60 }), error => (error as { code: string }).code === 'TIMEOUT');
  await until(() => plain.sockets.size === 0);
  const abort = new AbortController(), pending = dial('origin.fixture.invalid:443', candidate, { signal: abort.signal });
  const assertion = assert.rejects(pending, { code: 'ABORTED' }); await until(() => plain.seen.connections === 2); abort.abort(); await assertion; await until(() => plain.sockets.size === 0);
}, 5000);
test('configuration rejects unsupported protocols and invalid credential sizes before dialing', async () => {
  const route = { host: '127.0.0.1', port: 1 };
  await assert.rejects(dial('origin.fixture.invalid:443', { ...route, kind: 'direct' } as unknown as OpaqueProxyRoute), { code: 'CONFIG' });
  await assert.rejects(dial('origin.fixture.invalid:443', { ...route, kind: 'socks5', username: 'x'.repeat(256), password: 'p' }), { code: 'CONFIG' });
  await assert.rejects(dial('origin.fixture.invalid:443', { ...route, kind: 'socks5h', username: 'u', password: 'x'.repeat(256) }), { code: 'CONFIG' });
  await assert.rejects(dial('origin.fixture.invalid:443', route, { timeoutMs: 0 }), { code: 'CONFIG' });
});

for (const kind of proxyKinds) {
  test(`${kind}: after establishment the caller owns cancellation and the socket`, async () => {
    const end = await origin(scope), proxy = await protocolProxy(scope, kind, { destination: end });
    const controller = new AbortController();
    const socket = await dial(end.authority, proxy.candidate, {
      signal: controller.signal, timeoutMs: 200,
    });
    scope.own(socket);
    assert.equal(socket.isPaused(), true);
    controller.abort();
    // The already-cleared establishment deadline must not destroy caller-owned I/O.
    await wait(250);
    assert.equal(socket.destroyed, false);
    const secured = await securedClient(scope, socket);
    const payload = Buffer.from("caller-owned-after-establishment");
    await echo(secured, payload);
    assert.deepEqual(Buffer.concat(end.received), payload);
  }, 5_000);
}
