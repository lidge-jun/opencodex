import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { socks5Fetch } from "../../src/lib/socks5-fetch";

const originalClassicalTlsHosts = process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS;
afterEach(() => {
  if (originalClassicalTlsHosts === undefined) delete process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS;
  else process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = originalClassicalTlsHosts;
});

const HYBRID_GROUP = 0x11ec; // X25519MLKEM768
const X25519 = 0x1d;

/** Walk the ClientHello extension list once, returning key-share groups and whether ALPN was offered. */
function parseHello(hello: Buffer): { keyShareGroups: number[]; alpnOffered: boolean } {
  let p = 5 + 4 + 2 + 32;
  const u16 = () => { const n = hello.readUInt16BE(p); p += 2; return n; };
  let n = hello[p]!; p += 1 + n; n = u16(); p += n; n = hello[p]!; p += 1 + n;
  const end = p + 2 + hello.readUInt16BE(p); p += 2;
  const keyShareGroups: number[] = [];
  let alpnOffered = false;
  while (p + 4 <= end) {
    const type = u16(); const len = u16(); const stop = p + len;
    if (type === 51) {
      let q = p + 2;
      while (q + 4 <= stop) { keyShareGroups.push(hello.readUInt16BE(q)); q += 4 + hello.readUInt16BE(q + 2); }
    }
    if (type === 16) alpnOffered = true;
    p = stop;
  }
  return { keyShareGroups, alpnOffered };
}

/**
 * SOCKS5 stand-in that completes CONNECT, captures the first ClientHello, then drops the socket.
 * A fetch failure before any ClientHello rejects instead of hanging, and a capture deadline
 * bounds the wait so the fixture always reaches cleanup.
 */
async function captureClientHello(init?: RequestInit): Promise<{ keyShareGroups: number[]; alpnOffered: boolean }> {
  let resolveHello: (hello: Buffer) => void;
  let rejectHello: (error: Error) => void;
  const hello = new Promise<Buffer>((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("error", () => {});
    let stage: "greeting" | "connect" | "tls" = "greeting";
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        buffer = buffer.subarray(2 + buffer[1]!);
        socket.write(Buffer.from([5, 0]));
        stage = "connect";
      }
      if (stage === "connect") {
        if (buffer.length < 5 || buffer.length < 7 + buffer[4]!) return;
        buffer = buffer.subarray(7 + buffer[4]!);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        stage = "tls";
      }
      if (stage === "tls" && buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt16BE(3)) {
        resolveHello(buffer.subarray(0, 5 + buffer.readUInt16BE(3)));
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = (server.address() as AddressInfo).port;
    const outcome = socks5Fetch("https://destination.invalid/", init, `socks5://127.0.0.1:${port}`).catch(() => "settled");
    deadline = setTimeout(() => rejectHello(new Error("ClientHello capture deadline expired")), 5_000);
    // A fetch that settles before any ClientHello is a fixture failure, not a tolerated teardown.
    const captured = await Promise.race([
      hello,
      outcome.then(() => { throw new Error("socks5Fetch settled before sending a ClientHello"); }),
    ]);
    await outcome;
    return parseHello(captured);
  } finally {
    clearTimeout(deadline);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("socks5Fetch TLS options", () => {
  test("the pinned runtime default offers the hybrid share, so the override below is distinguishable", async () => {
    delete process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS;
    const byDefault = await captureClientHello();
    assert.ok(byDefault.keyShareGroups.includes(HYBRID_GROUP),
      `control failed: runtime default offered ${byDefault.keyShareGroups.map(g => "0x" + g.toString(16))}; `
      + "if the pinned runtime stops offering the hybrid share, this regression loses its discriminating power");
  });

  test("caller-supplied init.tls.ecdhCurve is ignored when the host did not opt in", async () => {
    delete process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS;
    const withoutOptIn = await captureClientHello({ tls: { ecdhCurve: "X25519:P-256:P-384" } } as BunFetchRequestInit);
    assert.ok(withoutOptIn.keyShareGroups.includes(HYBRID_GROUP),
      "an unopted host must keep the runtime default hybrid share even if init.tls.ecdhCurve is supplied");

    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "other.invalid";
    const mismatchedOptIn = await captureClientHello({ tls: { ecdhCurve: "X25519:P-256:P-384" } } as BunFetchRequestInit);
    assert.ok(mismatchedOptIn.keyShareGroups.includes(HYBRID_GROUP),
      "a non-matching opt-in list must not forward init.tls.ecdhCurve");
  });

  test("init.tls.ecdhCurve reaches the SOCKS5 TLS handshake for an opted-in host", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "destination.invalid";
    const overridden = await captureClientHello({ tls: { ecdhCurve: "X25519:P-256:P-384" } } as BunFetchRequestInit);
    assert.ok(overridden.keyShareGroups.includes(X25519), "a classical key share must be offered");
    assert.ok(!overridden.keyShareGroups.includes(HYBRID_GROUP), "the hybrid share must not be offered");
  });

  test("only ecdhCurve crosses the boundary: caller ALPN and verification options do not reach the handshake", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = ".destination.invalid";
    const captured = await captureClientHello({
      tls: {
        ecdhCurve: "X25519:P-256:P-384",
        ALPNProtocols: ["h2", "http/1.1"],
        rejectUnauthorized: false,
        servername: "attacker.invalid",
      },
    } as BunFetchRequestInit);
    assert.equal(captured.alpnOffered, false, "caller ALPN must not be advertised; this transport speaks HTTP/1.1 only");
    assert.ok(!captured.keyShareGroups.includes(HYBRID_GROUP), "the curve override itself must still apply");
  });
});

