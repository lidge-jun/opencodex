import { expect, test } from "bun:test";
import { connect, createServer, type TLSSocket } from "node:tls";
import { connect as connectTcp, type AddressInfo, type Socket } from "node:net";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { CLOUD_HOST } from "../../src/chatgpt/cloud-network/contract";
import { startCloudNetwork } from "../../src/chatgpt/cloud-network/runtime";
import { cloudFixture } from "../helpers/cloud-network-fixture";
import { cloudTestProxy } from "../helpers/cloud-network-proxy";
import { startCloudEntry } from "../../src/chatgpt/cloud-network/entry";

test("stopping the entry cancels pending proxy establishment", async () => {
  const options = { stall: false };
  const proxy = await cloudTestProxy(options);
  let entry: Awaited<ReturnType<typeof startCloudEntry>> | undefined;
  let client: Socket | undefined;
  try {
    entry = await startCloudEntry({ proxy: `http://127.0.0.1:${proxy.port}`, port: 0 });
    options.stall = true;
    client = connectTcp(entry.endpoints[0]!);
    client.on("error", () => {});
    for (let i = 0; i < 100 && proxy.requests.length < 2; i++) await Bun.sleep(10);
    expect(proxy.requests).toHaveLength(2); // successful preflight, then a stalled client CONNECT
    await entry.stop();
    for (let i = 0; i < 100 && proxy.connectionCount > 0; i++) await Bun.sleep(10);
    expect(proxy.connectionCount).toBe(0);
  } finally {
    client?.destroy(); await entry?.stop(); await proxy.stop();
  }
});

test.skipIf(process.platform === "win32")("IPv4/IPv6 preserve end-to-end TLS and binary bytes; wrong hostname is rejected", async () => {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, [CLOUD_HOST]);
  const sockets = new Set<TLSSocket>();
  const origin = createServer({ cert: leaf.certPem, key: leaf.keyPem }, socket => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  origin.on("tlsClientError", () => {});
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const proxy = await cloudTestProxy({ targetPort: (origin.address() as AddressInfo).port });
  const f = cloudFixture(), helper = await f.startHelper();
  const entry = await startCloudNetwork({ helperSocket: f.socketPath, listenPort: 0, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } });
  try {
    const payload = Buffer.alloc(512 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    for (const endpoint of entry.endpoints) {
      await new Promise<void>((resolve, reject) => {
        const client = connect({ ...endpoint, servername: CLOUD_HOST, ca: ca.certPem });
        const received: Buffer[] = [];
        let size = 0;
        client.on("error", reject);
        client.once("secureConnect", () => { expect(client.authorized).toBe(true); client.write(payload); });
        client.on("data", chunk => {
          received.push(chunk); size += chunk.length;
          if (size >= payload.length) {
            expect(Buffer.concat(received)).toEqual(payload);
            client.destroy(); resolve();
          }
        });
      });
    }
    await new Promise<void>((resolve, reject) => {
      const client = connect({ ...entry.endpoints[0], servername: "wrong.test", ca: ca.certPem });
      client.once("error", () => { expect(client.authorized).toBe(false); client.destroy(); resolve(); });
      client.once("secureConnect", () => { client.destroy(); reject(new Error("wrong certificate accepted")); });
    });
    expect(proxy.requests).toHaveLength(4); // readiness probe plus three client connections
    expect(proxy.requests.every(line => line === `CONNECT ${CLOUD_HOST}:443 HTTP/1.1`)).toBe(true);
  } finally {
    await entry.stop(); await helper.stop(); f.cleanup(); await proxy.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => origin.close(() => resolve()));
  }
});
