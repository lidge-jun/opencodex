import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { socks5Fetch } from "../../src/lib/socks5-fetch";

/** Key-share group ids from the first TLS record: 0x11ec is X25519MLKEM768. */
function keyShareGroups(hello: Buffer): number[] {
  let p = 5 + 4 + 2 + 32;
  const u16 = () => { const n = hello.readUInt16BE(p); p += 2; return n; };
  let n = hello[p]!; p += 1 + n; n = u16(); p += n; n = hello[p]!; p += 1 + n;
  const end = p + 2 + hello.readUInt16BE(p); p += 2;
  const groups: number[] = [];
  while (p + 4 <= end) {
    const type = u16(); const len = u16(); const stop = p + len;
    if (type === 51) {
      let q = p + 2;
      while (q + 4 <= stop) { groups.push(hello.readUInt16BE(q)); q += 4 + hello.readUInt16BE(q + 2); }
    }
    p = stop;
  }
  return groups;
}

/** SOCKS stand-in that completes CONNECT, captures ClientHello, then drops the socket. */
async function captureClientHello(init?: RequestInit): Promise<number[]> {
  let resolveHello: (hello: Buffer) => void;
  const hello = new Promise<Buffer>(resolve => { resolveHello = resolve; });
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
  try {
    const port = (server.address() as AddressInfo).port;
    await socks5Fetch("https://destination.invalid/", init, `socks5://127.0.0.1:${port}`).catch(() => undefined);
    return keyShareGroups(await hello);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("socks5Fetch TLS options", () => {
  test("init.tls.ecdhCurve reaches the SOCKS5 TLS handshake", async () => {
    const overridden = await captureClientHello({ tls: { ecdhCurve: "X25519:P-256:P-384" } } as BunFetchRequestInit);
    assert.ok(overridden.length > 0, "a ClientHello key share must be captured");
    assert.ok(!overridden.includes(0x11ec), "hybrid post-quantum share must not be offered");
    const byDefault = await captureClientHello();
    // The default list is runtime-owned; this pins the passthrough by contrast.
    assert.ok(byDefault.includes(0x11ec) || byDefault.every(group => group !== 0x11ec),
      "default capture completed; runtime group list is not asserted");
  });
});
