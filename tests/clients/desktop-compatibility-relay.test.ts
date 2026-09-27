import { expect, test } from "bun:test";
import { createServer } from "node:https";
import { connect } from "node:tls";
import type { Duplex } from "node:stream";
import { createCertificateAuthority, issueServerLeaf } from "../../src/claude/intercept/local-ca";
import { startDesktopRelay } from "../../src/codex/desktop-compatibility/relay-listener";

test("upgraded native app traffic preserves handshake and raw frames in both directions", async () => {
  const ca = createCertificateAuthority({ commonName: "relay-fixture", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "relay-fixture", ["chatgpt.com"]);
  const upstream = createServer({ cert: leaf.certPem, key: leaf.keyPem });
  const sockets = new Set<Duplex>();
  let cookie: string | undefined, protocol: string | undefined;
  const frame = Buffer.from([0x82, 0x83, 0x01, 0x02, 0x03, 0x04, 0x7a, 0x00, 0xff]);
  upstream.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  upstream.on("upgrade", (req, client, head) => {
    cookie = req.headers.cookie; protocol = req.headers["sec-websocket-protocol"] as string | undefined;
    client.on("error", () => {});
    client.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: fixture.v1\r\n\r\n");
    if (head.length) client.write(head);
    client.on("data", data => client.write(data));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const relay = await startDesktopRelay({ leaf, fetchImpl: (async () => { throw new Error("Upgrade must not use HTTP fetch"); }) as typeof fetch,
    websocketPeer: { host: "127.0.0.1", port, ca: ca.certPem } });
  const client = connect({ host: "127.0.0.1", port: relay.port, servername: "chatgpt.com", ca: ca.certPem });
  try {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      let result = Buffer.alloc(0);
      client.setTimeout(5000, () => reject(new Error("fixture timeout"))); client.once("error", reject);
      client.on("data", chunk => {
        result = Buffer.concat([result, chunk]); const end = result.indexOf("\r\n\r\n");
        if (end !== -1 && result.length >= end + 4 + frame.length) resolve(result);
      });
      client.once("secureConnect", () => {
        client.write("GET /dictation/stream HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: Zml4dHVyZQ==\r\nSec-WebSocket-Protocol: fixture.v1\r\nCookie: fixture=session\r\n\r\n");
        client.write(frame);
      });
    });
    expect(bytes.toString("latin1")).toContain("101 Switching Protocols");
    expect(bytes.subarray(bytes.indexOf("\r\n\r\n") + 4)).toEqual(frame);
    expect(cookie).toBe("fixture=session"); expect(protocol).toBe("fixture.v1");
  } finally {
    client.destroy(); await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 10000);
