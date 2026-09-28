import { expect, test } from "bun:test";
import { createServer, request } from "node:https";
import { connect } from "node:tls";
import type { Duplex } from "node:stream";
import { createCertificateAuthority, issueServerLeaf } from "../../src/claude/intercept/local-ca";
import { startDesktopRelay } from "../../src/codex/desktop-compatibility/relay-listener";
import { forwardProxy } from "../helpers/desktop-egress-fixture";
import { UsageRelayController } from "../../src/codex/desktop-compatibility/usage-controller";
import { createUsageControlledFetch } from "../../src/codex/desktop-compatibility/usage-controlled-fetch";

test("HTTP Host is case-insensitive while foreign hosts and ports cannot reach upstream", async () => {
  const ca = createCertificateAuthority({ commonName: "host-fixture", validityDays: 1 });
  let forwarded = 0;
  const relay = await startDesktopRelay({ leaf: issueServerLeaf(ca, "host-fixture", ["chatgpt.com"]),
    fetchImpl: (async input => { expect(String(input)).toBe("https://chatgpt.com/fixture"); forwarded++; return new Response("fixture"); }) as typeof fetch });
  try {
    for (const [host, status] of [["CHATGPT.COM", 200], ["ChatGPT.Com:443", 200], ["chatgpt.com:444", 421],
      ["chatgpt.com.evil", 421], ["chatgpt.com.", 421]] as const) {
      const actual = await new Promise<number | undefined>((resolve, reject) => {
        const client = request({ hostname: "127.0.0.1", port: relay.port, servername: "chatgpt.com", ca: ca.certPem,
          path: "/fixture", headers: { host } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); response.once("error", reject); });
        client.once("error", reject); client.setTimeout(5000, () => client.destroy(new Error("fixture timeout"))); client.end();
      });
      expect(actual).toBe(status);
    }
    expect(forwarded).toBe(2);
  } finally { await relay.close(); }
}, 10000);

for (const route of ["direct", "http", "https", "socks5"] as const) test(`upgraded native app traffic preserves handshake and raw frames through ${route}`, async () => {
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
  const proxy = route === "direct" ? null : await forwardProxy(route, port, issueServerLeaf(ca, "relay-fixture", ["localhost"]));
  const relay = await startDesktopRelay({ leaf, fetchImpl: (async () => { throw new Error("Upgrade must not use HTTP fetch"); }) as typeof fetch,
    websocketPeer: { host: "127.0.0.1", port, ca: ca.certPem }, websocketTransport: { proxy: proxy?.url ?? false, proxyCa: ca.certPem } });
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
        client.write("GET /dictation/stream HTTP/1.1\r\nHost: CHATGPT.COM\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: Zml4dHVyZQ==\r\nSec-WebSocket-Protocol: fixture.v1\r\nCookie: fixture=session\r\n\r\n");
        client.write(frame);
      });
    });
    expect(bytes.toString("latin1")).toContain("101 Switching Protocols");
    expect(bytes.subarray(bytes.indexOf("\r\n\r\n") + 4)).toEqual(frame);
    expect(cookie).toBe("fixture=session"); expect(protocol).toBe("fixture.v1");
    if (proxy) expect(proxy.seen).toHaveLength(1);
  } finally {
    client.destroy(); await relay.close();
    await proxy?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 10000);

test("conversation initialization restrictions remain untouched even during a usage trial", async () => {
  const account = { id: "fixture-account", userId: "fixture-user", plan: "pro", structure: "personal" } as const;
  const controller = new UsageRelayController(account, async () => account, async () => account, Date.now, Date.now() + 600000);
  await controller.rewriteJson(JSON.stringify({ account_id: account.id, user_id: account.userId, plan_type: "pro",
    rate_limit: { allowed: false, limit_reached: true }, spend_control: { reached: false }, credits: { has_credits: false, unlimited: false } }),
    { method: "GET", pathname: "/backend-api/wham/usage", status: 200 });
  expect((await controller.activate({ scope: "account-ui-compatibility", accountWideConsent: true })).accepted).toBe(true);
  const payload = JSON.stringify({ blocked_features: ["fixture-policy"], limits_progress: { fixture_limit: 100 },
    rate_limit: { allowed: false, limit_reached: true } });
  for (const method of ["GET", "POST"]) {
    const upstream = new Response(payload, { headers: { "content-type": "application/json", etag: '"original"' } });
    const forward = createUsageControlledFetch(controller, (async () => upstream) as typeof fetch);
    const response = await forward("https://chatgpt.com/backend-api/conversation/init", { method });
    expect(response).toBe(upstream); expect(await response.text()).toBe(payload); expect(response.headers.get("etag")).toBe('"original"');
  }
  expect(controller.snapshot().outputs).toBe(0);
});

