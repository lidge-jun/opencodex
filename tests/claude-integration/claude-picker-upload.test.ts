import { expect, test } from "bun:test";
import { createServer, request } from "node:https";
import { connect, constants, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { startPickerListener, type PickerListenerOptions } from "../../src/claude/intercept/picker-listener";

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void,
  limits: Partial<PickerListenerOptions> = {}) {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, ["claude.ai"]);
  const upstream = createServer({ cert: leaf.certPem, key: leaf.keyPem }, handler);
  const sockets = new Set<Duplex>();
  for (const event of ["connection", "secureConnection"] as const) upstream.on(event, socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const logs: string[] = [];
  const relay = await startPickerListener({ leaf, models: () => [], ...limits,
    upstream: { host: "127.0.0.1", port: address.port, servername: "claude.ai", ca: ca.certPem },
    log: line => logs.push(line),
  });
  const clients: Array<ClientHttp2Session | ClientRequest> = [];
  const h2 = () => {
    const session = connect(`https://127.0.0.1:${relay.port}`, { ca: ca.certPem, servername: "claude.ai" });
    session.on("error", () => session.destroy()); clients.push(session); return session;
  };
  const h1 = (path: string, method = "GET", headers: Record<string, string> = {}) => {
    const req = request({ host: "127.0.0.1", port: relay.port, servername: "claude.ai", ca: ca.certPem,
      rejectUnauthorized: true, agent: false, path, method, headers: { Host: "claude.ai", ...headers } });
    clients.push(req); return req;
  };
  return { logs, h2, h1, relay,
    async close() {
      const closed = clients.map(client => client.destroyed ? Promise.resolve() : observeClose(client));
      await relay.close();
      await Promise.all(closed);
      for (const client of clients) client.destroy();
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
function normalH2(session: ClientHttp2Session, path = "/ok") {
  const req = session.request({ ":method": "GET", ":path": path, ":authority": "claude.ai" });
  const result = h2Result(req); req.end(); return result;
}

for (const status of [400, 503] as const) {
  bounded(`h2 ${status} refusal closes a headers-only upload without DATA or END_STREAM`, async wait => {
    let relayed = 0;
    const f = await fixture((_req, res) => { relayed++; res.end("ordinary"); },
      { maxActiveUploads: status === 503 ? 0 : 1 });
    try {
      const session = f.h2();
      const upload = session.request({ ":method": "POST", ":path": status === 400 ? "//[" : "/refused",
        ":authority": "claude.ai" }, { endStream: false });
      const result = h2Result(upload);
      const closed = observeClose(upload);
      expect(await wait(result)).toEqual({ status, text: "" });
      await wait(closed);
      expect(relayed).toBe(0);
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
    } finally { await wait(f.close()); }
  });
}

for (const protocol of ["h1", "h2"] as const) {
  bounded(`${protocol} body completion reuses the upload slot while its SSE response remains open`, async wait => {
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
    }, { maxActiveUpstreams: 3, maxActiveUploads: 1, uploadIdleTimeoutMs: 80, uploadTimeoutMs: 160 });
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
      const third = session.request({ ":method": "POST", ":path": "/excess", ":authority": "claude.ai" }, { endStream: false });
      const thirdClosed = observeClose(third);
      expect((await wait(h2Result(third))).status).toBe(503); await wait(thirdClosed);
      second.close(constants.NGHTTP2_CANCEL); await wait(secondClosed); await wait(upstreamClosed.promise);
      await wait(new Promise(resolve => setTimeout(resolve, 200)));
      expect(sse!.writableEnded).toBe(false);
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
      sse!.end("data: last\n\n");
      expect(await wait(result)).toEqual({ status: 200, text: "data: first\n\ndata: last\n\n" });
      expect(f.logs.some(line => line.startsWith("picker upload expired"))).toBe(false);
    } finally { await wait(f.close()); }
  });

  bounded(`${protocol} upstream failure delivers 502 and releases an unfinished upload`, async wait => {
    const f = await fixture((req, res) => {
      req.on("error", () => res.destroy()); req.resume();
      if (req.url === "/failed") req.socket.destroy(); else res.end("ordinary");
    }, { maxActiveUploads: 1, uploadIdleTimeoutMs: 80, uploadTimeoutMs: 160 });
    try {
      const session = f.h2();
      const upload = protocol === "h2"
        ? session.request({ ":method": "POST", ":path": "/failed", ":authority": "claude.ai" })
        : f.h1("/failed", "POST", { "Content-Length": "100" });
      const closed = observeClose(upload);
      const result = protocol === "h2" ? h2Result(upload as ClientHttp2Stream) : h1Result(upload as ClientRequest);
      upload.write("x");
      expect(await wait(result)).toEqual({ status: 502, text: "" }); await wait(closed);
      const next = session.request({ ":method": "POST", ":path": "/next", ":authority": "claude.ai" });
      const nextResult = h2Result(next); next.end("complete");
      expect(await wait(nextResult)).toEqual({ status: 200, text: "ordinary" });
      await wait(new Promise(resolve => setTimeout(resolve, 200)));
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
      expect(f.logs.some(line => line.startsWith("picker upload expired"))).toBe(false);
    } finally { await wait(f.close()); }
  });

  bounded(`${protocol} shutdown closes unfinished input and upstream with no later expiry`, async wait => {
    const arrived = Promise.withResolvers<void>();
    const upstreamClosed = Promise.withResolvers<void>();
    const f = await fixture((req, res) => {
      req.on("error", () => res.destroy()); req.resume();
      req.once("close", () => upstreamClosed.resolve()); arrived.resolve();
    }, { uploadIdleTimeoutMs: 80, uploadTimeoutMs: 160 });
    try {
      const upload = protocol === "h2"
        ? f.h2().request({ ":method": "POST", ":path": "/held", ":authority": "claude.ai" })
        : f.h1("/held", "POST", { "Content-Length": "100" });
      const closed = observeClose(upload); upload.write("x"); await wait(arrived.promise);
      await wait(f.relay.close()); await wait(closed); await wait(upstreamClosed.promise);
      await wait(new Promise(resolve => setTimeout(resolve, 200)));
      expect(f.logs.some(line => line.startsWith("picker upload expired"))).toBe(false);
    } finally { await wait(f.close()); }
  });
}

