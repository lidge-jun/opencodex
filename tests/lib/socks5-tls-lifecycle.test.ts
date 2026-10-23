import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { createUploadWaiter } from "../../src/lib/socks5-upload-waiter";
import { socks5Fetch } from "../../src/lib/socks5-fetch";

const CONNECT_TIMEOUT_MS = 30_000;
type Failure = "deadline" | "abort" | "null-abort" | "close" | "invalid-tls";

/** SOCKS accepts CONNECT, then observes real TLS bytes without contacting an upstream. */
async function checkHandshakeFailure(failure: Failure): Promise<void> {
  const sockets = new Set<Socket>();
  let markTlsSeen: () => void = () => {};
  let markPeerClosed: () => void = () => {};
  const tlsSeen = new Promise<void>(resolve => { markTlsSeen = resolve; });
  const peerClosed = new Promise<void>(resolve => { markPeerClosed = resolve; });
  let peer: Socket | undefined;
  const server = createServer(socket => {
    peer = socket;
    sockets.add(socket);
    socket.once("error", () => { /* fixture teardown may reset the connection */ });
    socket.once("close", () => { sockets.delete(socket); markPeerClosed(); });
    let stage: "greeting" | "connect" | "tls" = "greeting";
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        buffer = buffer.subarray(2 + buffer[1]!);
        socket.write(Buffer.from([5, 0]));
        stage = "connect";
      }
      if (stage === "connect") {
        if (buffer.length < 5 || buffer.length < 7 + buffer[4]!) return;
        buffer = buffer.subarray(7 + buffer[4]!);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        stage = "tls";
      }
      if (stage === "tls" && buffer.length > 0) {
        markTlsSeen();
        buffer = Buffer.alloc(0);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>();
  let deadlinesArmed = 0;
  // Capture, but do not shorten, the transport deadline. Fire it only after the
  // fixture actually receives ClientHello, so machine load cannot race TCP setup.
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = originalSetTimeout(callback, ms, ...args);
    if (ms === CONNECT_TIMEOUT_MS) {
      deadlinesArmed++;
      deadlines.set(handle, () => callback(...args));
    }
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout> | undefined) => {
    if (handle !== undefined) deadlines.delete(handle);
    return originalClearTimeout(handle);
  }) as typeof clearTimeout;

  const controller = new AbortController();
  const reason = failure === "null-abort" ? null : new Error("fixture caller cancellation");
  const watchdog = originalSetTimeout(() => controller.abort(new Error("fixture watchdog")), 2_000);
  let outcome: Promise<unknown> | undefined;
  try {
    const port = (server.address() as AddressInfo).port;
    outcome = socks5Fetch("https://destination.invalid/", { signal: controller.signal }, `socks5://127.0.0.1:${port}`)
      .then(() => new Error("unexpected TLS success"), (error: unknown) => error);
    // Receipt is bounded by the same request outcome: a failure before ClientHello
    // must fail this assertion instead of leaving the test waiting indefinitely.
    const ready = await Promise.race([tlsSeen.then(() => true), outcome.then(() => false)]);
    assert.equal(ready, true, "the peer must receive ClientHello before exercising TLS failure");
    // Bun also implements a socket inactivity timer through global setTimeout.
    // Its already-cleared internal timer must not make the transport test Node-only.
    assert.ok(deadlinesArmed >= 2, "TCP and TLS deadlines must both be observed");
    assert.equal(deadlines.size, 1, "only the TLS deadline remains active");

    if (failure === "deadline") deadlines.values().next().value!();
    else if (failure === "abort" || failure === "null-abort") controller.abort(reason);
    else if (failure === "close") peer!.destroy();
    else peer!.write("fixture invalid TLS");

    const result = await outcome;
    if (failure === "abort" || failure === "null-abort") assert.equal(result, reason);
    else {
      assert.ok(result instanceof Error);
      if (failure === "deadline") assert.match(result.message, /SOCKS5 TLS handshake timed out/);
      else if (failure === "close") assert.match(result.message, /TLS handshake|disconnected before secure TLS/);
      else assert.match(result.message, /ssl|wrong version|packet|tls/i);
    }
    assert.equal(deadlines.size, 0, "terminal failure clears the owned deadline");
    let closeWatchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([peerClosed, new Promise<never>((_, reject) => {
        closeWatchdog = originalSetTimeout(() => reject(new Error("TLS peer remained open")), 2_000);
      })]);
    } finally { originalClearTimeout(closeWatchdog); }
  } finally {
    controller.abort();
    await outcome;
    originalClearTimeout(watchdog);
    for (const handle of deadlines.keys()) originalClearTimeout(handle);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("SOCKS5 TLS handshake lifecycle", () => {
  test("a stalled TLS handshake reaches an absolute deadline and releases its socket", () => checkHandshakeFailure("deadline"));
  test("caller cancellation preserves its reason and clears the TLS deadline", () => checkHandshakeFailure("abort"));
  test("a null cancellation reason is preserved", () => checkHandshakeFailure("null-abort"));
  test("premature peer close releases the TLS deadline", () => checkHandshakeFailure("close"));
  test("TLS protocol failure releases the TLS deadline", () => checkHandshakeFailure("invalid-tls"));
});

describe("SOCKS5 upload wait lifetime", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  test("serial waits attach only one response observer", async () => {
    const head = deferred<void>();
    const originalThen = head.promise.then.bind(head.promise);
    let observers = 0;
    head.promise.then = ((...args: Parameters<typeof head.promise.then>) => {
      observers++;
      return originalThen(...args);
    }) as typeof head.promise.then;
    const waiter = createUploadWaiter(head.promise, new AbortController().signal);
    try {
      for (let index = 0; index < 256; index++) {
        assert.equal(await waiter.wait(() => Promise.resolve(index)), index);
      }
      assert.equal(observers, 1);
    } finally {
      waiter.dispose();
      head.resolve();
    }
  });

  test("pending waits preserve null, false, object and Error abort reasons", async () => {
    for (const reason of [null, false, { cancelled: true }, new Error("synthetic cancellation")]) {
      const head = deferred<void>();
      const controller = new AbortController();
      const waiter = createUploadWaiter(head.promise, controller.signal);
      try {
        const pending = waiter.wait(() => new Promise<never>(() => {}));
        const outcome = pending.then(() => assert.fail("unexpected success"), error => error);
        controller.abort(reason);
        assert.equal(await outcome, reason);
      } finally {
        waiter.dispose();
        head.resolve();
      }
    }
  });

  test("both head outcomes interrupt a wait and observe its late rejection", async () => {
    for (const failed of [false, true]) {
      const head = deferred<void>();
      const operation = deferred<void>();
      const waiter = createUploadWaiter(head.promise, new AbortController().signal);
      try {
        const pending = waiter.wait(() => operation.promise);
        if (failed) head.reject(new Error("synthetic head failure"));
        else head.resolve();
        assert.deepEqual(await pending, { kind: "answered" });
        operation.reject(new Error("late read failure"));
        await Promise.resolve();
      } finally {
        waiter.dispose();
      }
    }
  });

  test("an observed interruption does not start another operation", async () => {
    const controller = new AbortController();
    controller.abort(null);
    const head = deferred<void>();
    const waiter = createUploadWaiter(head.promise, controller.signal);
    let calls = 0;
    try {
      const result = await waiter.wait(async () => { calls++; }).then(
        () => assert.fail("unexpected success"), error => error,
      );
      assert.equal(result, null);
      assert.equal(calls, 0);
    } finally {
      waiter.dispose();
      head.resolve();
    }
  });

  test("operation failures settle without poisoning the next serial wait", async () => {
    const head = deferred<void>();
    const waiter = createUploadWaiter(head.promise, new AbortController().signal);
    const reason = new Error("synthetic operation failure");
    try {
      await assert.rejects(waiter.wait(() => Promise.reject(reason)), error => error === reason);
      await assert.rejects(waiter.wait(() => { throw reason; }), error => error === reason);
      assert.equal(await waiter.wait(async () => 7), 7);
    } finally {
      waiter.dispose();
      head.resolve();
    }
  });

  test("the real upload path does not repeatedly race shared pending promises", async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      let stage: "greeting" | "connect" | "http" = "greeting";
      let bytes = Buffer.alloc(0);
      socket.on("data", chunk => {
        bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
        if (stage === "greeting") {
          if (bytes.length < 2 || bytes.length < 2 + bytes[1]!) return;
          bytes = bytes.subarray(2 + bytes[1]!);
          socket.write(Buffer.from([5, 0]));
          stage = "connect";
        }
        if (stage === "connect") {
          if (bytes.length < 5 || bytes.length < 7 + bytes[4]!) return;
          bytes = bytes.subarray(7 + bytes[4]!);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = "http";
        }
        if (stage === "http" && bytes.toString("latin1").endsWith("0\r\n\r\n")) {
          socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const originalRace = Promise.race;
    const uses = new Map<unknown, number>();
    Promise.race = ((values: Iterable<unknown>) => {
      const list = [...values];
      for (const value of list) uses.set(value, (uses.get(value) ?? 0) + 1);
      return originalRace.call(Promise, list);
    }) as typeof Promise.race;
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(new Error("upload fixture watchdog")), 2_000);
    let produced = 0;
    try {
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          if (produced++ < 256) stream.enqueue(new Uint8Array([120]));
          else stream.close();
        },
      });
      const init = { method: "POST", body, duplex: "half", signal: controller.signal } satisfies RequestInit & { duplex: "half" };
      const port = (server.address() as AddressInfo).port;
      const response = await socks5Fetch("http://destination.invalid/upload", init, `socks5://127.0.0.1:${port}`);
      assert.equal(await response.text(), "ok");
      assert.equal(produced, 257);
      const mostReused = Math.max(0, ...uses.values());
      assert.ok(mostReused <= 2, `shared promise accumulated ${mostReused} upload races`);
    } finally {
      Promise.race = originalRace;
      clearTimeout(watchdog);
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
