import { describe, expect, test } from "bun:test";
import { connect as bunConnect, type Socket } from "bun";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { connect as connectNet, type Socket as NetSocket } from "node:net";
import { connect as connectTls } from "node:tls";
import { startChatgptUnblockEntryProxy } from "../../src/chatgpt/desktop-unblock/entry-proxy";
import { ChatgptUnblockDiagnostics, startChatgptUnblockListener } from "../../src/chatgpt/desktop-unblock/listener";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";

/**
 * The entry proxy is the PAC fallback's first hop: it must splice a CONNECT tunnel onto the
 * TLS origin listener so the app's request reaches the relay byte-for-byte, and refuse
 * everything else so it never becomes a general forward proxy.
 */

const ca = createLocalInterceptCa();
const leaf = issueLocalInterceptLeaf(ca, ["chatgpt.com"]);

interface ReadState { chunks: Buffer[]; waiters: ((data: Buffer | null) => void)[]; done: boolean }
const readers = new WeakMap<object, ReadState>();

/** A raw client socket whose received bytes can be awaited incrementally. */
async function dial(port: number, tls: { ca: string; servername: string } | null = null): Promise<Socket> {
  const socket = await bunConnect<ReadState>({
    hostname: "127.0.0.1",
    port,
    ...(tls ? { tls: { ca: tls.ca, servername: tls.servername } } : {}),
    data: { chunks: [], waiters: [], done: false },
    socket: {
      data(_s, chunk) {
        const state = _s.data;
        state.chunks.push(Buffer.from(chunk));
        const waiting = state.waiters.shift();
        if (waiting) waiting(Buffer.from(chunk));
      },
      close(_s) {
        const state = _s.data;
        state.done = true;
        for (const waiter of state.waiters.splice(0)) waiter(null);
      },
      error() { /* close follows */ },
    },
  });
  readers.set(socket, socket.data);
  return socket;
}

async function received(socket: Socket, atLeast: number): Promise<Buffer> {
  const state = readers.get(socket)!;
  const total = () => state.chunks.reduce((sum, c) => sum + c.length, 0);
  while (total() < atLeast && !state.done) {
    await new Promise<Buffer | null>(resolve => state.waiters.push(resolve));
  }
  return Buffer.concat(state.chunks);
}

