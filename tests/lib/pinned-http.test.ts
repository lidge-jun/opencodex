import { createServer, type Server, type Socket } from "node:net";
import { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PinnedHttpError, pinnedHttpGet } from "../../src/lib/pinned-http";

let server: Server | undefined;
const sockets = new Set<Socket>();

function trackSocket(socket: Socket): void {
  sockets.add(socket);
  socket.on("error", () => { /* client timeout or cleanup can reset the peer */ });
  socket.on("close", () => sockets.delete(socket));
}

async function listen(handler: (socket: Socket) => void): Promise<number> {
  server = createServer((socket) => {
    trackSocket(socket);
    handler(socket);
  });
  return await new Promise<number>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function request(port: number, idleTimeoutMs: number, signal?: AbortSignal): Promise<Response> {
  return pinnedHttpGet(
    `http://slow-header.invalid:${port}/`,
    { address: "127.0.0.1", family: 4 },
    signal,
    { idleTimeoutMs },
  );
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

describe("pinned HTTP timeouts", () => {
  test("legacy idle timeout is also an absolute response-header deadline", async () => {
    const port = await listen((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nX-Slow: ");
      const drip = setInterval(() => socket.write("x"), 20);
      socket.on("close", () => clearInterval(drip));
    });

    const error = await request(port, 150).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PinnedHttpError);
    expect(error).toMatchObject({ code: "first_byte_timeout" });
  });

  test("legacy idleTimeoutMs zero still disables the header and socket timers", async () => {
    const port = await listen((socket) => {
      let bodyReply: ReturnType<typeof setTimeout> | undefined;
      const headersReply = setTimeout(() => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n");
        bodyReply = setTimeout(() => socket.end("ok"), 50);
      }, 50);
      socket.on("close", () => {
        clearTimeout(headersReply);
        if (bodyReply !== undefined) clearTimeout(bodyReply);
      });
    });

    const response = await request(port, 0);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("an abort between the initial check and listener installation is observed", async () => {
    const port = await listen(() => { /* hold the socket until cancellation */ });
    const reason = new Error("abort during listener installation");
    let aborted = false;
    const signal = {
      get aborted() { return aborted; },
      get reason() { return reason; },
      addEventListener() { aborted = true; },
      removeEventListener() { /* no-op test signal */ },
    } as unknown as AbortSignal;

    const error = await request(port, 100, signal).catch((caught: unknown) => caught);
    expect(error).toBe(reason);
  });
});

/** Count bytes actually emitted by the receiver, independently of the peer's write buffer. */
function observeBody() {
  let response: IncomingMessage | undefined;
  let emittedBytes = 0;
  const originalEmit = IncomingMessage.prototype.emit;
  const emit = spyOn(IncomingMessage.prototype, "emit").mockImplementation(function (
    this: IncomingMessage, event: string | symbol, ...args: unknown[]
  ) {
    if (event === "data" && Buffer.isBuffer(args[0])) {
      response = this;
      emittedBytes += args[0].byteLength;
    }
    return originalEmit.call(this, event, ...args);
  });
  return { response: () => response, emittedBytes: () => emittedBytes, restore: () => emit.mockRestore() };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

/** Respect TCP write backpressure; never queue the whole fixture in the sender. */
async function bodyPeer(body: Buffer, encoding?: string): Promise<number> {
  return listen(socket => {
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: " + body.byteLength
        + (encoding ? "\r\nContent-Encoding: " + encoding : "") + "\r\n\r\n");
      let offset = 0;
      const pump = () => {
        while (offset < body.byteLength && !socket.destroyed) {
          const chunk = body.subarray(offset, offset + 16 * 1024);
          offset += chunk.byteLength;
          if (!socket.write(chunk)) return;
        }
      };
      socket.on("drain", pump);
      pump();
    });
  });
}

