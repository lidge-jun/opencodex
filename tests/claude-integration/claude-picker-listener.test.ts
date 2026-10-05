import { expect, test } from "bun:test";
import { createServer, request } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { gzipSync } from "node:zlib";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { PICKER_MAX_HEADER_BYTES, isRelayableH2Target, startPickerListener } from "../../src/claude/intercept/picker-listener";
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
  options: { maxEncodedBytes?: number; maxActiveUpstreams?: number; untrusted?: boolean } = {},
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
    maxActiveUpstreams: options.maxActiveUpstreams,
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

// HTTP/2 and ClientHello coverage is appended so the HTTP/1.1 regression cases stay unchanged.
import { connect as h2Connect, constants as h2Constants } from "node:http2";
import type { ClientHttp2Session, IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http2";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import type { ServerResponse } from "node:http";
import { CLIENT_HELLO_MAX_RECORDS, clientHelloOffersH2 } from "../../src/claude/intercept/client-hello";

type PickerFixture = Awaited<ReturnType<typeof fixture>>;
type DeadlineWait = <T>(promise: PromiseLike<T>) => Promise<T>;

function boundedPickerTest(name: string, body: (wait: DeadlineWait) => Promise<void>) {
  test(name, async () => {
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(() => expired.reject(new Error(`${name}: event deadline exceeded`)), 4500);
    // Observe the deadline even if the body fails before its first wait.
    void expired.promise.catch(() => {});
    const wait: DeadlineWait = promise => Promise.race([promise, expired.promise]);
    try { await wait(body(wait)); }
    finally { clearTimeout(timer); }
  }, 5000);
}

function uint16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function helloRecord(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), uint16(payload.length), payload]);
}

function syntheticHello(protocols?: string[], order: number[] = [0x0010]): Buffer {
  const names = protocols?.map(name => Buffer.concat([Buffer.from([name.length]), Buffer.from(name)]));
  const list = names ? Buffer.concat(names) : undefined;
  const extensions = Buffer.concat(order.flatMap(type => {
    if (type === 0x0010 && !list) return [];
    const body = type === 0x0010 ? Buffer.concat([uint16(list!.length), list!]) : Buffer.from([7, 8, 9]);
    return [Buffer.concat([uint16(type), uint16(body.length), body])];
  }));
  const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32, 1),
    Buffer.from([0]), uint16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]),
    uint16(extensions.length), extensions]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 1;
  handshake.writeUIntBE(body.length, 1, 3);
  return helloRecord(Buffer.concat([handshake, body]));
}

for (const [label, protocols, expected] of [
  ["h2 and http/1.1", ["h2", "http/1.1"], true],
  ["http/1.1 only", ["http/1.1"], false],
  ["no ALPN", undefined, false],
] as const) {
  test(`ClientHello parser recognizes ${label}`, () => {
    expect(clientHelloOffersH2(syntheticHello(protocols ? [...protocols] : undefined))).toBe(expected);
  });
}

for (const order of [[0x0a0a, 0x1234, 0x0010], [0x1234, 0x0010, 0x0a0a], [0x0010, 0x0a0a, 0x1234]]) {
  test(`ClientHello parser skips GREASE and unknown extensions in order ${order.join(",")}`, () => {
    expect(clientHelloOffersH2(syntheticHello(["h2", "http/1.1"], order))).toBe(true);
  });
}

test("ClientHello parser reassembles three records with split handshake length bytes", () => {
  const handshake = syntheticHello(["h2", "http/1.1"]).subarray(5);
  const wire = Buffer.concat([helloRecord(handshake.subarray(0, 2)),
    helloRecord(handshake.subarray(2, 3)), helloRecord(handshake.subarray(3))]);
  for (let length = 0; length < wire.length; length++) {
    expect(clientHelloOffersH2(wire.subarray(0, length))).toBeNull();
  }
  expect(clientHelloOffersH2(wire)).toBe(true);
});

test("every strict prefix of a complete ClientHello needs more bytes", () => {
  const wire = syntheticHello(["h2", "http/1.1"]);
  for (let length = 0; length < wire.length; length++) {
    expect(clientHelloOffersH2(wire.subarray(0, length))).toBeNull();
  }
  expect(clientHelloOffersH2(wire)).toBe(true);
});

