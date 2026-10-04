import { expect, test } from "bun:test";
import { createServer, request } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { gzipSync } from "node:zlib";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { PICKER_MAX_HEADER_BYTES, startPickerListener } from "../../src/claude/intercept/picker-listener";
import type { PickerListenerHandle } from "../../src/claude/intercept/picker-listener";
import type { TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";

const HEADER_LIMIT = 64 * 1024;
const largeCookie = "synthetic-session=" + "x".repeat(24 * 1024);
const binary = Buffer.from([0, 255, 128, 13, 10, 0, 195, 40]);
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
  const upstream = createServer({ cert: upstreamLeaf.certPem, key: upstreamLeaf.keyPem, maxHeaderSize: PICKER_MAX_HEADER_BYTES }, handler);
  const sockets = new Set<Duplex>();
  for (const event of ["connection", "secureConnection"] as const) upstream.on(event, socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
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
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  };
  const get = (path: string, method = "GET") => clientRequest(relay, ca.certPem, path, method);
  return { upstream, relay, ca: ca.certPem, get, logs, close };
}

function clientRequest(relay: PickerListenerHandle, ca: string, path: string, method = "GET",
  options: { headers?: Record<string, string>; body?: Buffer; onChunk?: (chunk: Buffer) => void } = {},
): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: relay.port, servername: "claude.ai", ca,
      rejectUnauthorized: true, path, method, headers: { Host: "claude.ai", ...options.headers },
      agent: false, maxHeaderSize: PICKER_MAX_HEADER_BYTES }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => { chunks.push(chunk); options.onChunk?.(chunk); });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers,
        rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    const timeout = setTimeout(() => req.destroy(new Error("picker request timed out")), 2000);
    req.once("close", () => clearTimeout(timeout));
    req.on("error", reject);
    req.end(options.body);
  });
}

// Raw TLS avoids the test client's own HTTP parser imposing a header limit.
function rawExchange(f: Awaited<ReturnType<typeof fixture>>, wire: Buffer,
  onData?: (socket: TLSSocket, received: Buffer) => boolean,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port: f.relay.port, servername: "claude.ai", ca: f.ca,
      rejectUnauthorized: true }, () => socket.write(wire));
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => socket.destroy(new Error("raw picker exchange timed out")), 2000);
    socket.on("data", chunk => {
      chunks.push(chunk);
      if (onData?.(socket, Buffer.concat(chunks))) socket.destroy();
    });
    socket.once("error", reject);
    socket.once("close", () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)); });
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

for (const contentType of ["text/event-stream", "application/octet-stream"]) {
  test(`large-header ${contentType} streams first bytes before upstream end and all bytes exactly`, async () => {
    const first = contentType === "text/event-stream" ? Buffer.from("data: first\n\n") : binary;
    const last = contentType === "text/event-stream" ? Buffer.from("data: second\n\n") : Buffer.from([254, 0, 129]);
    let finish!: () => void;
    let ended = false;
    const arrived = Promise.withResolvers<Buffer>();
    const early: Buffer[] = [];
    const f = await fixture((req, res) => {
      expect(req.headers.cookie).toBe(largeCookie);
      res.writeHead(200, { "Content-Type": contentType, "Set-Cookie": largeCookie });
      res.write(first);
      finish = () => { ended = true; res.end(last); };
    });
    try {
      const complete = clientRequest(f.relay, f.ca, "/events", "GET", {
        headers: { Cookie: largeCookie }, onChunk: chunk => {
          early.push(chunk);
          const bytes = Buffer.concat(early);
          if (bytes.length >= first.length) arrived.resolve(bytes);
        },
      });
      // Failure or premature completion settles the first-byte wait without a sleep.
      void complete.then(() => arrived.reject(new Error("stream ended before first bytes")), arrived.reject);
      expect((await arrived.promise).equals(first)).toBe(true);
      expect(ended).toBe(false);
      finish();
      const received = await complete;
      expect(received.status).toBe(200);
      expect(received.headers["set-cookie"]).toEqual([largeCookie]);
      expect(received.body.equals(Buffer.concat([first, last]))).toBe(true);
      expect(f.logs).toEqual(["picker GET other 200"]);
    } finally { await f.close(); }
  });
}

