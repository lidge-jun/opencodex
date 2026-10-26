import { expect, test } from "bun:test";
import { Agent, createServer, request } from "node:https";
import { connect, constants, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createServer as createTlsServer } from "node:tls";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { startPickerListener, type PickerListenerOptions } from "../../src/claude/intercept/picker-listener";

async function fixture(handler: ((req: IncomingMessage, res: ServerResponse) => void) | "early-fin",
  options: Partial<PickerListenerOptions> = {}) {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, ["claude.ai"]);
  const earlyReplies: Array<{ requestComplete: boolean; flushed: boolean; receivedBodyBytes: number }> = [];
  const earlyHeaders = Promise.withResolvers<void>();
  // A wire-level origin sends the reply and FIN while continuing to drain input. Bun's HTTP
  // server also tears down unfinished requests; overriding destroySoon alone does not prevent
  // that reset racing ahead of the reply on Windows with a buffered upload.
  const upstream = handler === "early-fin" ? createTlsServer({ cert: leaf.certPem, key: leaf.keyPem, allowHalfOpen: true }, socket => {
    socket.on("error", () => socket.destroy());
    let headers = "";
    let replied = false;
    socket.on("data", chunk => {
      if (replied) return;
      headers += chunk.toString("latin1");
      const end = headers.indexOf("\r\n\r\n");
      if (end < 0) return;
      const early = headers.startsWith("POST /early ");
      const body = early ? "early" : "ordinary";
      const length = /\r\ncontent-length: (\d+)\r\n/i.exec(headers.slice(0, end + 2));
      const requestBody = headers.slice(end + 4);
      if (early) earlyHeaders.resolve();
      if (early && requestBody.length === 0) return;
      replied = true;
      const observation = { requestComplete: length ? requestBody.length >= Number(length[1])
        : requestBody.endsWith("0\r\n\r\n"), flushed: false, receivedBodyBytes: requestBody.length };
      if (early) earlyReplies.push(observation);
      socket.once("finish", () => { observation.flushed = true; });
      socket.end(`HTTP/1.1 ${early ? "413 Payload Too Large" : "200 OK"}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    });
  }) : createServer({ cert: leaf.certPem, key: leaf.keyPem }, handler);
  const sockets = new Set<Duplex>();
  for (const event of ["connection", "secureConnection"] as const) upstream.on(event, socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const logs: string[] = [];
  const relay = await startPickerListener({ leaf, models: () => [], ...options,
    upstream: { host: "127.0.0.1", port: address.port, servername: "claude.ai", ca: ca.certPem },
    log: line => logs.push(line),
  });
  const clients: Array<ClientHttp2Session | ClientRequest> = [];
  const h1Agent = new Agent({ keepAlive: true });
  const h2 = () => {
    const session = connect(`https://127.0.0.1:${relay.port}`, { ca: ca.certPem, servername: "claude.ai" });
    session.on("error", () => session.destroy()); clients.push(session); return session;
  };
  const h1 = (path: string, method = "GET", headers: Record<string, string> = {}, port = relay.port) => {
    const req = request({ host: "127.0.0.1", port, servername: "claude.ai", ca: ca.certPem,
      rejectUnauthorized: true, agent: h1Agent, path, method, headers: { Host: "claude.ai", ...headers } });
    clients.push(req); return req;
  };
  return { logs, h2, h1, relay, earlyReplies, earlyHeaders: earlyHeaders.promise, originPort: address.port,
    async close() {
      const closed = clients.map(client => client.destroyed ? Promise.resolve() : observeClose(client));
      await relay.close();
      await Promise.all(closed);
      for (const client of clients) client.destroy();
      h1Agent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    },
  };
}

function bounded(name: string, run: (wait: <T>(p: PromiseLike<T>) => Promise<T>) => Promise<void>) {
  test(name, async () => {
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => deadline.reject(new Error("picker upload test deadline")), 4_000);
    void deadline.promise.catch(() => {});
    const wait = <T>(p: PromiseLike<T>) => Promise.race([p, deadline.promise]);
    try { await wait(run(wait)); } finally { clearTimeout(timer); }
  }, 5_000);
}

function h2Result(stream: ClientHttp2Stream) {
  const result = Promise.withResolvers<{ status: number; text: string }>();
  let status = 0;
  const chunks: Buffer[] = [];
  stream.on("response", headers => { status = Number(headers[":status"]); });
  stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
  stream.once("end", () => result.resolve({ status, text: Buffer.concat(chunks).toString() }));
  stream.once("error", result.reject);
  void result.promise.catch(() => {});
  return result.promise;
}
function h1Result(req: ClientRequest) {
  const result = Promise.withResolvers<{ status: number; text: string }>();
  req.once("response", res => {
    const chunks: Buffer[] = [];
    res.on("data", chunk => chunks.push(Buffer.from(chunk)));
    res.once("end", () => result.resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() }));
    res.once("error", result.reject);
  });
  req.once("error", result.reject);
  void result.promise.catch(() => {});
  return result.promise;
}
function observeClose(stream: ClientRequest | ClientHttp2Stream | ClientHttp2Session) {
  const closed = Promise.withResolvers<void>();
  stream.once("close", () => closed.resolve());
  stream.on("error", () => stream.destroy());
  return closed.promise;
}
function observeSocketClose(req: ClientRequest) {
  const closed = Promise.withResolvers<void>();
  req.once("socket", socket => { socket.once("close", () => closed.resolve()); });
  req.on("error", () => req.destroy());
  return closed.promise;
}
function normalH2(session: ClientHttp2Session, path = "/ok") {
  const req = session.request({ ":method": "GET", ":path": path, ":authority": "claude.ai" });
  const result = h2Result(req); req.end(); return result;
}