test("ClientHello parser rejects non-handshake, oversized records and excessive fragmentation", () => {
  const wire = syntheticHello(["h2"]);
  const notHandshake = Buffer.from(wire);
  notHandshake[0] = 0x17;
  expect(clientHelloOffersH2(notHandshake)).toBe(false);
  expect(clientHelloOffersH2(Buffer.from([0x16, 0x03, 0x01, 0x40, 0x01]))).toBe(false);
  const handshake = wire.subarray(5);
  const records = Array.from({ length: CLIENT_HELLO_MAX_RECORDS + 1 }, (_, i) =>
    helloRecord(handshake.subarray(i, i + 1)));
  expect(clientHelloOffersH2(Buffer.concat(records))).toBe(false);
});

for (const [label, protocols, expected] of [
  ["h2", ["h2", "http/1.1"], true], ["http1", ["http/1.1"], false], ["absent ALPN", undefined, false],
] as const) {
  boundedPickerTest(`real TLS ClientHello with ${label} is parsed from captured wire bytes`, async wait => {
    const captured = Promise.withResolvers<boolean>();
    const accepted = new Set<Socket>();
    const server = createNetServer(socket => {
      accepted.add(socket);
      socket.on("error", captured.reject);
      socket.once("close", () => accepted.delete(socket));
      const chunks: Buffer[] = [];
      socket.on("data", chunk => {
        chunks.push(chunk);
        const result = clientHelloOffersH2(Buffer.concat(chunks));
        if (result !== null) { captured.resolve(result); socket.destroy(); }
      });
    });
    let client: TLSSocket | undefined;
    try {
      await wait(new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      }));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("capture port missing");
      client = tlsConnect({ host: "127.0.0.1", port: address.port, servername: "claude.ai",
        ...(protocols ? { ALPNProtocols: [...protocols] } : {}) });
      // The capture peer deliberately closes before TLS can complete.
      client.on("error", () => {});
      expect(await wait(captured.promise)).toBe(expected);
    } finally {
      client?.destroy();
      for (const socket of accepted) socket.destroy();
      await wait(new Promise<void>(resolve => server.close(() => resolve())));
    }
  });
}

function openH2(f: PickerFixture): ClientHttp2Session {
  const session = h2Connect(`https://127.0.0.1:${f.relay.port}`, { ca: f.ca, servername: "claude.ai" });
  // Individual requests observe session failures; teardown errors must not be uncaught.
  session.on("error", () => {});
  return session;
}

function h2Exchange(session: ClientHttp2Session, path: string,
  options: { method?: string; headers?: OutgoingHttpHeaders; body?: Buffer; paused?: boolean } = {},
) {
  const stream = session.request({ ":method": options.method ?? "GET", ":path": path,
    ":authority": "claude.ai", ...options.headers });
  const first = Promise.withResolvers<Buffer>();
  const response = Promise.withResolvers<IncomingHttpHeaders>();
  const complete = Promise.withResolvers<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>();
  const chunks: Buffer[] = [];
  let headers: IncomingHttpHeaders = {};
  let ended = false;
  const fail = (error: Error) => { first.reject(error); response.reject(error); complete.reject(error); };
  const sessionError = (error: Error) => fail(error);
  session.once("error", sessionError);
  stream.on("response", received => { headers = received; response.resolve(received); });
  stream.on("data", chunk => { chunks.push(Buffer.from(chunk)); first.resolve(Buffer.from(chunk)); });
  stream.once("error", fail);
  stream.once("end", () => {
    ended = true;
    first.resolve(Buffer.alloc(0));
    complete.resolve({ status: Number(headers[":status"]), headers, body: Buffer.concat(chunks) });
  });
  stream.once("close", () => {
    session.off("error", sessionError);
    if (!ended) fail(new Error(`h2 request closed with reset ${stream.rstCode}`));
  });
  // Streams may intentionally be reset without awaiting their body.
  for (const promise of [first.promise, response.promise, complete.promise]) void promise.catch(() => {});
  if (options.paused) stream.pause();
  stream.end(options.body);
  return { stream, first: first.promise, response: response.promise, complete: complete.promise };
}

