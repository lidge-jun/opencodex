import { describe, expect, test } from "bun:test";
import { createConnection, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { gzipSync, deflateSync } from "node:zlib";
import { PinnedHttpError, pinnedHttpGet } from "../../src/lib/pinned-http";
import { socks5Fetch } from "../../src/lib/socks5-fetch";

const openSockets = new WeakMap<object, Set<Socket>>();

async function listen(server: TcpServer): Promise<number> {
  const sockets = new Set<Socket>();
  openSockets.set(server, sockets);
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("error", () => { /* a refused coding resets its peer */ });
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

/** A peer that answers one coded body and records the request head it was asked with. */
function codedTarget(coding: string, payload: Uint8Array) {
  let requestText = "";
  const server = createTcpServer(socket => {
    socket.once("error", () => { /* the caller may reset this peer */ });
    let request = Buffer.alloc(0);
    socket.on("data", chunk => {
      request = Buffer.concat([request, chunk]);
      requestText = request.toString("latin1");
      if (!requestText.includes("\r\n\r\n")) return;
      const head = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-encoding: "
        + coding
        + "\r\ncontent-length: " + payload.byteLength + "\r\n\r\n";
      socket.write(Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(payload)]));
    });
  });
  return { server, requestHead: () => requestText };
}

function pinnedGet(port: number, path: string, options?: { maxBytes?: number; headers?: HeadersInit }): Promise<Response> {
  return pinnedHttpGet(
    `http://provider.invalid:${port}${path}`,
    { address: "127.0.0.1", family: 4 },
    undefined,
    { idleTimeoutMs: 5_000, context: "provider response", ...options },
  );
}

// The pinned direct helper and the SOCKS tunnel are chosen by the same provider outbound
// decision, so a body that is readable on one route and compressed on the other makes the
// provider's behavior depend on the operator's egress configuration. These pin the parity.
describe("pinned direct content coding", () => {
  test("a gzip body is decoded and stops advertising a coding it no longer carries", async () => {
    const body = JSON.stringify({ ok: true, note: "compressed" });
    const { server: target } = codedTarget("gzip", gzipSync(Buffer.from(body, "utf8")));
    const port = await listen(target);
    try {
      const response = await pinnedGet(port, "/gzip");
      expect(response.headers.get("content-encoding")).toBeNull();
      // The declared length counted the coded bytes; keeping it would misdescribe the body.
      expect(response.headers.get("content-length")).toBeNull();
      expect(await response.json()).toEqual({ ok: true, note: "compressed" });
    } finally {
      await close(target);
    }
  });

  test("a deflate body is decoded the same way", async () => {
    // HTTP `deflate` is the zlib container, not raw DEFLATE, and that is what
    // `DecompressionStream("deflate")` reads.
    const { server: target } = codedTarget("deflate", deflateSync(Buffer.from(JSON.stringify({ ok: true }), "utf8")));
    const port = await listen(target);
    try {
      const response = await pinnedGet(port, "/deflate");
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await close(target);
    }
  });

  test("both raw transports produce the same logical JSON for the same coded payload", async () => {
    const body = JSON.stringify({ route: "parity", values: [1, 2, 3] });
    const direct = codedTarget("gzip", gzipSync(Buffer.from(body, "utf8")));
    const tunneled = codedTarget("gzip", gzipSync(Buffer.from(body, "utf8")));
    const proxy = socksProxy();
    const [directPort, tunneledPort, proxyPort] = await Promise.all([
      listen(direct.server),
      listen(tunneled.server),
      listen(proxy),
    ]);
    try {
      const pinned = await pinnedGet(directPort, "/parity");
      const tunneledResponse = await socks5Fetch(
        `http://provider.invalid:${tunneledPort}/parity`,
        undefined,
        `socks5://127.0.0.1:${proxyPort}`,
      );
      expect(await pinned.json()).toEqual(JSON.parse(body));
      expect(await tunneledResponse.json()).toEqual(JSON.parse(body));
    } finally {
      await Promise.all([close(proxy), close(direct.server), close(tunneled.server)]);
    }
  });

  test("a coding this transport cannot undo is refused by name before the body is handed over", async () => {
    // Brotli is not a format `DecompressionStream` implements. Returning the bytes anyway is the
    // behavior being removed: the caller would get a SyntaxError from its own parser with
    // nothing naming the cause.
    const { server: target } = codedTarget("br", new TextEncoder().encode("not really brotli"));
    const port = await listen(target);
    try {
      const error = await pinnedGet(port, "/brotli").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PinnedHttpError);
      expect(error).toMatchObject({ code: "unsupported_content_encoding" });
      expect(String(error)).toContain("unsupported content-encoding: br");
    } finally {
      await close(target);
    }
  });

  test("a corrupt coded body fails with a named decode error rather than a bare stream failure", async () => {
    const { server: target } = codedTarget("gzip", new TextEncoder().encode("this is not gzip at all"));
    const port = await listen(target);
    try {
      const response = await pinnedGet(port, "/corrupt");
      const error = await response.text().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PinnedHttpError);
      expect(error).toMatchObject({ code: "content_decode_failed" });
    } finally {
      await close(target);
    }
  });

  test("maxBytes bounds the decoded body, not only the bytes that arrived", async () => {
    // The coded payload is tiny and the decoded one is not: a ceiling applied only to the socket
    // would admit a body far larger than the caller agreed to hold.
    const expanded = Buffer.alloc(64 * 1024, 0x61);
    const { server: target } = codedTarget("gzip", gzipSync(expanded));
    const port = await listen(target);
    try {
      const response = await pinnedGet(port, "/expanded", { maxBytes: 1024 });
      const error = await response.text().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PinnedHttpError);
      expect(error).toMatchObject({ code: "output_byte_limit" });
    } finally {
      await close(target);
    }
  });

  test("the request asks for identity by default and keeps an explicit caller preference", async () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ ok: true }), "utf8"));
    const bare = codedTarget("identity", new TextEncoder().encode("{}"));
    // A preference list that mentions a coding this transport cannot undo is not a reason to
    // refuse the response: what matters is the coding the peer actually chose.
    const chosen = codedTarget("gzip", payload);
    const [barePort, chosenPort] = await Promise.all([listen(bare.server), listen(chosen.server)]);
    try {
      await pinnedGet(barePort, "/default");
      expect(bare.requestHead().toLowerCase()).toContain("accept-encoding: identity");
      const response = await pinnedGet(chosenPort, "/explicit", { headers: { "accept-encoding": "gzip, br" } });
      expect(chosen.requestHead().toLowerCase()).toContain("accept-encoding: gzip, br");
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await Promise.all([close(bare.server), close(chosen.server)]);
    }
  });
});
