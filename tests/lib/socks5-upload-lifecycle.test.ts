import { describe, expect, test } from "bun:test";
import { Socket, createConnection, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { socks5Fetch } from "../../src/lib/socks5-fetch";

/**
 * The budget the transport arms for a response, mirrored from SOCKS5_RESPONSE_TIMEOUT_MS in
 * src/lib/socks5-fetch.ts, which keeps it module-private.
 *
 * Mirrored rather than exported: the value is what identifies the transport's own timer among the
 * several this exchange arms, and a test is not a reason to widen that module's surface. If the
 * budget changes there, the assertion below stops finding it and says so.
 */
const RESPONSE_TIMEOUT_MS = 200_000;

const openSockets = new WeakMap<object, Set<Socket>>();

async function listen(server: TcpServer): Promise<number> {
  const sockets = new Set<Socket>();
  openSockets.set(server, sockets);
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("error", () => { /* an abandoned upload resets its peer */ });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: TcpServer): Promise<void> {
  for (const socket of openSockets.get(server) ?? []) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/** A no-auth SOCKS5 peer that connects to the loopback port the request names and pipes both ways. */
function socksProxy(): TcpServer {
  return createTcpServer(socket => {
    let stage: "greeting" | "connect" = "greeting";
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (stage === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
          buffer = buffer.subarray(2 + buffer[1]!);
          socket.write(Buffer.from([0x05, 0x00]));
          stage = "connect";
          continue;
        }
        if (buffer.length < 7) return;
        const hostnameLength = buffer[4]!;
        const requestLength = 7 + hostnameLength;
        if (buffer.length < requestLength) return;
        const port = buffer.readUInt16BE(5 + hostnameLength);
        buffer = buffer.subarray(requestLength);
        const target = createConnection({ host: "127.0.0.1", port }, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 1]));
          socket.removeListener("data", onData);
          if (buffer.length > 0) socket.unshift(buffer);
          socket.pipe(target);
          target.pipe(socket);
        });
        target.once("error", error => socket.destroy(error));
        return;
      }
    };
    socket.on("data", onData);
    socket.once("error", () => { /* the proxy is torn down with its peers */ });
  });
}

/**
 * A request body that produces one chunk and then never produces another.
 *
 * This is the shape the transport could not settle: the caller's stream owns that pending read,
 * so destroying the socket does nothing to it. `pull` returns a promise that never settles, which
 * is how a stream legitimately says "not yet" without ending.
 */
function stallingBody(first: Uint8Array) {
  let markDelivered: () => void = () => { /* replaced below */ };
  let markCancelled: () => void = () => { /* replaced below */ };
  const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
  const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return new Promise<void>(() => { /* the body stalls here */ });
      sent = true;
      controller.enqueue(first);
      markDelivered();
      return undefined;
    },
    cancel() { markCancelled(); },
  });
  return { stream, delivered, cancelled };
}

/** True when the promise settles inside the deadline, without asserting anything about timing. */
async function settlesWithin(promise: Promise<unknown>, timeoutMs = 2_000): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true, () => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}

function post(port: number, proxyPort: number, body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const init = {
    method: "POST",
    body,
    duplex: "half",
    ...(signal ? { signal } : {}),
  } satisfies RequestInit & { duplex: "half" };
  return socks5Fetch(`http://provider.invalid:${port}/upload`, init, `socks5://127.0.0.1:${proxyPort}`);
}