for (const [offer, protocol] of [["h2", "h2"], ["http/1.1", "http/1.1"]] as const) {
  boundedPickerTest(`picker front negotiates ALPN ${protocol}`, async wait => {
    const f = await fixture((_req, res) => res.end());
    let socket: TLSSocket | undefined;
    try {
      const ready = Promise.withResolvers<void>();
      const sessionLogged = Promise.withResolvers<void>();
      // A TLS handshake alone need not create the h2 session until its preface arrives.
      socket = tlsConnect({ host: "127.0.0.1", port: f.relay.port, servername: "claude.ai", ca: f.ca,
        ALPNProtocols: offer === "h2" ? ["h2", "http/1.1"] : ["http/1.1"] }, () => ready.resolve());
      socket.on("error", ready.reject);
      await wait(ready.promise);
      // Bun's native HTTP/1.1 server does not report its ALPN choice; the contract is "never h2".
      if (protocol === "h2") expect(socket.alpnProtocol).toBe("h2");
      else expect(socket.alpnProtocol).not.toBe("h2");
      if (protocol === "h2") {
        socket.on("data", () => sessionLogged.resolve());
        socket.write(Buffer.concat([Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"),
          Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])]));
        await wait(sessionLogged.promise);
        expect(f.logs).toEqual(["picker session h2"]);
      } else expect(f.logs).toEqual([]);
    } finally { socket?.destroy(); await wait(f.close()); }
  });
}

boundedPickerTest("one h2 session holds eight SSE streams while an ordinary GET completes", async wait => {
  const held: ServerResponse[] = [];
  const f = await fixture((req, res) => {
    if (req.url?.startsWith("/stream/")) {
      held.push(res);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: held\n\n");
    } else res.end("ordinary on the same session");
  });
  const session = openH2(f);
  try {
    const streams = Array.from({ length: 8 }, (_, i) => h2Exchange(session, `/stream/${i}`));
    const first = await wait(Promise.all(streams.map(stream => stream.first)));
    expect(first.map(bytes => bytes.toString())).toEqual(Array(8).fill("data: held\n\n"));
    expect(held).toHaveLength(8);
    expect(held.every(res => !res.writableEnded)).toBe(true);
    const ordinary = await wait(h2Exchange(session, "/ordinary").complete);
    expect(ordinary.status).toBe(200);
    expect(ordinary.body.toString()).toBe("ordinary on the same session");
    expect(f.logs).toEqual(["picker session h2", ...Array(9).fill("picker GET other 200")]);
  } finally { session.destroy(); await wait(f.close()); }
});

boundedPickerTest("h2 gzip bootstrap rewrite preserves duplicate cookie order and correct identity length", async wait => {
  const gzipped = gzipSync(bootstrap);
  const cookies = [largeCookie, "second=synthetic"];
  const f = await fixture((_req, res) => {
    res.writeHead(200, ["Content-Type", "application/json", "Content-Encoding", "gzip",
      "Content-Length", String(gzipped.length), "ETag", "old", "Set-Cookie", cookies[0]!, "Set-Cookie", cookies[1]!]);
    res.end(gzipped);
  });
  const session = openH2(f);
  try {
    const received = await wait(h2Exchange(session, "/edge-api/bootstrap/org/app_start?cache_bust=1").complete);
    expect(received.status).toBe(200);
    expect(received.headers["set-cookie"]).toEqual(cookies);
    expect(received.headers["content-encoding"]).toBeUndefined();
    expect(received.headers.etag).toBeUndefined();
    expect(Number(received.headers["content-length"])).toBe(received.body.length);
    expect(JSON.parse(received.body.toString()).model_selector_config[0].models[1].id).toBe("ocx-model");
    expect(f.logs).toEqual(["picker session h2", "picker GET bootstrap 200", "picker GET bootstrap rewritten(+1)"]);
  } finally { session.destroy(); await wait(f.close()); }
});