test("bootstrap with large request and response cookies is injected with identity headers", async () => {
  const gzipped = gzipSync(bootstrap);
  const f = await fixture((req, res) => {
    expect(req.headers.cookie).toBe(largeCookie);
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip",
      "Content-Length": String(gzipped.length), ETag: "old", "Set-Cookie": [largeCookie, "second=synthetic"] });
    res.end(gzipped);
  });
  try {
    const received = await clientRequest(f.relay, f.ca, "/edge-api/bootstrap/org/app_start?cache_bust=1", "GET",
      { headers: { Cookie: largeCookie } });
    expect(received.headers["set-cookie"]).toEqual([largeCookie, "second=synthetic"]);
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

test("large-cookie upgrade preserves coalesced binary head and bidirectional echo", async () => {
  const f = await fixture((_req, res) => res.end("ordinary"));
  const prefix = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
  const echo = Buffer.from([0, 253, 128, 10, 255]);
  const observed = Promise.withResolvers<Buffer>();
  let cookie: string | undefined;
  f.upstream.on("upgrade", (req, socket, head) => {
    cookie = req.headers.cookie;
    const chunks = [head];
    socket.write(prefix);
    if (head.length) socket.write(head);
    socket.on("data", chunk => {
      chunks.push(chunk);
      socket.write(chunk);
      if (Buffer.concat(chunks).length === binary.length + echo.length) observed.resolve(Buffer.concat(chunks));
    });
  });
  try {
    let sent = false;
    const received = await rawExchange(f, Buffer.concat([Buffer.from(
      `GET /api/ws/synthetic HTTP/1.1\r\nHost: claude.ai\r\nCookie: ${largeCookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`), binary]),
      (socket, bytes) => {
        if (!sent && bytes.length >= Buffer.byteLength(prefix)) { sent = true; socket.write(echo); }
        return bytes.length >= Buffer.byteLength(prefix) + binary.length + echo.length;
      });
    expect(received.equals(Buffer.concat([Buffer.from(prefix), binary, echo]))).toBe(true);
    expect((await observed.promise).equals(Buffer.concat([binary, echo]))).toBe(true);
    expect(cookie).toBe(largeCookie);
    expect(f.logs).toEqual(["picker GET other 101"]);
  } finally { await f.close(); }
});

test("untrusted upgrade TLS fails with fixed logs and no synthetic request data", async () => {
  let upgraded = false;
  const f = await fixture((_req, res) => res.end("must not arrive"), { untrusted: true });
  f.upstream.on("upgrade", () => { upgraded = true; });
  try {
    const received = await rawExchange(f, Buffer.concat([Buffer.from(
      `GET /synthetic-private-path?query=synthetic-private-query HTTP/1.1\r\nHost: claude.ai\r\nCookie: ${largeCookie}\r\nX-Synthetic: private-header\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`), binary]));
    expect(received.toString()).toBe("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    expect(upgraded).toBe(false);
    expect(f.logs).toEqual(["picker GET other 502"]);
  } finally { await f.close(); }
});

test("ordinary large request cookie and binary POST body reach upstream unchanged", async () => {
  let observed: { method?: string; header?: string; cookie?: string; body: Buffer } | undefined;
  const f = await fixture((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      observed = { method: req.method, header: req.headers["x-test"] as string,
        cookie: req.headers.cookie, body: Buffer.concat(chunks) };
      res.writeHead(201, { "Content-Type": "application/octet-stream" });
      res.end(binary);
    });
  });
  try {
    const received = await clientRequest(f.relay, f.ca, "/submit", "POST", {
      headers: { "X-Test": "retained", Cookie: largeCookie, "Content-Length": String(binary.length) }, body: binary,
    });
    expect(received.status).toBe(201);
    expect(received.body.equals(binary)).toBe(true);
    expect(observed).toEqual({ method: "POST", header: "retained", cookie: largeCookie, body: binary });
    expect(f.logs).toEqual(["picker POST other 201"]);
  } finally { await f.close(); }
});

test("ordinary large response cookies preserve duplicate order and binary body", async () => {
  const cookies = [largeCookie + "; HttpOnly; Secure", "second=synthetic; Secure"];
  const f = await fixture((_req, res) => {
    res.writeHead(200, ["Set-Cookie", cookies[0]!, "Set-Cookie", cookies[1]!,
      "Content-Type", "application/octet-stream", "Content-Length", String(binary.length)]);
    res.end(binary);
  });
  try {
    const received = await f.get("/api/organizations/synthetic/chat_conversations");
    expect(received.status).toBe(200);
    expect(received.headers["set-cookie"]).toEqual(cookies);
    const rawCookies = received.rawHeaders.flatMap((name, i, raw) =>
      i % 2 === 0 && name.toLowerCase() === "set-cookie" ? [raw[i + 1]] : []);
    expect(rawCookies).toEqual(cookies);
    expect(received.body.equals(binary)).toBe(true);
    expect(f.logs).toEqual(["picker GET other 200"]);
  } finally { await f.close(); }
});

test("response headers over the bounded picker limit fail closed with fixed logs", async () => {
  expect(PICKER_MAX_HEADER_BYTES).toBe(HEADER_LIMIT);
  const body = Buffer.from("synthetic-private-request-body!");
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Set-Cookie": "synthetic-private-header=" + "x".repeat(HEADER_LIMIT) });
    res.end("synthetic-private-response-body");
  });
  try {
    const received = await clientRequest(f.relay, f.ca, "/synthetic-private-path?query=synthetic-private-query", "POST", {
      headers: { "X-Synthetic": "synthetic-private-request-header", "Content-Length": String(body.length) },
      body,
    });
    expect(received.status).toBe(502);
    expect(received.body.length).toBe(0);
    expect(f.logs).toEqual(["picker POST other upstream:headers-too-large", "picker POST other 502"]);
  } finally { await f.close(); }
});

for (const [kind, headers] of [
  ["single", `Cookie: synthetic-private-header=${"x".repeat(HEADER_LIMIT + 1024)}\r\n`],
  ["aggregate", Array.from({ length: 5 }, (_, i) => `X-Synthetic-${i}: ${"x".repeat(14 * 1024)}\r\n`).join("")],
]) {
  test(`${kind} inbound headers above 64 KiB are rejected before upstream`, async () => {
    let requests = 0;
    const f = await fixture((_req, res) => { requests++; res.end("must not arrive"); });
    try {
      const received = await rawExchange(f, Buffer.from(
        `GET /synthetic-private-path?query=synthetic-private-query HTTP/1.1\r\nHost: claude.ai\r\n${headers}Connection: close\r\n\r\n`));
      expect(requests).toBe(0);
      expect(received.toString()).toBe("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
      expect(f.logs).toEqual([]);
    } finally { await f.close(); }
  });
}