for (const protocol of ["h1", "h2"] as const) {
  for (const status of [400, 503] as const) {
    for (const input of ["headers-only", "buffered"] as const) {
      bounded(`${protocol} ${status} refusal closes a ${input} upload without body completion`, async wait => {
        const held = Promise.withResolvers<void>();
        const left = Promise.withResolvers<void>();
        let relayed = 0;
        const f = await fixture((req, res) => {
          req.on("error", () => res.destroy()); req.resume();
          if (req.url === "/held") {
            req.once("close", () => left.resolve()); held.resolve();
          } else { relayed++; res.end("ordinary"); }
        }, { maxActiveUpstreams: 1 });
        try {
          const session = f.h2();
          let blocker: ClientHttp2Stream | undefined;
          let blockerClosed: Promise<void> | undefined;
          if (status === 503) {
            blocker = session.request({ ":method": "POST", ":path": "/held", ":authority": "claude.ai" });
            blockerClosed = observeClose(blocker); blocker.write("x"); await wait(held.promise);
          }
          const path = status === 400 ? "//[" : "/refused";
          const upload = protocol === "h2"
            ? session.request({ ":method": "POST", ":path": path, ":authority": "claude.ai" }, { endStream: false })
            : f.h1(path, "POST", { "Content-Length": String(32 * 1024 * 1024) });
          const result = protocol === "h2" ? h2Result(upload as ClientHttp2Stream) : h1Result(upload as ClientRequest);
          const closed = protocol === "h2" ? observeClose(upload) : observeSocketClose(upload as ClientRequest);
          let connection: string | undefined;
          if (protocol === "h1") {
            (upload as ClientRequest).once("response", res => { connection = res.headers.connection; });
            if (input === "headers-only") (upload as ClientRequest).flushHeaders();
          }
          if (input === "buffered") upload.write(Buffer.alloc(4 * 1024 * 1024, 0x61));
          expect(await wait(result)).toEqual({ status, text: "" });
          if (protocol === "h1") expect(connection).toBe("close");
          await wait(closed);
          if (protocol === "h2") expect((upload as ClientHttp2Stream).rstCode).toBe(constants.NGHTTP2_NO_ERROR);
          expect(relayed).toBe(0);
          if (blocker) {
            blocker.close(constants.NGHTTP2_CANCEL); await wait(blockerClosed!); await wait(left.promise);
          }
          expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
        } finally { await wait(f.close()); }
      });
    }
  }
}