describe("pinned HTTP response backpressure", () => {
  for (const encoding of [undefined, "gzip", "deflate"] as const) {
    test(`${encoding ?? "identity"} pauses unread body delivery and resumes exact bytes`, async () => {
      const payload = randomBytes(2 * 1024 * 1024);
      const wire = encoding === "gzip" ? gzipSync(payload) : encoding === "deflate" ? deflateSync(payload) : payload;
      const observation = observeBody();
      let response: Response | undefined;
      try {
        const port = await bodyPeer(wire, encoding);
        response = await pinnedHttpGet(
          `http://backpressure.invalid:${port}/`, { address: "127.0.0.1", family: 4 }, undefined,
          { firstByteTimeoutMs: 1_000, inactivityTimeoutMs: 40 },
        );
        await waitFor(() => observation.response()?.isPaused() === true);
        const heldBytes = observation.emittedBytes();
        expect(heldBytes).toBeGreaterThan(0);
        expect(heldBytes).toBeLessThan(wire.byteLength);
        expect(response.bodyUsed).toBe(false);
        // A full local queue must not be mistaken for an idle peer. Native socket/decoder
        // buffers are separate; this measures the exact bytes handed to the Web Stream.
        await Bun.sleep(120);
        expect(observation.emittedBytes()).toBe(heldBytes);
        expect(observation.response()?.destroyed).toBe(false);
        const reader = response.body!.getReader();
        try {
          const first = await reader.read();
          expect(first.done).toBe(false);
          // Read one chunk, then pause again before draining the remainder.
          await waitFor(() => observation.response()?.isPaused() === true);
          await Bun.sleep(10);
          const heldAgain = observation.emittedBytes();
          await Bun.sleep(120);
          expect(observation.emittedBytes()).toBe(heldAgain);
          const chunks = [first.value!];
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            chunks.push(next.value);
          }
          expect(Buffer.concat(chunks).equals(payload)).toBe(true);
        } finally {
          reader.releaseLock();
        }
        expect(observation.emittedBytes()).toBe(wire.byteLength);
      } finally {
        await response?.body?.cancel().catch(() => { /* already consumed */ });
        observation.restore();
      }
    });
  }

  test("a resumed pending read re-arms the body inactivity deadline", async () => {
    const observation = observeBody();
    let response: Response | undefined;
    try {
      const port = await listen(socket => {
        socket.once("data", () => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nprefix"));
      });
      response = await pinnedHttpGet(
        `http://backpressure.invalid:${port}/`, { address: "127.0.0.1", family: 4 }, undefined,
        { firstByteTimeoutMs: 1_000, inactivityTimeoutMs: 40 },
      );
      await waitFor(() => observation.response()?.isPaused() === true);
      await Bun.sleep(120);
      const reader = response.body!.getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("prefix");
        await expect(reader.read()).rejects.toMatchObject({ code: "inactivity_timeout" });
      } finally {
        reader.releaseLock();
      }
      await waitFor(() => sockets.size === 0);
    } finally {
      await response?.body?.cancel().catch(() => { /* already failed */ });
      observation.restore();
    }
  });

  for (const encoding of [undefined, "gzip"] as const) {
    test.each(["cancel", "abort", "reset"] as const)(`%s still releases a backpressured ${encoding ?? "identity"} response`, async action => {
      const observation = observeBody();
      const abort = new AbortController();
      let response: Response | undefined;
      let peer: Socket | undefined;
      try {
        const port = await listen(socket => {
          peer = socket;
          const prefix = encoding ? gzipSync(Buffer.alloc(256 * 1024, 0x62)).subarray(0, -8) : Buffer.from("prefix");
          socket.once("data", () => {
            socket.write("HTTP/1.1 200 OK\r\nContent-Length: " + (prefix.byteLength + 2)
              + (encoding ? "\r\nContent-Encoding: gzip" : "") + "\r\n\r\n");
            socket.write(prefix);
          });
        });
        response = await request(port, 0, abort.signal);
        await waitFor(() => observation.response()?.isPaused() === true);
        if (action === "cancel") {
          await response.body!.cancel("consumer stopped");
        } else {
          if (action === "abort") abort.abort(new Error("caller stopped"));
          else peer!.destroy();
          await expect(response.text()).rejects.toBeInstanceOf(Error);
        }
        await waitFor(() => peer?.destroyed === true);
        await waitFor(() => observation.response()?.destroyed === true);
      } finally {
        await response?.body?.cancel().catch(() => { /* already consumed or failed */ });
        observation.restore();
      }
    });
  }
});