for (const protocol of ["h1", "h2"] as const) {
  bounded(`${protocol} backpressure preserves every byte of a large early reply`, async wait => {
    // Exceed the h2 receive window and the h1 socket buffers, including a non-text tail.
    const body = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const sent = Promise.withResolvers<void>();
    const f = await fixture((req, res) => {
      req.on("error", () => res.destroy());
      if (req.url === "/early-large") {
        res.writeHead(413, { "Content-Length": String(body.length) });
        res.end(body, () => sent.resolve());
      } else res.end("ordinary");
    }, { maxActiveUploads: 1, uploadIdleTimeoutMs: 2_000, uploadTimeoutMs: 3_000 });
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = f.h2();
      const upload = protocol === "h2"
        ? session.request({ ":method": "POST", ":path": "/early-large", ":authority": "claude.ai" })
        : f.h1("/early-large", "POST", { "Content-Length": "100" });
      const closed = observeClose(upload);
      const result = Promise.withResolvers<{ status: number; body: Buffer }>();
      void result.promise.catch(() => {});
      const collect = (response: IncomingMessage | ClientHttp2Stream, status: number) => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("end", () => result.resolve({ status, body: Buffer.concat(chunks) }));
        response.once("error", result.reject);
        response.pause();
        resumeTimer = setTimeout(() => response.resume(), 150);
      };
      if (protocol === "h2") {
        const stream = upload as ClientHttp2Stream;
        stream.once("response", headers => collect(stream, Number(headers[":status"])));
      } else (upload as ClientRequest).once("response", res => collect(res, res.statusCode!));
      upload.once("error", result.reject);
      upload.write("x");
      const received = await wait(result.promise);
      await wait(sent.promise);
      expect(received.status).toBe(413);
      expect(received.body.length).toBe(body.length);
      expect(received.body.equals(body)).toBe(true);
      await wait(closed);
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
      expect(f.logs.some(line => line.startsWith("picker upload expired"))).toBe(false);
    } finally { clearTimeout(resumeTimer); await wait(f.close()); }
  });
}