bounded("h1 completed upload keeps the same connection alive after an upstream failure", async wait => {
  const body = "complete";
  let received = "";
  let complete = false;
  const f = await fixture((req, res) => {
    req.on("error", () => res.destroy());
    if (req.url === "/failed") {
      req.on("data", chunk => { received += chunk.toString(); });
      req.once("end", () => { complete = req.complete; req.socket.destroy(); });
    } else { req.resume(); res.end("ordinary"); }
  }, { maxActiveUpstreams: 1 });
  try {
    const upload = f.h1("/failed", "POST", { "Content-Length": String(body.length) });
    const firstSocket = Promise.withResolvers<Duplex>();
    upload.once("socket", firstSocket.resolve);
    let connection: string | undefined;
    upload.once("response", res => { connection = res.headers.connection; });
    const result = h1Result(upload); upload.end(body);
    expect(await wait(result)).toEqual({ status: 502, text: "" });
    expect(received).toBe(body);
    expect(complete).toBe(true);
    expect(connection).toBe("keep-alive");
    const next = f.h1("/next");
    const nextSocket = Promise.withResolvers<Duplex>();
    next.once("socket", nextSocket.resolve);
    const nextResult = h1Result(next); next.end();
    expect(await wait(nextResult)).toEqual({ status: 200, text: "ordinary" });
    expect(await wait(nextSocket.promise)).toBe(await wait(firstSocket.promise));
  } finally { await wait(f.close()); }
});

for (const protocol of ["h1", "h2"] as const) {
  bounded(`${protocol} completed upload preserves SSE while a sibling upload is cancelled`, async wait => {
    const events = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const upstreamClosed = Promise.withResolvers<void>();
    let sse: ServerResponse | undefined;
    const f = await fixture((req, res) => {
      req.on("error", () => res.destroy()); req.resume();
      if (req.url === "/events") req.once("end", () => {
        sse = res; res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: first\n\n"); events.resolve();
      });
      else if (req.url === "/held") {
        req.once("data", () => admitted.resolve());
        req.once("close", () => upstreamClosed.resolve());
      } else res.end("ordinary");
    }, { maxActiveUpstreams: 2 });
    try {
      const session = f.h2();
      const first = protocol === "h2"
        ? session.request({ ":method": "POST", ":path": "/events", ":authority": "claude.ai" })
        : f.h1("/events", "POST", { "Content-Length": "8" });
      const result = protocol === "h2" ? h2Result(first as ClientHttp2Stream) : h1Result(first as ClientRequest);
      first.end("complete"); await wait(events.promise);
      const second = session.request({ ":method": "POST", ":path": "/held", ":authority": "claude.ai" });
      const secondClosed = observeClose(second); second.write("x"); await wait(admitted.promise);
      expect(sse!.writableEnded).toBe(false);
      second.close(constants.NGHTTP2_CANCEL); await wait(secondClosed); await wait(upstreamClosed.promise);
      expect(second.rstCode).toBe(constants.NGHTTP2_CANCEL);
      expect(sse!.writableEnded).toBe(false);
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
      sse!.end("data: last\n\n");
      expect(await wait(result)).toEqual({ status: 200, text: "data: first\n\ndata: last\n\n" });
    } finally { await wait(f.close()); }
  });

  // "buffered" queues 4 MiB of an advertised 32 MiB body, so the generated 502 races input still in
  // flight (Bun 1.4.3 reset that reply through the splice before the client could read it).
  for (const input of protocol === "h1" ? ["small", "buffered"] as const : ["small"] as const)
  bounded(`${protocol} upstream failure delivers 502 and releases ${input === "buffered" ? "a buffered" : "an"} unfinished upload`, async wait => {
    const f = await fixture((req, res) => {
      req.on("error", () => res.destroy()); req.resume();
      if (req.url === "/failed") req.socket.destroy(); else res.end("ordinary");
    }, { maxActiveUpstreams: 1 });
    try {
      const session = f.h2();
      const upload = protocol === "h2"
        ? session.request({ ":method": "POST", ":path": "/failed", ":authority": "claude.ai" })
        : f.h1("/failed", "POST", { "Content-Length": input === "buffered" ? String(32 * 1024 * 1024) : "100" });
      const closed = protocol === "h2" ? observeClose(upload) : observeSocketClose(upload as ClientRequest);
      const result = protocol === "h2" ? h2Result(upload as ClientHttp2Stream) : h1Result(upload as ClientRequest);
      upload.write(input === "buffered" ? Buffer.alloc(4 * 1024 * 1024, 0x61) : "x");
      expect(await wait(result)).toEqual({ status: 502, text: "" }); await wait(closed);
      if (protocol === "h2") expect((upload as ClientHttp2Stream).rstCode).toBe(constants.NGHTTP2_NO_ERROR);
      const next = session.request({ ":method": "POST", ":path": "/next", ":authority": "claude.ai" });
      const nextResult = h2Result(next); next.end("complete");
      expect(await wait(nextResult)).toEqual({ status: 200, text: "ordinary" });
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
    } finally { await wait(f.close()); }
  });

  bounded(`${protocol} shutdown closes unfinished input and upstream`, async wait => {
    const arrived = Promise.withResolvers<void>();
    const upstreamClosed = Promise.withResolvers<void>();
    const f = await fixture((req, res) => {
      req.on("error", () => res.destroy()); req.resume();
      req.once("close", () => upstreamClosed.resolve()); arrived.resolve();
    });
    try {
      const upload = protocol === "h2"
        ? f.h2().request({ ":method": "POST", ":path": "/held", ":authority": "claude.ai" })
        : f.h1("/held", "POST", { "Content-Length": "100" });
      const closed = protocol === "h2" ? observeClose(upload) : observeSocketClose(upload as ClientRequest); upload.write("x"); await wait(arrived.promise);
      await wait(f.relay.close()); await wait(closed); await wait(upstreamClosed.promise);
    } finally { await wait(f.close()); }
  });
}

