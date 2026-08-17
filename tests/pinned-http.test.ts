import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import { PinnedHttpError, pinnedHttpGet } from "../src/lib/pinned-http";

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