bounded("h2 a stalled early reply retains upload deadlines and leaves sibling streams healthy", async wait => {
  const upstreamClosed = Promise.withResolvers<void>();
  const f = await fixture((req, res) => {
    req.on("error", () => res.destroy()); req.resume();
    if (req.url === "/early-stalled") {
      req.socket.once("close", () => upstreamClosed.resolve());
      res.writeHead(413, { "Content-Length": String(8 * 1024 * 1024) });
      res.end(Buffer.alloc(8 * 1024 * 1024, 1));
    } else res.end("ordinary");
  }, { maxActiveUploads: 1, uploadIdleTimeoutMs: 150, uploadTimeoutMs: 300 });
  try {
    const session = f.h2();
    const stream = session.request({ ":method": "POST", ":path": "/early-stalled", ":authority": "claude.ai" });
    const closed = observeClose(stream);
    stream.once("aborted", () => stream.resume()); stream.pause(); stream.write("x");
    await wait(closed); await wait(upstreamClosed.promise);
    expect(f.logs).toContain("picker upload expired idle");
    expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
    await wait(new Promise(resolve => setTimeout(resolve, 200)));
    expect(f.logs).not.toContain("picker upload expired deadline");
  } finally { await wait(f.close()); }
});

bounded("unfinished uploads across h2 sessions leave capacity for ordinary h1 and h2 requests", async wait => {
  let uploads = 0;
  const ready = Promise.withResolvers<void>();
  const f = await fixture((req, res) => {
    if (req.method === "POST") { req.resume(); if (++uploads === 2) ready.resolve(); }
    else res.end("ordinary");
  }, { maxActiveUpstreams: 4, maxActiveUploads: 2 });
  try {
    const sessions = [f.h2(), f.h2(), f.h2()];
    for (const session of sessions.slice(0, 2)) {
      const stream = session.request({ ":method": "POST", ":path": "/upload", ":authority": "claude.ai" });
      observeClose(stream); stream.write("x");
    }
    await wait(ready.promise);
    const excess = sessions[2]!.request({ ":method": "POST", ":path": "/excess", ":authority": "claude.ai" });
    const refusal = h2Result(excess);
    const closed = observeClose(excess);
    excess.write("x");
    expect((await wait(refusal)).status).toBe(503);
    await wait(closed);
    const excessH1 = f.h1("/excess", "POST", { "Content-Length": "100" });
    const h1Refusal = h1Result(excessH1); excessH1.write("x");
    expect((await wait(h1Refusal)).status).toBe(503);
    const get = f.h1("/ordinary"); const result = h1Result(get); get.end();
    expect(await wait(result)).toEqual({ status: 200, text: "ordinary" });
    expect(await wait(normalH2(sessions[0]!))).toEqual({ status: 200, text: "ordinary" });
    expect(uploads).toBe(2);
  } finally { await wait(f.close()); }
});

for (const protocol of ["h1", "h2"] as const) {
  bounded(`${protocol} idle upload expires, closes upstream, and restores capacity`, async wait => {
    const ready = Promise.withResolvers<void>();
    const upstreamClosed = Promise.withResolvers<void>();
    const f = await fixture((req, res) => {
      if (req.url === "/upload") {
        req.on("error", () => res.destroy()); req.resume();
        req.once("close", () => upstreamClosed.resolve()); ready.resolve();
      } else res.end("ordinary");
    }, { maxActiveUpstreams: 2, maxActiveUploads: 1, uploadIdleTimeoutMs: 100, uploadTimeoutMs: 2_000 });
    try {
      const session = f.h2();
      const upload = protocol === "h2"
        ? session.request({ ":method": "POST", ":path": "/upload", ":authority": "claude.ai" })
        : f.h1("/upload", "POST", { "Content-Length": "100" });
      const closed = observeClose(upload); upload.write("x");
      await wait(ready.promise); await wait(closed); await wait(upstreamClosed.promise);
      expect(f.logs).toContain("picker upload expired idle");
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
    } finally { await wait(f.close()); }
  });

  bounded(`${protocol} completed upload does not time out a long-lived response`, async wait => {
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const f = await fixture((req, res) => {
      req.resume(); req.once("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: first\n\n");
        finishTimer = setTimeout(() => res.end("data: last\n\n"), 300);
      });
    }, { uploadIdleTimeoutMs: 80, uploadTimeoutMs: 160 });
    try {
      if (protocol === "h2") {
        const stream = f.h2().request({ ":method": "POST", ":path": "/events", ":authority": "claude.ai" });
        const result = h2Result(stream); stream.end("complete");
        expect(await wait(result)).toEqual({ status: 200, text: "data: first\n\ndata: last\n\n" });
      } else {
        const req = f.h1("/events", "POST", { "Content-Length": "8" });
        const result = h1Result(req); req.end("complete");
        expect(await wait(result)).toEqual({ status: 200, text: "data: first\n\ndata: last\n\n" });
      }
      expect(f.logs.some(line => line.startsWith("picker upload expired"))).toBe(false);
    } finally { clearTimeout(finishTimer); await wait(f.close()); }
  });
}

