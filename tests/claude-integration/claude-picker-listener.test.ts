import { expect, test } from "bun:test";
import { createServer, request } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { gzipSync } from "node:zlib";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { startPickerListener } from "../../src/claude/intercept/picker-listener";
import type { PickerListenerHandle } from "../../src/claude/intercept/picker-listener";
import type { Server as HttpsServer } from "node:https";
import type { IncomingMessage } from "node:http";

const models = [{ id: "ocx-model", name: "Routed" }];
const bootstrap = Buffer.from(JSON.stringify({ model_selector_config: [
  { id: "code", models: [{ id: "claude-native", name: "Native", section: "main" }] },
] }));

type ResponseData = { status: number; headers: IncomingMessage["headers"]; rawHeaders: string[]; body: Buffer };

async function fixture(
  handler: Parameters<typeof createServer>[1],
  options: { maxEncodedBytes?: number; untrusted?: boolean } = {},
) {
  const ca = createLocalInterceptCa();
  const upstreamCa = options.untrusted ? createLocalInterceptCa() : ca;
  const leaf = issueLocalInterceptLeaf(ca, ["claude.ai"]);
  const upstreamLeaf = issueLocalInterceptLeaf(upstreamCa, ["claude.ai"]);
  const upstream = createServer({ cert: upstreamLeaf.certPem, key: upstreamLeaf.keyPem }, handler);
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream port missing");
  const logs: string[] = [];
  const relay = await startPickerListener({
    leaf, models: () => models,
    upstream: { host: "127.0.0.1", port: address.port, servername: "claude.ai", ca: ca.certPem },
    maxEncodedBytes: options.maxEncodedBytes,
    log: line => logs.push(line),
  });
  const close = async () => {
    await relay.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  };
  const get = (path: string, method = "GET") => clientRequest(relay, ca.certPem, path, method);
  return { upstream, relay, ca: ca.certPem, get, logs, close };
}

function clientRequest(relay: PickerListenerHandle, ca: string, path: string, method = "GET"): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: relay.port, servername: "claude.ai", ca,
      rejectUnauthorized: true, path, method, headers: { Host: "claude.ai" }, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers,
        rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

test("opaque gzip body and duplicate Set-Cookie headers survive", async () => {
  const body = gzipSync(Buffer.from("opaque response"));
  const f = await fixture((_req, res) => {
    res.writeHead(200, ["Content-Encoding", "gzip", "Content-Length", String(body.length),
      "Set-Cookie", "a=1; HttpOnly", "Set-Cookie", "b=2; Secure"]);
    res.end(body);
  });
  try {
    const received = await f.get("/v1/other");
    expect(received.status).toBe(200);
    expect(received.body.equals(body)).toBe(true);
    expect(received.headers["content-encoding"]).toBe("gzip");
    expect(received.headers["set-cookie"]).toEqual(["a=1; HttpOnly", "b=2; Secure"]);
    expect(f.logs).toEqual(["picker GET other 200"]);
  } finally { await f.close(); }
});

test("SSE first chunk reaches the client before upstream end", async () => {
  let finish!: () => void;
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    finish = () => res.end("data: second\n\n");
  });
  try {
    const first = new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: f.relay.port, servername: "claude.ai", ca: f.ca,
        path: "/events", headers: { Host: "claude.ai" }, agent: false }, res => {
        res.once("data", chunk => resolve(chunk.toString()));
      });
      req.on("error", reject);
      req.end();
    });
    expect(await first).toBe("data: first\n\n");
    finish();
  } finally { await f.close(); }
});

test("bootstrap JSON is injected and emitted with identity headers", async () => {
  const gzipped = gzipSync(bootstrap);
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip",
      "Content-Length": String(gzipped.length), ETag: "old" });
    res.end(gzipped);
  });
  try {
    const received = await f.get("/edge-api/bootstrap/org/app_start?cache_bust=1");
    expect(received.status).toBe(200);
    expect(received.headers["content-encoding"]).toBeUndefined();
    expect(received.headers.etag).toBeUndefined();
    expect(Number(received.headers["content-length"])).toBe(received.body.length);
    expect(JSON.parse(received.body.toString()).model_selector_config[0].models[1].id).toBe("ocx-model");
    expect(f.logs).toEqual(["picker GET bootstrap 200", "picker GET bootstrap rewritten(+1)"]);
  } finally { await f.close(); }
});

test("mid-chunk encoded cap overflow passes original bytes exactly once", async () => {
  const body = Buffer.concat([bootstrap, Buffer.from("tail")]);
  const first = body.subarray(0, 10);
  const second = body.subarray(10);
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length), ETag: "same" });
    res.write(first);
    setTimeout(() => res.end(second), 20);
  }, { maxEncodedBytes: first.length + 3 });
  try {
    const received = await f.get("/api/bootstrap");
    expect(received.status).toBe(200);
    expect(received.body.equals(body)).toBe(true);
    expect(received.headers.etag).toBe("same");
    expect(received.headers["content-length"]).toBe(String(body.length));
  } finally { await f.close(); }
});

test("malformed bootstrap JSON passes byte-identical with original headers", async () => {
  const body = Buffer.from("{ malformed JSON");
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length), ETag: "same" });
    res.end(body);
  });
  try {
    const received = await f.get("/edge-api/bootstrap");
    expect(received.body.equals(body)).toBe(true);
    expect(received.headers.etag).toBe("same");
  } finally { await f.close(); }
});

test("untrusted upstream certificate yields an empty 502", async () => {
  const f = await fixture((_req, res) => res.end("should not arrive"), { untrusted: true });
  try {
    const received = await f.get("/v1/other");
    expect(received.status).toBe(502);
    expect(received.body.length).toBe(0);
    expect(f.logs).toEqual(["picker GET other 502"]);
  } finally { await f.close(); }
});

test("WebSocket upgrade carries bytes in both directions", async () => {
  const f = await fixture((_req, res) => res.end("ordinary"));
  f.upstream.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.on("data", data => socket.write(data));
  });
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const socket = tlsConnect({ host: "127.0.0.1", port: f.relay.port, servername: "claude.ai", ca: f.ca,
        rejectUnauthorized: true }, () => {
        socket.write("GET /api/ws/test HTTP/1.1\r\nHost: claude.ai\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      });
      let text = "";
      socket.on("data", chunk => {
        text += chunk.toString();
        if (text.includes("\r\n\r\n") && !text.includes("echo-me")) socket.write("echo-me");
        if (text.includes("echo-me")) { socket.destroy(); resolve(text); }
      });
      socket.on("error", reject);
    });
    expect(result).toContain("101 Switching Protocols");
    expect(result).toContain("echo-me");
  } finally { await f.close(); }
});

test("ordinary request method, body and headers relay upstream", async () => {
  let observed: { method?: string; header?: string; body: string } | undefined;
  const f = await fixture((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      observed = { method: req.method, header: req.headers["x-test"] as string,
        body: Buffer.concat(chunks).toString() };
      res.writeHead(201, { "Content-Type": "text/plain" });
      res.end("ok");
    });
  });
  try {
    const received = await new Promise<ResponseData>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: f.relay.port, servername: "claude.ai", ca: f.ca,
        rejectUnauthorized: true, path: "/submit", method: "POST", agent: false,
        headers: { Host: "claude.ai", "X-Test": "retained", "Content-Length": "7" } }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers,
          rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end("payload");
    });
    expect(received.status).toBe(201);
    expect(received.body.toString()).toBe("ok");
    expect(observed).toEqual({ method: "POST", header: "retained", body: "payload" });
    expect(f.logs).toEqual(["picker POST other 201"]);
  } finally { await f.close(); }
});