describe("chatgpt unblock entry proxy", () => {
  test("a wrong-host CONNECT is refused with 403", async () => {
    const diagnostics = new ChatgptUnblockDiagnostics();
    const origin = startChatgptUnblockListener({ leaf, diagnostics });
    const entry = await startChatgptUnblockEntryProxy({ originPort: origin.port! });
    try {
      const client = await dial(entry.port);
      client.write(`CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n`);
      const head = await received(client, "HTTP/1.1 403".length);
      expect(head.toString("latin1")).toContain("HTTP/1.1 403 Forbidden");
    } finally {
      await entry.stop();
      await origin.stop(true);
    }
  });

  test("a plain GET (no CONNECT) is refused", async () => {
    const diagnostics = new ChatgptUnblockDiagnostics();
    const origin = startChatgptUnblockListener({ leaf, diagnostics });
    const entry = await startChatgptUnblockEntryProxy({ originPort: origin.port! });
    try {
      const client = await dial(entry.port);
      client.write(`GET http://chatgpt.com/ HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n`);
      const head = await received(client, "HTTP/1.1 403".length);
      expect(head.toString("latin1")).toContain("403");
    } finally {
      await entry.stop();
      await origin.stop(true);
    }
  });

  test("a dead origin answers 502 instead of hanging the client", async () => {
    // Port 1 on loopback: nothing listens there.
    const entry = await startChatgptUnblockEntryProxy({ originPort: 1 });
    try {
      const client = await dial(entry.port);
      client.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n`);
      const head = await received(client, "HTTP/1.1 502".length);
      expect(head.toString("latin1")).toContain("502");
    } finally {
      await entry.stop();
    }
  });
});

/** Read one HTTP head off a raw socket, leaving the socket ready for a TLS upgrade. */
function readHead(socket: NetSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.removeListener("data", onData);
      socket.removeListener("error", reject);
      socket.pause();
      resolve(buffer.subarray(0, end).toString("latin1"));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

/** Split a raw HTTP/1.1 response into head and (de-chunked) body. */
function httpResponse(raw: Buffer): { head: string; body: Buffer } {
  const end = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, end).toString("latin1");
  let rest = raw.subarray(end + 4);
  if (!/^transfer-encoding:[ \t]*chunked/im.test(head)) return { head, body: rest };
  const parts: Buffer[] = [];
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.subarray(0, lineEnd).toString("latin1"), 16);
    if (!size) break;
    parts.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size));
    rest = rest.subarray(lineEnd + 2 + size + 2);
  }
  return { head, body: Buffer.concat(parts) };
}

/** CONNECT through the entry, then run one HTTPS request over the tunnel the way Chromium does. */
async function requestThroughTunnel(entryPort: number, path: string, options: { pauseMs?: number; idleMs?: number } = {}) {
  const raw = connectNet({ host: "127.0.0.1", port: entryPort });
  await once(raw, "connect");
  raw.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n");
  const established = await readHead(raw);
  if (options.idleMs) await Bun.sleep(options.idleMs);
  const tls = connectTls({ socket: raw, servername: "chatgpt.com", ca: ca.certPem });
  await once(tls, "secureConnect");
  tls.write(`GET ${path} HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n`);
  const chunks: Buffer[] = [];
  let paused = false;
  const done = new Promise<void>((resolve, reject) => {
    tls.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (options.pauseMs && !paused) {
        // A slow app-side reader: the tunnel's socket buffers fill while this side is paused.
        paused = true;
        tls.pause();
        setTimeout(() => tls.resume(), options.pauseMs);
      }
    });
    tls.once("end", resolve);
    tls.once("error", reject);
  });
  await done;
  tls.destroy();
  return { established, ...httpResponse(Buffer.concat(chunks)) };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("chatgpt unblock entry proxy tunnel", () => {
  test("a multi-MiB TLS response reaches a slow reader byte for byte", async () => {
    const payload = Buffer.alloc(8 * 1024 * 1024);
    for (let offset = 0; offset < payload.length; offset += 4) payload.writeUInt32LE(offset, offset);
    const origin = startChatgptUnblockListener({
      leaf,
      diagnostics: new ChatgptUnblockDiagnostics(),
      fetchImpl: (async () => new Response(payload, { headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch,
    });
    const entry = await startChatgptUnblockEntryProxy({ originPort: origin.port! });
    try {
      const response = await requestThroughTunnel(entry.port, "/backend-api/files/blob", { pauseMs: 500 });
      expect(response.established).toStartWith("HTTP/1.1 200");
      expect(response.head).toStartWith("HTTP/1.1 200");
      expect(response.body.length).toBe(payload.length);
      expect(sha256(response.body)).toBe(sha256(payload));
    } finally {
      await entry.stop();
      await origin.stop(true);
    }
  }, 30_000);

  test("a live tunnel outlasts the request-head deadline", async () => {
    const origin = startChatgptUnblockListener({
      leaf,
      diagnostics: new ChatgptUnblockDiagnostics(),
      fetchImpl: (async () => new Response("still here")) as unknown as typeof fetch,
    });
    const entry = await startChatgptUnblockEntryProxy({ originPort: origin.port!, headTimeoutSeconds: 1 });
    try {
      // Bun fires socket deadlines on a ~4 s tick, so idle well past it before using the tunnel.
      const response = await requestThroughTunnel(entry.port, "/backend-api/me", { idleMs: 6_000 });
      expect(response.body.toString()).toBe("still here");
    } finally {
      await entry.stop();
      await origin.stop(true);
    }
  }, 20_000);

  test("a client that never finishes its head is closed at the deadline", async () => {
    const entry = await startChatgptUnblockEntryProxy({ originPort: 1, headTimeoutSeconds: 1 });
    try {
      const raw = connectNet({ host: "127.0.0.1", port: entry.port });
      await once(raw, "connect");
      raw.write("CONNECT chatgpt.com:443 HTTP/1.1\r\n");
      const started = Date.now();
      await once(raw, "close");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await entry.stop();
    }
  }, 20_000);

  test("payload sent right behind the CONNECT head is tunnelled, never answered as a second CONNECT", async () => {
    const diagnostics = new ChatgptUnblockDiagnostics();
    const origin = startChatgptUnblockListener({ leaf, diagnostics });
    const entry = await startChatgptUnblockEntryProxy({ originPort: origin.port! });
    try {
      const client = await dial(entry.port);
      client.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n");
      client.write("\x16\x03\x01\x00\x05hello\r\n\r\n");
      client.write("CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n");
      const reply = (await received(client, "HTTP/1.1 200".length)).toString("latin1");
      await Bun.sleep(100);
      const all = Buffer.concat(readers.get(client)!.chunks).toString("latin1");
      expect(reply).toStartWith("HTTP/1.1 200");
      expect(all.split("HTTP/1.1 200").length - 1).toBe(1);
      client.end();
    } finally {
      await entry.stop();
      await origin.stop(true);
    }
  });
});