bounded("h2 trickle progress cannot extend the absolute upload deadline", async wait => {
  const ready = Promise.withResolvers<void>();
  let chunks = 0;
  const f = await fixture((req, res) => {
    req.on("error", () => res.destroy());
    req.on("data", () => { chunks++; ready.resolve(); });
  }, { uploadIdleTimeoutMs: 200, uploadTimeoutMs: 450 });
  let tick: ReturnType<typeof setInterval> | undefined;
  try {
    const stream = f.h2().request({ ":method": "POST", ":path": "/upload", ":authority": "claude.ai" });
    const closed = observeClose(stream); stream.write("x");
    await wait(ready.promise);
    tick = setInterval(() => { if (!stream.closed && !stream.destroyed) stream.write("x"); }, 25);
    await wait(closed);
    expect(chunks).toBeGreaterThan(2);
    expect(f.logs).toContain("picker upload expired deadline");
    expect(f.logs).not.toContain("picker upload expired idle");
  } finally { clearInterval(tick); await wait(f.close()); }
});

bounded("h2 cancellation frees the upload slot once without weakening the next admission", async wait => {
  const arrived = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const left = Promise.withResolvers<void>();
  let count = 0;
  const f = await fixture((req, res) => {
    req.on("error", () => res.destroy()); req.resume();
    if (req.url === "/first") req.once("close", () => left.resolve());
    arrived[count++]?.resolve();
  }, { maxActiveUpstreams: 4, maxActiveUploads: 1 });
  try {
    const session = f.h2();
    const first = session.request({ ":method": "POST", ":path": "/first", ":authority": "claude.ai" });
    const firstClosed = observeClose(first); first.write("x"); await wait(arrived[0]!.promise);
    first.close(constants.NGHTTP2_CANCEL); await wait(firstClosed); await wait(left.promise);
    const second = session.request({ ":method": "POST", ":path": "/second", ":authority": "claude.ai" });
    observeClose(second); second.write("x"); await wait(arrived[1]!.promise);
    const third = session.request({ ":method": "POST", ":path": "/third", ":authority": "claude.ai" });
    const result = h2Result(third); third.write("x");
    expect((await wait(result)).status).toBe(503);
    expect(count).toBe(2);
  } finally { await wait(f.close()); }
});

bounded("an h2 body-bearing GET with no DATA still has an upload deadline", async wait => {
  const f = await fixture((req, res) => { req.on("error", () => res.destroy()); req.resume(); },
    { uploadIdleTimeoutMs: 100, uploadTimeoutMs: 2_000 });
  try {
    const stream = f.h2().request({ ":method": "GET", ":path": "/held", ":authority": "claude.ai" }, { endStream: false });
    await wait(observeClose(stream));
    expect(f.logs).toContain("picker upload expired idle");
  } finally { await wait(f.close()); }
});

for (const protocol of ["h1", "h2"] as const) {
  bounded(`${protocol} early upstream response closes an unfinished upload without losing the reply`, async wait => {
    const f = await fixture((req, res) => {
      req.on("error", () => res.destroy());
      if (req.url === "/early") { res.writeHead(413, { "Content-Length": "5" }); res.end("early"); }
      else res.end("ordinary");
    }, { maxActiveUploads: 1, uploadIdleTimeoutMs: 2_000 });
    try {
      const session = f.h2();
      const upload = protocol === "h2"
        ? session.request({ ":method": "POST", ":path": "/early", ":authority": "claude.ai" })
        : f.h1("/early", "POST", { "Content-Length": "100" });
      const result = protocol === "h2" ? h2Result(upload as ClientHttp2Stream) : h1Result(upload as ClientRequest);
      const closed = observeClose(upload); upload.write("x");
      expect(await wait(result)).toEqual({ status: 413, text: "early" });
      await wait(closed);
      expect(await wait(normalH2(session))).toEqual({ status: 200, text: "ordinary" });
      expect(f.logs.some(line => line.startsWith("picker upload expired"))).toBe(false);
    } finally { await wait(f.close()); }
  });
}