for (const protocol of ["h1", "h2"] as const) {
  bounded(`${protocol} backpressure preserves every byte of a large early reply`, async wait => {
    // Exceed the h2 receive window and the h1 socket buffers, including a non-text tail.
    const body = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const uploadBody = Buffer.alloc(4 * 1024 * 1024, 0x61);
    const sent = Promise.withResolvers<void>();
    let inputBytes = 0;
    const backpressured = Promise.withResolvers<void>();
    const f = await fixture((req, res) => {
      req.on("error", () => res.destroy()); req.resume();
      if (req.url === "/early-large") {
        // Consume the known prefix before replying, so the fixture itself has no queued input
        // when its HTTP/1.1 connection closes. The client's request body is still unfinished.
        req.on("data", chunk => {
          inputBytes += chunk.length;
          if (inputBytes !== uploadBody.length) return;
          res.writeHead(413, { "Content-Length": String(body.length) });
          expect(res.write(body)).toBe(false);
          expect(res.writableNeedDrain).toBe(true);
          backpressured.resolve();
          res.end(() => sent.resolve());
        });
      } else res.end("ordinary");
    });
    const buffered = Promise.withResolvers<{ response: IncomingMessage | ClientHttp2Stream; resume(): void }>();
    try {
      const session = f.h2();
      const upload = protocol === "h2"
        ? session.request({ ":method": "POST", ":path": "/early-large", ":authority": "claude.ai" })
        : f.h1("/early-large", "POST", { "Content-Length": String(32 * 1024 * 1024) });
      const closed = protocol === "h2" ? observeClose(upload) : observeSocketClose(upload as ClientRequest);
      const result = Promise.withResolvers<{ status: number; body: Buffer }>();
      void result.promise.catch(() => {});
      const collect = (response: IncomingMessage | ClientHttp2Stream, status: number) => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("end", () => result.resolve({ status, body: Buffer.concat(chunks) }));
        response.once("error", result.reject);
        response.pause();
        // Resume only when the paused reader has a full readable buffer, not after a delay.
        const onReadable = () => {
          if (response.readableLength < response.readableHighWaterMark) return;
          buffered.resolve({ response, resume() { response.off("readable", onReadable); response.resume(); } });
        };
        response.on("readable", onReadable);
        onReadable();
      };
      if (protocol === "h2") {
        const stream = upload as ClientHttp2Stream;
        stream.once("response", headers => collect(stream, Number(headers[":status"])));
      } else (upload as ClientRequest).once("response", res => collect(res, res.statusCode!));
      upload.once("error", result.reject);
      upload.write(uploadBody);
      await wait(backpressured.promise);
      const { response, resume } = await wait(buffered.promise);
      expect(response.readableLength).toBeGreaterThanOrEqual(response.readableHighWaterMark);
      if (protocol === "h1") expect((response as IncomingMessage).headers.connection).toBe("close");
      resume();
      const received = await wait(result.promise);
      await wait(sent.promise);
      expect(inputBytes).toBe(uploadBody.length);
      expect(received.status).toBe(413);
      expect(received.body.length).toBe(body.length);
      expect(received.body.equals(body)).toBe(true);
      await wait(closed);
      if (protocol === "h2") expect((upload as ClientHttp2Stream).rstCode).toBe(constants.NGHTTP2_NO_ERROR);
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
    } finally { await wait(f.close()); }
  });
}

