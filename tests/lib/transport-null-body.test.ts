import { describe, expect, test } from "bun:test";
import { createConnection, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { pinnedHttpGet } from "../../src/lib/pinned-http";
import { socks5Fetch } from "../../src/lib/socks5-fetch";

const openSockets = new WeakMap<object, Set<Socket>>();

async function listen(server: TcpServer): Promise<number> {
  const sockets = new Set<Socket>();
  openSockets.set(server, sockets);
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("error", () => { /* a destroyed transport resets its peer */ });
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
 * A peer that answers one fixed raw response head and then keeps the connection open.
 *
 * Keep-alive is the point of the fixture rather than an incidental detail: a transport that
 * streams a null-body status settles only when the peer closes, so a peer that never closes is
 * what separates "resolved with no body" from "resolved because the connection went away".
 */
function replyingTarget(reply: string, capture?: (socket: Socket) => void): TcpServer {
  return createTcpServer(socket => {
    capture?.(socket);
    socket.once("error", () => { /* the caller may reset this peer */ });
    let request = Buffer.alloc(0);
    socket.on("data", chunk => {
      request = Buffer.concat([request, chunk]);
      if (!request.toString("latin1").includes("\r\n\r\n")) return;
      socket.write(reply);
    });
  });
}

/**
 * Wait for a socket to be observably destroyed, under a bounded deadline.
 *
 * The contract is that the transport releases the connection, not that it does so inside any
 * particular window, so this waits for the state the contract promises and fails only when it
 * never arrives. A fixed sleep would assert something about machine load instead.
 */
async function awaitDestroyed(socket: Socket | undefined, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (socket?.destroyed !== true && Date.now() < deadline) await Bun.sleep(5);
  return socket?.destroyed === true;
}

function pinnedGet(port: number, path: string): Promise<Response> {
  return pinnedHttpGet(
    `http://provider.invalid:${port}${path}`,
    { address: "127.0.0.1", family: 4 },
    undefined,
    // Bounded so a transport that waits for a body that is never coming fails as a timeout
    // rather than hanging the suite for the sixty-second default.
    { idleTimeoutMs: 5_000 },
  );
}

describe("null-body statuses on the raw outbound transports", () => {
  test("the pinned transport answers 204 with a null body while the peer holds the connection", async () => {
    const target = replyingTarget("HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n");
    const port = await listen(target);
    try {
      const response = await pinnedGet(port, "/no-content");
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    } finally {
      await close(target);
    }
  });

  test("the pinned transport answers 205 without decoding or refusing its representation headers", async () => {
    // A 205 may still describe the representation it would have sent. There are no coded bytes
    // to undo, so the coding is neither applied nor treated as an unreadable response.
    const target = replyingTarget(
      "HTTP/1.1 205 Reset Content\r\nContent-Encoding: br\r\nConnection: keep-alive\r\n\r\n",
    );
    const port = await listen(target);
    try {
      const response = await pinnedGet(port, "/reset");
      expect(response.status).toBe(205);
      expect(response.body).toBeNull();
      expect(response.headers.get("content-encoding")).toBe("br");
    } finally {
      await close(target);
    }
  });

  test("an ordinary pinned 200 still streams its body", async () => {
    const target = replyingTarget(
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
    );
    const port = await listen(target);
    try {
      const response = await pinnedGet(port, "/ok");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await close(target);
    }
  });

  test("the SOCKS transport answers 205 with no body and releases the tunnel", async () => {
    let targetConnection: Socket | undefined;
    const target = replyingTarget(
      "HTTP/1.1 205 Reset Content\r\nConnection: keep-alive\r\n\r\n",
      socket => { targetConnection = socket; },
    );
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    try {
      const response = await socks5Fetch(
        `http://provider.invalid:${targetPort}/reset`,
        undefined,
        `socks5://127.0.0.1:${proxyPort}`,
      );
      expect(response.status).toBe(205);
      expect(response.body).toBeNull();
      // The peer asked to keep the connection alive, so an observed close is the transport
      // releasing it rather than the fixture tearing it down.
      expect(await awaitDestroyed(targetConnection)).toBe(true);
    } finally {
      targetConnection?.destroy();
      await Promise.all([close(proxy), close(target)]);
    }
  });
  test("the SOCKS transport answers HEAD with no body even when the peer advertises one", async () => {
    let targetConnection: Socket | undefined;
    /*
     * A HEAD answer carries the headers the GET would have carried, including the length of a
     * body it will never send. Reading that many bytes would park the transport on a body that is
     * not coming, with the answer already in hand.
     */
    const target = replyingTarget(
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 128\r\nConnection: keep-alive\r\n\r\n",
      socket => { targetConnection = socket; },
    );
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    try {
      const response = await socks5Fetch(
        "http://provider.invalid:" + targetPort + "/head",
        { method: "HEAD" },
        "socks5://127.0.0.1:" + proxyPort,
      );
      expect(response.status).toBe(200);
      expect(response.body).toBeNull();
      // The advertised length survives: it describes the representation, and a caller reading
      // these headers is entitled to it.
      expect(response.headers.get("content-length")).toBe("128");
      // The peer asked to keep the connection alive, so an observed close is the transport
      // releasing it rather than the fixture tearing it down.
      expect(await awaitDestroyed(targetConnection)).toBe(true);
    } finally {
      targetConnection?.destroy();
      await Promise.all([close(proxy), close(target)]);
    }
  });

});
