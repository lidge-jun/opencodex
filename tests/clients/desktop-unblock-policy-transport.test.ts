import { describe, expect, test } from "bun:test";
import { createServer as createHttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createLocalInterceptCa, issueLocalInterceptLeaf, mintAuthorityWithExtensionsForTests } from "../../src/claude/intercept/local-ca";
import type { PemKeyPair } from "../../src/claude/intercept/local-ca";
import type { RuntimePacPolicy } from "../../src/chatgpt/desktop-unblock/pac-policy";
import { createPolicyFetch } from "../../src/chatgpt/desktop-unblock/upstream-fetch";
import { dialUpstreamTunnel } from "../../src/chatgpt/desktop-unblock/ws-upstream";
import { performUpstreamHandshake } from "../../src/chatgpt/desktop-unblock/ws-relay";

const ca = createLocalInterceptCa();
const leaf = issueLocalInterceptLeaf(ca, ["chatgpt.com"]);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function policy(routes: readonly (string | null)[]) {
  const urls: string[] = [];
  return { urls, resolve: async (url: string) => { urls.push(url); return routes; }, close() {} } satisfies RuntimePacPolicy & { urls: string[] };
}
async function own(server: Server) {
  const sockets = new Set<Socket>();
  let connections = 0;
  server.on("connection", socket => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    active: () => sockets.size,
    async stop() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
async function origin(handler: (req: IncomingMessage, res: ServerResponse) => void, certificate = leaf) {
  return own(createHttpsServer({ cert: certificate.certPem, key: certificate.keyPem }, handler));
}
async function proxy(upstreamPort: number, behavior = "tunnel", certificate?: PemKeyPair) {
  const heads: string[] = [];
  const accept = (client: Socket) => {
    client.on("error", () => {});
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.removeListener("data", onData);
      heads.push(buffer.subarray(0, end).toString());
      if (behavior === "stall") return;
      if (behavior === "close") { client.end(); return; }
      if (behavior !== "tunnel") { client.end(behavior); return; }
      const upstream = connect(upstreamPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
        const rest = buffer.subarray(end + 4);
        if (rest.length) upstream.write(rest);
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    };
    client.on("data", onData);
  };
  const server = certificate ? createTlsServer({ cert: certificate.certPem, key: certificate.keyPem }, accept) : createNetServer(accept);
  const owned = await own(server);
  return { ...owned, heads, url: `${certificate ? "https" : "http"}://127.0.0.1:${owned.port}` };
}
async function closedPort() {
  const listener = await own(createNetServer());
  await listener.stop();
  return listener.port;
}
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(5);
  expect(predicate()).toBe(true);
}

describe("runtime PAC socket-bound transport", () => {
  test("HTTP evaluates each full URL and writes POST once on the already verified proxy socket", async () => {
    const received: string[] = [];
    const upstream = await origin((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => { received.push(`${req.method} ${req.url} ${body}`); res.end("ok"); });
    });
    const first = await proxy(upstream.port);
    const forbidden = await proxy(upstream.port);
    const selected = policy([first.url, forbidden.url, null]);
    try {
      const fetch = createPolicyFetch(selected, { ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } });
      const response = await fetch("https://chatgpt.com/backend-api/conversation?q=1", { method: "POST", body: "one send", redirect: "manual" });
      expect(await response.text()).toBe("ok");
      expect(selected.urls).toEqual(["https://chatgpt.com/backend-api/conversation?q=1"]);
      expect(received).toEqual(["POST /backend-api/conversation?q=1 one send"]);
      expect(first.connections()).toBe(1);
      expect(first.heads).toHaveLength(1);
      expect(upstream.connections()).toBe(1);
      expect(forbidden.connections()).toBe(0);
    } finally { await first.stop(); await forbidden.stop(); await upstream.stop(); }
  });

  test("only a pre-connect unreachable endpoint advances to the next proxy", async () => {
    const dead = await closedPort();
    const upstream = await origin((_req, res) => res.end("next proxy"));
    const next = await proxy(upstream.port);
    try {
      const response = await createPolicyFetch(policy([`http://127.0.0.1:${dead}`, next.url]), { ca: ca.certPem })("https://chatgpt.com/a?b=2");
      expect(await response.text()).toBe("next proxy");
      expect(next.connections()).toBe(1);
    } finally { await next.stop(); await upstream.stop(); }
  });

  test("DIRECT works only when explicitly supplied by the policy and never reads env routing", async () => {
    const upstream = await origin((_req, res) => res.end("direct"));
    const forbidden = await proxy(upstream.port);
    try {
      const fetch = createPolicyFetch(policy([null]), { proxy: forbidden.url, ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } });
      expect(await (await fetch("https://chatgpt.com/direct")).text()).toBe("direct");
      expect(forbidden.connections()).toBe(0);
      await expect(createPolicyFetch(policy([]), { proxy: null, ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } })("https://chatgpt.com/empty")).rejects.toThrow();
      const failing: RuntimePacPolicy = { resolve: async () => { throw new Error("policy unavailable"); }, close() {} };
      await expect(createPolicyFetch(failing, { ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } })("https://chatgpt.com/failure")).rejects.toThrow();
      expect(upstream.connections()).toBe(1);
    } finally { await forbidden.stop(); await upstream.stop(); }
  });

  for (const [label, behavior] of [
    ["407", "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"],
    ["502", "HTTP/1.1 502 Bad Gateway\r\n\r\n"],
    ["malformed response", "not HTTP\r\n\r\n"],
    ["clean close", "close"],
    ["handshake timeout", "stall"],
  ]) test(`HTTP proxy ${label} never falls back to another route`, async () => {
    const upstream = await origin((_req, res) => res.end("must not send"));
    const first = await proxy(upstream.port, behavior);
    const next = await proxy(upstream.port);
    try {
      const fetch = createPolicyFetch(policy([first.url, next.url, null]), { ca: ca.certPem, connectTimeoutMs: 50, target: { host: "127.0.0.1", port: upstream.port } });
      await expect(fetch("https://chatgpt.com/no-fallback", { method: "POST", body: "must not send" })).rejects.toThrow();
      expect(first.connections()).toBe(1);
      expect(next.connections()).toBe(0);
      expect(upstream.connections()).toBe(0);
      await eventually(() => first.active() === 0);
    } finally { await first.stop(); await next.stop(); await upstream.stop(); }
  });

  test("SOCKS handshake rejection never advances the chain", async () => {
    const socks = await own(createNetServer(socket => { socket.on("error", () => {}); socket.once("data", () => socket.end(Buffer.from([5, 255]))); }));
    const next = await own(createNetServer());
    try {
      expect(await dialUpstreamTunnel({ policy: policy([`socks5://127.0.0.1:${socks.port}`, `http://127.0.0.1:${next.port}`]), requestUrl: "wss://chatgpt.com/voice" })).toBeNull();
      expect(next.connections()).toBe(0);
    } finally { await socks.stop(); await next.stop(); }
  });

  for (const [label, certificate] of [
    ["wrong hostname", issueLocalInterceptLeaf(ca, ["wrong.example"])],
    ["untrusted issuer", issueLocalInterceptLeaf(createLocalInterceptCa(), ["chatgpt.com"])],
    ["self signed", mintAuthorityWithExtensionsForTests("chatgpt.com", [])],
  ] as const) test(`upstream TLS ${label} fails closed without fallback`, async () => {
    const upstream = await origin((_req, res) => res.end("must not send"), certificate);
    const first = await proxy(upstream.port);
    const next = await proxy(upstream.port);
    try {
      await expect(createPolicyFetch(policy([first.url, next.url, null]), { ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } })("https://chatgpt.com/tls")).rejects.toThrow();
      expect(next.connections()).toBe(0);
      expect(first.heads).toHaveLength(1);
    } finally { await first.stop(); await next.stop(); await upstream.stop(); }
  });

  for (const [label, certificate] of [
    ["wrong IP SAN", issueLocalInterceptLeaf(ca, ["wrong.example"])],
    ["untrusted issuer", issueLocalInterceptLeaf(createLocalInterceptCa(), ["127.0.0.1"])],
    ["self signed", mintAuthorityWithExtensionsForTests("127.0.0.1", [])],
  ] as const) test(`HTTPS proxy TLS ${label} fails before CONNECT and cannot fall back`, async () => {
    const upstream = await origin((_req, res) => res.end("must not send"));
    const first = await proxy(upstream.port, "tunnel", certificate);
    const next = await proxy(upstream.port);
    try {
      await expect(createPolicyFetch(policy([first.url, next.url, null]), { ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } })("https://chatgpt.com/tls-proxy")).rejects.toThrow();
      expect(first.heads).toHaveLength(0);
      expect(next.connections()).toBe(0);
      expect(upstream.connections()).toBe(0);
    } finally { await first.stop(); await next.stop(); await upstream.stop(); }
  });

  test("HTTP uses a verified HTTPS CONNECT proxy without redialing either TLS layer", async () => {
    const upstream = await origin((_req, res) => res.end("nested TLS"));
    const secureProxy = await proxy(upstream.port, "tunnel", issueLocalInterceptLeaf(ca, ["127.0.0.1"]));
    try {
      const result = await createPolicyFetch(policy([secureProxy.url]), { ca: ca.certPem })("https://chatgpt.com/secure-proxy");
      expect(await result.text()).toBe("nested TLS");
      expect(secureProxy.connections()).toBe(1);
      expect(secureProxy.heads).toHaveLength(1);
      expect(upstream.connections()).toBe(1);
    } finally { await secureProxy.stop(); await upstream.stop(); }
  });

  test("HTTP sends through the exact SOCKS5 connection selected by the policy", async () => {
    const upstream = await origin((_req, res) => res.end("SOCKS body"));
    const targets: string[] = [];
    const socks = await own(createNetServer(client => {
      client.on("error", () => {});
      client.once("data", () => {
        client.write(Buffer.from([5, 0]));
        let buffer = Buffer.alloc(0);
        const connectRequest = (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length < 5 || buffer.length < 7 + buffer[4]!) return;
          client.removeListener("data", connectRequest);
          targets.push(buffer.subarray(5, 5 + buffer[4]!).toString());
          const remote = connect(upstream.port, "127.0.0.1", () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.pipe(remote).pipe(client);
          });
          remote.on("error", () => client.destroy());
          client.on("close", () => remote.destroy());
          remote.on("close", () => client.destroy());
        };
        client.on("data", connectRequest);
      });
    }));
    try {
      const result = await createPolicyFetch(policy([`socks5://127.0.0.1:${socks.port}`]), { ca: ca.certPem })("https://chatgpt.com/socks");
      expect(await result.text()).toBe("SOCKS body");
      expect(targets).toEqual(["chatgpt.com"]);
      expect(socks.connections()).toBe(1);
      expect(upstream.connections()).toBe(1);
    } finally { await socks.stop(); await upstream.stop(); }
  });

  test("application refusal and truncated response never replay a POST", async () => {
    let sends = 0;
    const upstream = await origin((req, res) => {
      sends++;
      if (req.url === "/refused") { res.writeHead(503); res.end("unavailable"); }
      else { res.writeHead(200, { "content-length": 100 }); res.write("partial"); setTimeout(() => res.destroy(), 20); }
    });
    const first = await proxy(upstream.port);
    const next = await proxy(upstream.port);
    try {
      const fetch = createPolicyFetch(policy([first.url, next.url]), { ca: ca.certPem });
      const refused = await fetch("https://chatgpt.com/refused", { method: "POST", body: "one" });
      expect(refused.status).toBe(503);
      expect(await refused.text()).toBe("unavailable");
      const truncated = await fetch("https://chatgpt.com/truncated", { method: "POST", body: "two" });
      await expect(truncated.text()).rejects.toThrow();
      expect(sends).toBe(2);
      expect(first.connections()).toBe(2);
      expect(next.connections()).toBe(0);
    } finally { await first.stop(); await next.stop(); await upstream.stop(); }
  });

  test("POST network failure after send is never replayed", async () => {
    let sends = 0;
    const upstream = await origin((req, _res) => { sends++; req.socket.destroy(); });
    const first = await proxy(upstream.port);
    const next = await proxy(upstream.port);
    try {
      await expect(createPolicyFetch(policy([first.url, next.url, null]), { ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } })("https://chatgpt.com/send", { method: "POST", body: "single" })).rejects.toThrow();
      expect(sends).toBe(1);
      expect(first.connections()).toBe(1);
      expect(next.connections()).toBe(0);
    } finally { await first.stop(); await next.stop(); await upstream.stop(); }
  });

  test("manual redirects, duplicate cookies, HEAD and null-body statuses are preserved", async () => {
    const seen: string[] = [];
    const upstream = await origin((req, res) => {
      seen.push(req.url!);
      if (req.url === "/redirect") { res.writeHead(302, { location: "https://example.invalid/", "set-cookie": ["a=1; Path=/", "b=2; Path=/"] }); res.end("redirect"); }
      else { res.writeHead(Number(req.url!.slice(1)) || 200); res.end(); }
    });
    try {
      const fetch = createPolicyFetch(policy([null]), { ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } });
      const redirect = await fetch("https://chatgpt.com/redirect", { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
      expect(await redirect.text()).toBe("redirect");
      for (const status of [204, 205, 304]) {
        const response = await fetch(`https://chatgpt.com/${status}`);
        expect(response.status).toBe(status);
        expect(response.body).toBeNull();
      }
      expect((await fetch("https://chatgpt.com/head", { method: "HEAD" })).body).toBeNull();
      expect(seen).toEqual(["/redirect", "/204", "/205", "/304", "/head"]);
    } finally { await upstream.stop(); }
  });

  for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
    test(`decodes ${encoding} without forwarding stale encoded length`, async () => {
      const upstream = await origin((_req, res) => { const bytes = compress(Buffer.from("data: stream\n\n")); res.writeHead(200, { "content-encoding": encoding, "content-length": bytes.length }); res.end(bytes); });
      try {
        const response = await createPolicyFetch(policy([null]), { ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } })("https://chatgpt.com/compressed");
        expect(response.headers.has("content-encoding")).toBe(false);
        expect(response.headers.has("content-length")).toBe(false);
        expect(await response.text()).toBe("data: stream\n\n");
      } finally { await upstream.stop(); }
    });
  }

  test("streaming upload and SSE response remain live before either body finishes", async () => {
    let requestBody = "";
    let response!: ServerResponse;
    const upstream = await origin((req, res) => {
      response = res;
      req.on("data", chunk => {
        requestBody += chunk;
        if (requestBody === "first") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: first\n\n"); }
      });
      req.on("end", () => res.end("data: last\n\n"));
    });
    let upload!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { upload = controller; controller.enqueue(new TextEncoder().encode("first")); } });
    try {
      const result = await createPolicyFetch(policy([null]), { ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port } })("https://chatgpt.com/stream", { method: "POST", body });
      const reader = result.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
      expect(response.writableEnded).toBe(false);
      upload.enqueue(new TextEncoder().encode("last")); upload.close();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: last\n\n");
      expect((await reader.read()).done).toBe(true);
      expect(requestBody).toBe("firstlast");
    } finally { await upstream.stop(); }
  });

  test("headers timeout and abort close the chosen socket without fallback", async () => {
    const upstream = await origin(() => {});
    const first = await proxy(upstream.port);
    const next = await proxy(upstream.port);
    try {
      const routes = policy([first.url, next.url]);
      await expect(createPolicyFetch(routes, { ca: ca.certPem, headersTimeoutMs: 50 })("https://chatgpt.com/stall")).rejects.toThrow("headers timed out");
      await eventually(() => first.active() === 0);
      const abort = new AbortController();
      const pending = createPolicyFetch(routes, { ca: ca.certPem })("https://chatgpt.com/abort", { signal: abort.signal });
      await eventually(() => upstream.connections() === 2);
      abort.abort();
      await expect(pending).rejects.toThrow();
      await eventually(() => first.active() === 0);
      expect(next.connections()).toBe(0);
    } finally { await first.stop(); await next.stop(); await upstream.stop(); }
  });

  test("TLS and trickling CONNECT headers have absolute deadlines without fallback", async () => {
    const stalledTls = await own(createNetServer(socket => socket.on("error", () => {})));
    const first = await proxy(stalledTls.port);
    const next = await proxy(stalledTls.port);
    const trickle = await own(createNetServer(socket => {
      socket.on("error", () => {});
      const timer = setInterval(() => socket.write("H"), 5);
      socket.on("close", () => clearInterval(timer));
    }));
    try {
      const started = Date.now();
      expect(await dialUpstreamTunnel({ policy: policy([first.url, next.url]), connectTimeoutMs: 50 })).toBeNull();
      expect(await dialUpstreamTunnel({ policy: policy([`http://127.0.0.1:${trickle.port}`, next.url]), connectTimeoutMs: 50 })).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(next.connections()).toBe(0);
      await eventually(() => first.active() === 0 && trickle.active() === 0);
    } finally { await first.stop(); await next.stop(); await stalledTls.stop(); await trickle.stop(); }
  });

  test("abort during a proxy handshake closes it and a late policy resolution never dials", async () => {
    const stalled = await proxy(1, "stall");
    try {
      const abort = new AbortController();
      const pending = dialUpstreamTunnel({ policy: policy([stalled.url, null]), signal: abort.signal });
      await eventually(() => stalled.heads.length === 1);
      abort.abort();
      expect(await pending).toBeNull();
      await eventually(() => stalled.active() === 0);
      let finish!: (routes: readonly (string | null)[]) => void;
      const late: RuntimePacPolicy = { resolve: () => new Promise(resolve => { finish = resolve; }), close() {} };
      const laterAbort = new AbortController();
      const later = dialUpstreamTunnel({ policy: late, signal: laterAbort.signal });
      await Promise.resolve();
      laterAbort.abort();
      expect(await later).toBeNull();
      finish([stalled.url]);
      await delay(10);
      expect(stalled.connections()).toBe(1);
    } finally { await stalled.stop(); }
  });

  test("response cancellation and runtime abort close active streaming sockets", async () => {
    const upstream = await origin((_req, res) => { res.writeHead(200); res.write("one"); });
    try {
      const stop = new AbortController();
      const fetch = createPolicyFetch(policy([null]), { ca: ca.certPem, target: { host: "127.0.0.1", port: upstream.port }, signal: stop.signal });
      const first = await fetch("https://chatgpt.com/cancel");
      await first.body!.cancel();
      await eventually(() => upstream.active() === 0);
      const second = await fetch("https://chatgpt.com/runtime-stop");
      const reader = second.body!.getReader();
      await reader.read();
      stop.abort();
      await expect(reader.read()).rejects.toThrow();
      await eventually(() => upstream.active() === 0);
    } finally { await upstream.stop(); }
  });

  test("oversized HTTP response headers fail without a second route", async () => {
    const upstream = await origin((_req, res) => { res.writeHead(200, { "x-large": "a".repeat(70 * 1024) }); res.end("oversized"); });
    const first = await proxy(upstream.port);
    const next = await proxy(upstream.port);
    try {
      await expect(createPolicyFetch(policy([first.url, next.url]), { ca: ca.certPem })("https://chatgpt.com/large-head")).rejects.toThrow();
      expect(next.connections()).toBe(0);
    } finally { await first.stop(); await next.stop(); await upstream.stop(); }
  });

  for (const abort of [false, true]) test(`WebSocket ${abort ? "abort" : "header deadline"} closes the selected socket without fallback`, async () => {
    const controller = new AbortController();
    const upstream = await own(createTlsServer({ cert: leaf.certPem, key: leaf.keyPem }, socket => {
      socket.on("error", () => {});
      socket.once("data", () => {
        if (abort) controller.abort();
        else {
          const timer = setInterval(() => socket.write("H"), 5);
          socket.on("close", () => clearInterval(timer));
        }
      });
    }));
    const first = await proxy(upstream.port);
    const next = await proxy(upstream.port);
    try {
      const result = await performUpstreamHandshake(new Request("https://127.0.0.1/voice"), {
        policy: policy([first.url, next.url]), ca: ca.certPem, headersTimeoutMs: 50, signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      await eventually(() => first.active() === 0);
      expect(next.connections()).toBe(0);
    } finally { await first.stop(); await next.stop(); await upstream.stop(); }
  });

  test("WebSocket uses the original wss URL and the same policy-owned selected socket", async () => {
    const heads: string[] = [];
    const server = createTlsServer({ cert: leaf.certPem, key: leaf.keyPem }, socket => {
      socket.on("error", () => {});
      socket.once("data", chunk => { heads.push(chunk.toString()); socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); });
    });
    const upstream = await own(server);
    const first = await proxy(upstream.port);
    const next = await proxy(upstream.port);
    const selected = policy([first.url, next.url, null]);
    const stop = new AbortController();
    try {
      const result = await performUpstreamHandshake(new Request("https://127.0.0.1:12345/dictation/stream?lang=en"), { policy: selected, ca: ca.certPem, signal: stop.signal });
      expect(result.ok).toBe(true);
      stop.abort();
      if (result.ok) expect(result.tunnel.socket.destroyed).toBe(true);
      expect(selected.urls).toEqual(["wss://chatgpt.com/dictation/stream?lang=en"]);
      expect(first.connections()).toBe(1);
      expect(next.connections()).toBe(0);
      expect(upstream.connections()).toBe(1);
      expect(heads[0]).toStartWith("GET /dictation/stream?lang=en HTTP/1.1\r\nHost: chatgpt.com\r\n");
    } finally { await first.stop(); await next.stop(); await upstream.stop(); }
  });
});