bounded("h2 cancellation releases aggregate admission once without weakening the next admission", async wait => {
  const arrived = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const left = Promise.withResolvers<void>();
  let count = 0;
  const f = await fixture((req, res) => {
    req.on("error", () => res.destroy()); req.resume();
    if (req.url === "/first") req.once("close", () => left.resolve());
    arrived[count++]?.resolve();
  }, { maxActiveUpstreams: 1 });
  try {
    const session = f.h2();
    const first = session.request({ ":method": "POST", ":path": "/first", ":authority": "claude.ai" });
    const firstClosed = observeClose(first); first.write("x"); await wait(arrived[0]!.promise);
    first.close(constants.NGHTTP2_CANCEL); await wait(firstClosed); await wait(left.promise);
    const second = session.request({ ":method": "POST", ":path": "/second", ":authority": "claude.ai" });
    observeClose(second); second.write("x"); await wait(arrived[1]!.promise);
    const third = session.request({ ":method": "POST", ":path": "/third", ":authority": "claude.ai" });
    const result = h2Result(third); const thirdClosed = observeClose(third); third.write("x");
    expect((await wait(result)).status).toBe(503); await wait(thirdClosed);
    expect(count).toBe(2);
  } finally { await wait(f.close()); }
});

bounded("early-fin origin waits for the first body byte after separate headers", async wait => {
  const f = await fixture("early-fin");
  let upload: ClientRequest | undefined;
  try {
    // Address the actual TLS origin directly so flushHeaders guarantees a header-only event.
    upload = f.h1("/early", "POST", { "Content-Length": String(32 * 1024 * 1024) }, f.originPort);
    const result = h1Result(upload);
    const closed = observeSocketClose(upload);
    upload.flushHeaders();
    await wait(f.earlyHeaders);
    expect(f.earlyReplies).toEqual([]);
    upload.write("x");
    expect(await wait(result)).toEqual({ status: 413, text: "early" });
    await wait(closed);
    expect(f.earlyReplies).toEqual([{ requestComplete: false, flushed: true, receivedBodyBytes: 1 }]);
  } finally { upload?.destroy(); await wait(f.close()); }
});

for (const protocol of ["h1", "h2"] as const) {
  // "buffered" writes 4 MiB of an advertised 32 MiB body; the origin replies after input starts.
  for (const input of protocol === "h1" ? ["small", "buffered"] as const : ["small"] as const)
  bounded(`${protocol} early upstream response closes ${input === "buffered" ? "a buffered" : "an"} unfinished upload without losing the reply`, async wait => {
    const f = await fixture(input === "buffered" ? "early-fin" : (req, res) => {
      // Answer like a real origin that replies early: keep reading the body and close with a FIN.
      // Bun's own server would close this unfinished request with destroySoon(), a reset that
      // Windows delivers before the reply bytes, so the relay could never read what it should relay.
      req.on("error", () => res.destroy()); req.resume();
      const socket = req.socket;
      socket.destroySoon = () => { socket.end(); return socket; };
      if (req.url === "/early") { res.writeHead(413, { "Content-Length": "5" }); res.end("early"); }
      else res.end("ordinary");
    });
    try {
      const session = f.h2();
      const upload = protocol === "h2"
        ? session.request({ ":method": "POST", ":path": "/early", ":authority": "claude.ai" })
        : f.h1("/early", "POST", { "Content-Length": input === "buffered" ? String(32 * 1024 * 1024) : "100" });
      const result = protocol === "h2" ? h2Result(upload as ClientHttp2Stream) : h1Result(upload as ClientRequest);
      const closed = protocol === "h2" ? observeClose(upload) : observeSocketClose(upload as ClientRequest);
      upload.write(input === "buffered" ? Buffer.alloc(4 * 1024 * 1024, 0x61) : "x");
      expect(await wait(result)).toEqual({ status: 413, text: "early" });
      await wait(closed);
      if (input === "buffered") {
        expect(f.earlyReplies).toEqual([{ requestComplete: false, flushed: true, receivedBodyBytes: expect.any(Number) }]);
        expect(f.earlyReplies[0]!.receivedBodyBytes).toBeGreaterThan(0);
        expect(f.earlyReplies[0]!.receivedBodyBytes).toBeLessThan(32 * 1024 * 1024);
      }
      if (protocol === "h2") expect((upload as ClientHttp2Stream).rstCode).toBe(constants.NGHTTP2_NO_ERROR);
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
    } finally { await wait(f.close()); }
  });
}