for (const contentType of ["text/event-stream", "application/octet-stream"]) {
  boundedPickerTest(`h2 ${contentType} delivers first bytes before upstream end and exact binary bytes`, async wait => {
    const first = contentType === "text/event-stream" ? Buffer.from("data: first\n\n") : binary;
    const last = Buffer.from([254, 0, 129]);
    let response: ServerResponse | undefined;
    const f = await fixture((_req, res) => {
      response = res;
      res.writeHead(200, { "Content-Type": contentType, "Set-Cookie": ["a=1", "b=2"] });
      res.write(first);
    });
    const session = openH2(f);
    try {
      const exchange = h2Exchange(session, "/events");
      expect((await wait(exchange.first)).equals(first)).toBe(true);
      expect(response?.writableEnded).toBe(false);
      response!.end(last);
      const received = await wait(exchange.complete);
      expect(received.status).toBe(200);
      expect(received.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
      expect(received.body.equals(Buffer.concat([first, last]))).toBe(true);
      expect(f.logs).toEqual(["picker session h2", "picker GET other 200"]);
    } finally { session.destroy(); await wait(f.close()); }
  });
}

boundedPickerTest("h2 cookie crumbs and authority translate to one Cookie and Host with exact POST bytes", async wait => {
  let observed: { raw: string[]; host?: string; cookie?: string; body: Buffer } | undefined;
  const f = await fixture((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      observed = { raw: req.rawHeaders, host: req.headers.host, cookie: req.headers.cookie, body: Buffer.concat(chunks) };
      res.writeHead(201, { "Content-Type": "application/octet-stream" });
      res.end(binary);
    });
  });
  const session = openH2(f);
  try {
    const received = await wait(h2Exchange(session, "/submit", { method: "POST", body: binary,
      headers: { cookie: ["a=1", "b=2"], host: "synthetic.invalid", "content-length": String(binary.length) } }).complete);
    expect(received.status).toBe(201);
    expect(received.body.equals(binary)).toBe(true);
    expect(observed?.body.equals(binary)).toBe(true);
    expect(observed?.host).toBe("claude.ai");
    expect(observed?.cookie).toBe("a=1; b=2");
    const names = observed!.raw.filter((_value, i) => i % 2 === 0).map(name => name.toLowerCase());
    expect(names.filter(name => name === "cookie")).toHaveLength(1);
    expect(names.filter(name => name === "host")).toHaveLength(1);
    expect(names.some(name => name.startsWith(":"))).toBe(false);
    expect(f.logs).toEqual(["picker session h2", "picker POST other 201"]);
  } finally { session.destroy(); await wait(f.close()); }
});

for (const method of ["GET", "HEAD"]) {
  boundedPickerTest(`h2 ${method} cancellation closes upstream ${method === "HEAD" ? "before headers" : "during SSE"}`, async wait => {
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const f = await fixture((_req, res) => {
      res.once("close", () => closed.resolve());
      entered.resolve();
      if (method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: held\n\n");
      }
    });
    const session = openH2(f);
    try {
      const exchange = h2Exchange(session, "/cancel", { method });
      await wait(entered.promise);
      if (method === "GET") expect((await wait(exchange.first)).toString()).toBe("data: held\n\n");
      exchange.stream.close(h2Constants.NGHTTP2_CANCEL);
      await wait(closed.promise);
      expect(f.logs).toEqual(method === "GET" ? ["picker session h2", "picker GET other 200"] : ["picker session h2"]);
    } finally { session.destroy(); await wait(f.close()); }
  });
}

for (const failure of ["untrusted", "headers-too-large"]) {
  boundedPickerTest(`h2 upstream ${failure} fails with an empty 502 and fixed logs`, async wait => {
    const f = await fixture((_req, res) => {
      res.writeHead(200, { "Set-Cookie": "synthetic=" + "x".repeat(HEADER_LIMIT) });
      res.end("must not arrive");
    }, { untrusted: failure === "untrusted" });
    const session = openH2(f);
    try {
      const received = await wait(h2Exchange(session, "/v1/other").complete);
      expect(received.status).toBe(502);
      expect(received.body.length).toBe(0);
      expect(f.logs).toEqual(failure === "untrusted" ? ["picker session h2", "picker GET other 502"] :
        ["picker session h2", "picker GET other upstream:headers-too-large", "picker GET other 502"]);
    } finally { session.destroy(); await wait(f.close()); }
  });
}

