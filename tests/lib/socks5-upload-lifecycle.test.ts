import { describe, expect, test } from "bun:test";
import { createConnection, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { socks5Fetch } from "../../src/lib/socks5-fetch";

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
    // Abort is driven by the upstream actually receiving a body byte, not by the stream having
    // produced one. A caller's stream can be pulled before the tunnel is even established, so
    // aborting on that signal would not prove the fetch was waiting mid-upload.
    let markUploading: () => void = () => { /* replaced below */ };
    const uploading = new Promise<void>(resolve => { markUploading = resolve; });
    const target = createTcpServer(socket => {
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
      // Never answer: the fetch can only settle through the abort path.
    });
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
      expect(await settlesWithin(body.delivered)).toBe(true);
      controller.abort(reason);
      expect(await settlesWithin(outcome)).toBe(true);
      expect(await outcome).toBe(reason);
      expect(await settlesWithin(body.cancelled)).toBe(true);
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
});