/** A peer that completes the request head and then reports the first body byte it receives. */
function uploadObserver(): { server: TcpServer; uploading: Promise<void> } {
  let markUploading: () => void = () => { /* replaced below */ };
  const uploading = new Promise<void>(resolve => { markUploading = resolve; });
  const server = createTcpServer(socket => {
    socket.once("error", () => { /* the caller resets this peer on abort */ });
    let head = Buffer.alloc(0);
    let headComplete = false;
    socket.on("data", chunk => {
      if (headComplete) {
        markUploading();
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      headComplete = true;
      if (head.byteLength > end + 4) markUploading();
    });
    // Never answer: a fetch here can only settle through the abort path.
  });
  return { server, uploading };
}

// A peer may answer a request it has not finished receiving, and a request body may stall. The
// upload loop used to await the caller's body reader before looking at the socket at all, so
// those two facts together produced a fetch that never settled with the answer already buffered.
describe("SOCKS5 upload lifecycle", () => {
  test("an early final response resolves and stops the upload", async () => {
    const uploaded: Buffer[] = [];
    let answered = false;
    const target = createTcpServer(socket => {
      socket.once("error", () => { /* the client stops writing once it has its answer */ });
      let head = Buffer.alloc(0);
      socket.on("data", chunk => {
        if (answered) {
          uploaded.push(Buffer.from(chunk));
          return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        answered = true;
        const trailing = head.subarray(end + 4);
        if (trailing.byteLength > 0) uploaded.push(Buffer.from(trailing));
        socket.write("HTTP/1.1 413 Payload Too Large\r\nContent-Length: 5\r\nConnection: close\r\n\r\nlarge");
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    const body = stallingBody(new TextEncoder().encode("first chunk"));
    try {
      const pending = post(targetPort, proxyPort, body.stream);
      expect(await settlesWithin(pending)).toBe(true);
      const response = await pending;
      expect(response.status).toBe(413);
      expect(await response.text()).toBe("large");
      // The stalled body is released rather than left holding the caller's stream open.
      expect(await settlesWithin(body.cancelled)).toBe(true);
      // A terminating chunk after the answer would be read as the head of the next request.
      expect(Buffer.concat(uploaded).toString("latin1")).not.toContain("0\r\n\r\n");
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("a caller abort settles a fetch waiting on a body chunk that never arrives", async () => {
    // Abort is driven by the upstream actually receiving a body byte, not by the caller's
    // stream having produced one. A stream can be pulled before the tunnel is established, so
    // aborting on that signal would not prove the fetch was parked mid-upload.
    const { server: target, uploading } = uploadObserver();
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    const body = stallingBody(new TextEncoder().encode("first chunk"));
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    try {
      const pending = post(targetPort, proxyPort, body.stream, controller.signal);
      const outcome = pending.then(() => "resolved" as const, (error: unknown) => error);
      // The upload is now parked on a read the caller's stream will never fulfil.
      expect(await settlesWithin(uploading)).toBe(true);
      controller.abort(reason);
      expect(await settlesWithin(outcome)).toBe(true);
      expect(await outcome).toBe(reason);
      expect(await settlesWithin(body.cancelled)).toBe(true);
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  // `AbortSignal.reason` is whatever the caller passed, and several waiters inside this
  // transport can win the race that settles an abort. They disagree about a reason they consider
  // absent - one substitutes an Error for null, others coerce anything that is not an Error - so
  // without a single answer the same abort surfaces differently depending on scheduling.
  test.each([
    ["a string", "caller gave up"],
    ["null", null],
    ["a plain object", { cancelled: true }],
  ] as const)("an abort reason that is %s reaches the caller unchanged", async (_label, reason) => {
    const { server: target, uploading } = uploadObserver();
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    const body = stallingBody(new TextEncoder().encode("first chunk"));
    const controller = new AbortController();
    try {
      const pending = post(targetPort, proxyPort, body.stream, controller.signal);
      const outcome = pending.then(() => "resolved" as const, (error: unknown) => error);
      expect(await settlesWithin(uploading)).toBe(true);
      controller.abort(reason);
      expect(await settlesWithin(outcome)).toBe(true);
      expect(await outcome).toBe(reason);
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("a peer that disappears during a stalled body read settles rather than hanging", async () => {
    const target = createTcpServer(socket => {
      socket.once("error", () => { /* this peer leaves deliberately */ });
      let head = Buffer.alloc(0);
      socket.on("data", chunk => {
        head = Buffer.concat([head, chunk]);
        if (head.indexOf("\r\n\r\n") < 0) return;
        socket.destroy();
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    const body = stallingBody(new TextEncoder().encode("first chunk"));
    try {
      const pending = post(targetPort, proxyPort, body.stream);
      const outcome = pending.then(() => "resolved" as const, (error: unknown) => error);
      expect(await settlesWithin(outcome)).toBe(true);
      expect(await outcome).toBeInstanceOf(Error);
      expect(await settlesWithin(body.cancelled)).toBe(true);
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("an ordinary streamed POST still completes with its terminating chunk", async () => {
    let received = "";
    const target = createTcpServer(socket => {
      socket.once("error", () => { /* teardown may reset this peer */ });
      socket.on("data", chunk => {
        received += chunk.toString("latin1");
        if (!received.includes("0\r\n\r\n")) return;
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nposted");
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("hello "));
        controller.enqueue(encoder.encode("socks"));
        controller.close();
      },
    });
    try {
      const response = await post(targetPort, proxyPort, stream);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("posted");
      expect(received).toContain("hello ");
      expect(received).toContain("socks");
      expect(received).toContain("0\r\n\r\n");
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });
  test("interim informational answers are consumed and the upload runs to completion", async () => {
    /*
     * A peer may answer 100 and 103 before the request body is finished, and those are not the
     * answer. The transport consumes them and reads on for the real one while the upload keeps
     * going; one that treated the first head it saw as final would hand the caller an empty 100
     * and stop writing mid-body.
     *
     * The ordering is arranged rather than hoped for. The rest of the body is withheld until both
     * interim heads have arrived at this side of the tunnel and the reader has had a scheduling
     * turn to consume them, and the fetch is required to be unsettled at that moment. So
     * everything asserted afterwards about the remainder of the upload genuinely happened after
     * the transport had those answers in hand and had not mistaken either for the final one.
     */
    let received = "";
    let receivedWhenInformed: number | undefined;
    let markPeerClosed: () => void = () => { /* replaced below */ };
    const peerClosed = new Promise<void>(resolve => { markPeerClosed = resolve; });
    const target = createTcpServer(socket => {
      socket.once("error", () => { /* teardown may reset this peer */ });
      socket.once("close", () => markPeerClosed());
      socket.on("data", chunk => {
        received += chunk.toString("latin1");
        if (receivedWhenInformed === undefined && received.includes("\r\n\r\n")) {
          socket.write("HTTP/1.1 100 Continue\r\n\r\n");
          socket.write("HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\n");
          receivedWhenInformed = received.length;
        }
        if (!received.includes("0\r\n\r\n")) return;
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nposted");
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);

    // Both interim heads, seen arriving on this side of the tunnel rather than merely written by
    // the peer. The reader is already in flowing mode, so this listener observes the same chunks
    // it does and consumes nothing.
    let clientSeen = "";
    let markInterimAtClient: () => void = () => { /* replaced below */ };
    const interimAtClient = new Promise<void>(resolve => { markInterimAtClient = resolve; });
    const originalSetTimeout = Socket.prototype.setTimeout;
    let transportSocket: Socket | undefined;
    const observeInterim = (chunk: Buffer | string): void => {
      clientSeen += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      if (clientSeen.includes("HTTP/1.1 100 Continue\r\n\r\n")
        && clientSeen.includes("HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\n")) {
        markInterimAtClient();
      }
    };

    const encoder = new TextEncoder();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let settled = false;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(encoder.encode("hello "));
      },
      cancel() { cancelled = true; },
    });
    const abort = new AbortController();
    let outcome: Promise<void> | undefined;

    try {
      Socket.prototype.setTimeout = function patched(this: Socket, ms: number, callback?: () => void) {
        if (ms === RESPONSE_TIMEOUT_MS && transportSocket === undefined) {
          transportSocket = this;
          this.on("data", observeInterim);
        }
        return originalSetTimeout.call(this, ms, callback as never);
      } as typeof Socket.prototype.setTimeout;

      const pending = post(targetPort, proxyPort, stream, abort.signal);
      // Both handlers are attached before waiting for receipt; outcome never rejects.
      outcome = pending.then(() => { settled = true; }, () => { settled = true; });
      expect(await settlesWithin(interimAtClient)).toBe(true);
      // Complete client receipt followed by a native checkpoint drains the current parser's
      // buffered-header promise continuations before another body chunk becomes available.
      await new Promise<void>(resolve => { setImmediate(resolve); });
      expect(settled).toBe(false);
      expect(cancelled).toBe(false);
      expect(received).not.toContain("socks");
      expect(received).not.toContain("0\r\n\r\n");
      bodyController.enqueue(encoder.encode("socks"));
      bodyController.close();

      expect(await settlesWithin(outcome)).toBe(true);
      const response = await pending;

      /*
       * The final answer reaching the caller is the receipt that those heads were consumed rather
       * than merely delivered: 200 with its body can only be read by something that read past
       * both of them.
       */
      expect(response.status).toBe(200);
      const responseText = response.text();
      expect(await settlesWithin(responseText)).toBe(true);
      expect(await responseText).toBe("posted");

      // Upload continuity, measured against the moment the interim answers were sent rather than
      // against the whole exchange.
      expect(receivedWhenInformed).toBeDefined();
      const afterInterim = received.slice(receivedWhenInformed ?? 0);
      expect(received).toContain("hello ");
      expect(afterInterim).toContain("socks");
      expect(afterInterim).toContain("0\r\n\r\n");

      // The exchange ends by itself, before anything here tears a peer down.
      expect(await settlesWithin(peerClosed)).toBe(true);
    } finally {
      Socket.prototype.setTimeout = originalSetTimeout;
      transportSocket?.removeListener("data", observeInterim);
      try {
        abort.abort(new Error("informational fixture teardown"));
      } finally {
        await Promise.all([close(proxy), close(target)]);
        if (outcome) await settlesWithin(outcome);
      }
    }
  });

  test("the response timeout fires while a body read is pending and cleans up after itself", async () => {
    /*
     * The branch that matters here runs while the upload is parked on a chunk the caller will
     * never produce. Waiting out the real budget would make this a three-minute test, so the timer
     * is observed as the transport arms it and then fired deliberately once the peer has witnessed
     * the stall. What runs is the transport's own callback, not a substitute for it.
     */
    const { server: target, uploading } = uploadObserver();
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    const body = stallingBody(new TextEncoder().encode("first chunk"));
    const armed: number[] = [];
    let responseTimeoutSocket: Socket | undefined;
    let fireResponseTimeout: (() => void) | undefined;
    const originalSetTimeout = Socket.prototype.setTimeout;
    try {
      Socket.prototype.setTimeout = function patched(this: Socket, ms: number, callback?: () => void) {
        armed.push(ms);
        if (ms === RESPONSE_TIMEOUT_MS) {
          responseTimeoutSocket = this;
          fireResponseTimeout = callback;
        }
        return originalSetTimeout.call(this, ms, callback as never);
      } as typeof Socket.prototype.setTimeout;

      const pending = post(targetPort, proxyPort, body.stream);
      const outcome = pending.then(() => "resolved" as const, (error: unknown) => error);

      // Parked on a read the caller's stream will never fulfil, which is the state this timeout
      // exists for.
      expect(await settlesWithin(uploading)).toBe(true);
      expect(armed).toContain(RESPONSE_TIMEOUT_MS);
      expect(responseTimeoutSocket).toBeDefined();
      expect(fireResponseTimeout).toBeDefined();

      // The transport's own callback, invoked where its timer would have invoked it. Nothing here
      // substitutes for what it does.
      fireResponseTimeout?.();

      // Settlement: the caller is answered rather than left pending.
      expect(await settlesWithin(outcome)).toBe(true);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("timed out");
      // Reader cleanup: the caller's stream is released rather than held open by a dead exchange.
      expect(await settlesWithin(body.cancelled)).toBe(true);
      // Socket cleanup: the tunnel this exchange owned is gone.
      expect(responseTimeoutSocket?.destroyed).toBe(true);
    } finally {
      Socket.prototype.setTimeout = originalSetTimeout;
      await Promise.all([close(proxy), close(target)]);
    }
  });

});