boundedPickerTest("h2 decoded header overflow resets only that stream and leaves the session usable", async wait => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests++; res.end("next stream succeeds"); });
  const session = openH2(f);
  try {
    const headers = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x-pad-${i}`, "a".repeat(1700)]));
    const decodedBytes = Object.entries(headers).reduce((size, [name, value]) => size + name.length + value.length + 32, 0);
    // HPACK's five-bit Huffman code for 'a' keeps this block below the wire cap.
    expect(decodedBytes).toBeGreaterThan(HEADER_LIMIT);
    expect(40 * (Math.ceil(1700 * 5 / 8) + 32)).toBeLessThan(HEADER_LIMIT);
    const rejected = h2Exchange(session, "/overflow", { headers });
    const reset = Promise.withResolvers<void>();
    // rstCode is final at close; error can fire before the reset code is populated.
    rejected.stream.once("close", () => reset.resolve());
    await wait(reset.promise);
    expect(requests).toBe(0);
    expect(rejected.stream.rstCode).toBe(h2Constants.NGHTTP2_ENHANCE_YOUR_CALM);
    expect(f.logs).toEqual(["picker session h2"]);
    const received = await wait(h2Exchange(session, "/next").complete);
    expect(received.status).toBe(200);
    expect(received.body.toString()).toBe("next stream succeeds");
    expect(requests).toBe(1);
    expect(f.logs).toEqual(["picker session h2", "picker GET other 200"]);
  } finally { session.destroy(); await wait(f.close()); }
});

for (const [method, status] of [["HEAD", 200], ["GET", 204], ["GET", 304]] as const) {
  boundedPickerTest(`h2 ${method} ${status} completes with an empty body`, async wait => {
    const f = await fixture((_req, res) => { res.writeHead(status); res.end(); });
    const session = openH2(f);
    try {
      const received = await wait(h2Exchange(session, "/empty", { method }).complete);
      expect(received.status).toBe(status);
      expect(received.body.length).toBe(0);
      expect(f.logs).toEqual(["picker session h2", `picker ${method} other ${status}`]);
    } finally { session.destroy(); await wait(f.close()); }
  });
}

for (const protocol of ["http1", "h2"]) {
  boundedPickerTest(`${protocol} paused reader receives the whole body through the TCP front after resuming`, async wait => {
    const chunk = Buffer.alloc(64 * 1024, 0xa5);
    const total = 16 * 1024 * 1024;
    const blocked = Promise.withResolvers<number>();
    let written = 0;
    const f = await fixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(total) });
      const pump = () => {
        while (written < total && !res.destroyed) {
          written += chunk.length;
          if (!res.write(chunk)) {
            blocked.resolve(written);
            res.once("drain", pump);
            return;
          }
        }
        if (!res.destroyed) res.end();
      };
      pump();
    });
    let session: ClientHttp2Session | undefined;
    let req: ReturnType<typeof request> | undefined;
    try {
      let received: Promise<Buffer>;
      let resume: () => void;
      if (protocol === "h2") {
        session = openH2(f);
        const exchange = h2Exchange(session, "/download", { paused: true });
        await wait(exchange.response);
        received = exchange.complete.then(result => result.body);
        resume = () => exchange.stream.resume();
      } else {
        const ready = Promise.withResolvers<IncomingMessage>();
        const complete = Promise.withResolvers<Buffer>();
        void complete.promise.catch(() => {});
        req = request({ host: "127.0.0.1", port: f.relay.port, servername: "claude.ai", ca: f.ca,
          path: "/download", agent: false, headers: { Host: "claude.ai" } }, res => {
          res.pause();
          const chunks: Buffer[] = [];
          res.on("data", bytes => chunks.push(bytes));
          res.on("end", () => complete.resolve(Buffer.concat(chunks)));
          res.on("error", complete.reject);
          ready.resolve(res);
        });
        req.on("error", error => { ready.reject(error); complete.reject(error); });
        req.end();
        const res = await wait(ready.promise);
        received = complete.promise;
        resume = () => res.resume();
      }
      expect(await wait(blocked.promise)).toBeLessThan(32 * 1024 * 1024);
      resume();
      const body = await wait(received);
      expect(body.length).toBe(total);
      expect(body.equals(Buffer.alloc(total, 0xa5))).toBe(true);
      expect(f.logs).toEqual(protocol === "h2" ? ["picker session h2", "picker GET other 200"] : ["picker GET other 200"]);
    } finally { req?.destroy(); session?.destroy(); await wait(f.close()); }
  });
}

boundedPickerTest("close tears down an h2 SSE stream, HTTP/1.1 upgrade and incomplete ClientHello", async wait => {
  const sseClosed = Promise.withResolvers<void>();
  const f = await fixture((_req, res) => {
    res.once("close", () => sseClosed.resolve());
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: held\n\n");
  });
  const prefix = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
  f.upstream.on("upgrade", (_req, socket, head) => {
    socket.write(prefix);
    if (head.length) socket.write(head);
    socket.on("data", chunk => socket.write(chunk));
  });
  const session = openH2(f);
  let upgrade: TLSSocket | undefined;
  let raw: Socket | undefined;
  try {
    const exchange = h2Exchange(session, "/events");
    expect((await wait(exchange.first)).toString()).toBe("data: held\n\n");
    const echoed = Promise.withResolvers<void>();
    const upgradeClosed = Promise.withResolvers<void>();
    upgrade = tlsConnect({ host: "127.0.0.1", port: f.relay.port, servername: "claude.ai", ca: f.ca }, () => {
      upgrade!.write(Buffer.concat([Buffer.from("GET /ws HTTP/1.1\r\nHost: claude.ai\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"), binary]));
    });
    const chunks: Buffer[] = [];
    upgrade.on("data", chunk => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).equals(Buffer.concat([Buffer.from(prefix), binary]))) echoed.resolve();
    });
    upgrade.on("error", echoed.reject);
    upgrade.once("close", () => upgradeClosed.resolve());
    await wait(echoed.promise);
    const connected = Promise.withResolvers<void>();
    const rawClosed = Promise.withResolvers<void>();
    raw = netConnect({ host: "127.0.0.1", port: f.relay.port }, () => {
      raw!.write(Buffer.from([0x16, 0x03, 0x01]), () => connected.resolve());
    });
    raw.on("error", connected.reject);
    raw.once("close", () => rawClosed.resolve());
    await wait(connected.promise);
    await wait(f.relay.close());
    await wait(Promise.all([sseClosed.promise, rawClosed.promise, upgradeClosed.promise]));
    expect(f.logs).toEqual(["picker session h2", "picker GET other 200", "picker GET other 101"]);
  } finally { raw?.destroy(); upgrade?.destroy(); session.destroy(); await wait(f.close()); }
});

boundedPickerTest("ending a raw connection halfway through ClientHello closes the peek without upstream traffic", async wait => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests++; res.end("must not arrive"); });
  let raw: Socket | undefined;
  try {
    const closed = Promise.withResolvers<void>();
    const hello = syntheticHello(["h2", "http/1.1"]);
    raw = netConnect({ host: "127.0.0.1", port: f.relay.port }, () => raw!.end(hello.subarray(0, Math.floor(hello.length / 2))));
    raw.on("error", closed.reject);
    raw.once("close", () => closed.resolve());
    await wait(closed.promise);
    expect(requests).toBe(0);
    expect(f.logs).toEqual([]);
  } finally { raw?.destroy(); await wait(f.close()); }
});
test("h2 request targets relay only as a method token and origin-form path", () => {
  expect(isRelayableH2Target("GET", "/api/organizations?x=1")).toBe(true);
  expect(isRelayableH2Target("PROPFIND", "/")).toBe(true);
  for (const [method, target] of [
    ["BAD METHOD", "/"], ["GET", "/bad path"], ["GET", "*"], ["GET", "https://claude.ai/"],
    ["GET", "/tab\there"], ["GET", "/del\x7f"], ["", "/"], [undefined, "/"], ["GET", undefined],
  ] as const) {
    expect(isRelayableH2Target(method, target)).toBe(false);
  }
});

boundedPickerTest("the upstream budget refuses excess h2 streams without dialing and recovers", async wait => {
  const held: ServerResponse[] = [];
  let requests = 0;
  const f = await fixture((req, res) => {
    requests++;
    if (req.url?.startsWith("/stream/")) {
      held.push(res);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: held\n\n");
    } else res.end("ordinary");
  }, { maxActiveUpstreams: 2 });
  const session = openH2(f);
  try {
    const streams = [h2Exchange(session, "/stream/0"), h2Exchange(session, "/stream/1")];
    await wait(Promise.all(streams.map(stream => stream.first)));
    const refused = await wait(h2Exchange(session, "/ordinary").complete);
    expect(refused.status).toBe(503);
    expect(refused.body.length).toBe(0);
    expect(requests).toBe(2);
    expect(f.logs).toContain("picker request refused 503");
    held[0]!.end();
    await wait(streams[0]!.complete);
    // The slot frees when the relayed exchange closes, which can trail the client's end of stream.
    let received = await wait(h2Exchange(session, "/ordinary").complete);
    for (let attempt = 0; received.status === 503 && attempt < 50; attempt++) {
      received = await wait(h2Exchange(session, "/ordinary").complete);
    }
    expect(received.status).toBe(200);
    expect(received.body.toString()).toBe("ordinary");
    expect(requests).toBe(3);
  } finally { session.destroy(); await wait(f.close()); }
});
boundedPickerTest("an h2 target the URL parser rejects is refused without upstream and the session stays usable", async wait => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests++; res.end("next stream succeeds"); });
  const session = openH2(f);
  try {
    const refused = await wait(h2Exchange(session, "//[").complete);
    expect(refused.status).toBe(400);
    expect(refused.body.length).toBe(0);
    expect(requests).toBe(0);
    const received = await wait(h2Exchange(session, "/next").complete);
    expect(received.status).toBe(200);
    expect(received.body.toString()).toBe("next stream succeeds");
    expect(f.logs).toEqual(["picker session h2", "picker request refused 400", "picker GET other 200"]);
  } finally { session.destroy(); await wait(f.close()); }
});
