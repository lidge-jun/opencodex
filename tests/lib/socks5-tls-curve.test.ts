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

/** Walk the ClientHello extension list once, returning key-share groups, SNI, and whether ALPN was offered. */
function parseHello(hello: Buffer): { keyShareGroups: number[]; alpnOffered: boolean; serverName?: string } {
  let p = 5 + 4 + 2 + 32;
  const u16 = () => { const n = hello.readUInt16BE(p); p += 2; return n; };
  let n = hello[p]!; p += 1 + n; n = u16(); p += n; n = hello[p]!; p += 1 + n;
  const end = p + 2 + hello.readUInt16BE(p); p += 2;
  const keyShareGroups: number[] = [];
  let alpnOffered = false;
  let serverName: string | undefined;
  while (p + 4 <= end) {
    const type = u16(); const len = u16(); const stop = p + len;
    if (type === 0 && p + 5 <= stop && hello[p + 2] === 0) {
      const nameLen = hello.readUInt16BE(p + 3);
      if (p + 5 + nameLen <= stop) serverName = hello.subarray(p + 5, p + 5 + nameLen).toString("ascii");
    }
    if (type === 51) {
      let q = p + 2;
      while (q + 4 <= stop) { keyShareGroups.push(hello.readUInt16BE(q)); q += 4 + hello.readUInt16BE(q + 2); }
    }
    if (type === 16) alpnOffered = true;
    p = stop;
  }
  return { keyShareGroups, alpnOffered, serverName };
}

/**
 * SOCKS5 stand-in that completes CONNECT, captures the first ClientHello, then drops the socket.
 * A fetch failure before any ClientHello rejects instead of hanging, and a capture deadline
 * bounds the wait so the fixture always reaches cleanup.
 */
async function captureClientHello(
  init?: RequestInit,
  options: { deadlineMs?: number; holdAfterHello?: boolean; controller?: AbortController; target?: string } = {},
): Promise<{ keyShareGroups: number[]; alpnOffered: boolean; serverName?: string }> {
  let resolveHello: (hello: Buffer) => void;
  const hello = new Promise<Buffer>(resolve => { resolveHello = resolve; });
  const sockets = new Set<Socket>();
  let capturedHello = false;
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
        capturedHello = true;
        resolveHello(buffer.subarray(0, 5 + buffer.readUInt16BE(3)));
        if (!options.holdAfterHello) socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const controller = options.controller ?? new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = (server.address() as AddressInfo).port;
    const outcome = socks5Fetch(options.target ?? "https://destination.invalid/", { ...init, signal: controller.signal }, `socks5://127.0.0.1:${port}`)
      .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    const timedOut = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        const error = new Error(capturedHello ? "TLS teardown deadline expired" : "ClientHello capture deadline expired");
        reject(error);
        controller.abort(error);
      }, options.deadlineMs ?? 5_000);
    });
    const captured = await Promise.race([
      hello,
      outcome.then(result => {
        if (result.ok) throw new Error("socks5Fetch succeeded before sending a ClientHello");
        throw result.error;
      }),
      timedOut,
    ]);
    const result = await Promise.race([outcome, timedOut]);
    assert.equal(result.ok, false, "the stand-in must close the TLS connection after capture");
    return parseHello(captured);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("socks5Fetch TLS options", () => {
  test("preserves failures before ClientHello capture", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "destination.invalid";
    await assert.rejects(
      captureClientHello({ tls: { ecdhCurve: "invalid-curve" } } as BunFetchRequestInit),
      /curve|group/i,
    );
  });

  test("aborts a stalled fetch even after capturing ClientHello", async () => {
    const controller = new AbortController();
    await assert.rejects(
      captureClientHello(undefined, { deadlineMs: 1_000, holdAfterHello: true, controller }),
      /TLS teardown deadline expired/,
    );
    assert.ok(controller.signal.aborted);
    assert.match(controller.signal.reason.message, /TLS teardown deadline expired/);
  }, 10_000);

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

  test("accepts a trailing root dot in the configured and destination hostnames", async () => {
    const init = { tls: { ecdhCurve: "X25519:P-256:P-384" } } as BunFetchRequestInit;
    for (const [configured, target] of [
      ["destination.invalid", "https://destination.invalid./"],
      ["destination.invalid.", "https://destination.invalid/"],
      [".DESTINATION.INVALID.", "https://sub.destination.invalid./"],
    ]) {
      process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = configured;
      const captured = await captureClientHello(init, { target });
      assert.ok(!captured.keyShareGroups.includes(HYBRID_GROUP), "the opted-in host must use classical groups");
      assert.ok(captured.keyShareGroups.includes(X25519));
    }
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
    assert.equal(captured.serverName, "destination.invalid", "caller servername must not replace the destination SNI");
    assert.ok(!captured.keyShareGroups.includes(HYBRID_GROUP), "the curve override itself must still apply");
  });
});