for (const mode of ["observe", "apply"] as const) test(`attachment upload stays byte-identical in ${mode} mode`, async () => {
  const account = { id: "fixture-account", userId: "fixture-user", plan: "pro", structure: "personal" } as const;
  const controller = new UsageRelayController(account, async () => account, async () => account, Date.now, Date.now() + 600000);
  if (mode === "apply") {
    await controller.rewriteJson(JSON.stringify({ account_id: account.id, user_id: account.userId, plan_type: "pro",
      rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: 123456 } },
      spend_control: { reached: false }, credits: { has_credits: false, unlimited: false } }),
    { method: "GET", pathname: "/backend-api/wham/usage", status: 200 });
    expect((await controller.activate({ scope: "account-ui-compatibility", accountWideConsent: true })).accepted).toBe(true);
  }
  const ca = createCertificateAuthority({ commonName: "attachment-fixture", validityDays: 1 });
  const contentType = "multipart/form-data; boundary=fixture-upload";
  const upload = Buffer.concat([Buffer.from('--fixture-upload\r\nContent-Disposition: form-data; name="file"; filename="fixture.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'),
    Buffer.from([0, 0xff, 0x80, 0x0d, 0x0a]), Buffer.from('첨부 UTF-8 {"rate_limit":{"allowed":false}}\r\n--fixture-upload--\r\n')]);
  const download = Buffer.concat([Buffer.from([0, 0xff, 0x80]), Buffer.from('{"rate_limit":{"allowed":false,"limit_reached":true}}')]);
  let captured: { url: string; method?: string; headers: Headers; bytes: Buffer } | undefined;
  const upstream = (async (input, init) => {
    captured = { url: String(input), method: init?.method, headers: new Headers(init?.headers), bytes: Buffer.from(await new Response(init?.body).arrayBuffer()) };
    const headers = new Headers({ "content-type": "application/octet-stream" });
    headers.append("set-cookie", "fixture-a=one; Secure"); headers.append("set-cookie", "fixture-b=two; Secure");
    return new Response(download, { status: 201, headers });
  }) as typeof fetch;
  const relay = await startDesktopRelay({ leaf: issueServerLeaf(ca, "attachment-fixture", ["chatgpt.com"]), fetchImpl: createUsageControlledFetch(controller, upstream) });
  try {
    const response = await new Promise<{ status?: number; cookies?: string[]; bytes: Buffer }>((resolve, reject) => {
      const client = request({ hostname: "127.0.0.1", port: relay.port, servername: "chatgpt.com", ca: ca.certPem,
        path: "/backend-api/files", method: "POST", headers: { host: "chatgpt.com", "content-type": contentType,
          "content-length": upload.length, authorization: "Bearer fixture-token", cookie: "fixture=session" } }, incoming => {
        const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(Buffer.from(chunk))); incoming.once("error", reject);
        incoming.once("end", () => resolve({ status: incoming.statusCode, cookies: incoming.headers["set-cookie"], bytes: Buffer.concat(chunks) }));
      });
      client.once("error", reject); client.setTimeout(5000, () => client.destroy(new Error("fixture timeout"))); client.end(upload);
    });
    expect(captured?.url).toBe("https://chatgpt.com/backend-api/files"); expect(captured?.method).toBe("POST");
    expect(captured?.bytes).toEqual(upload); expect(captured?.headers.get("content-type")).toBe(contentType);
    expect(captured?.headers.get("authorization")).toBe("Bearer fixture-token"); expect(captured?.headers.get("cookie")).toBe("fixture=session");
    expect(response.status).toBe(201); expect(response.bytes).toEqual(download);
    expect(response.cookies).toEqual(["fixture-a=one; Secure", "fixture-b=two; Secure"]);
    expect(controller.snapshot().mode).toBe(mode); expect(controller.snapshot().outputs).toBe(0);
  } finally { await relay.close(); await controller.observeOnly(); }
}, 10000);
