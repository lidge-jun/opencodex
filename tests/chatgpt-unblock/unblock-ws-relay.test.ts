import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer as createNetServer, connect as connectNet } from "node:net";
import type { AddressInfo, Server as NetServer } from "node:net";
import { connect as connectTls, createServer as createTlsServer } from "node:tls";
import type { Server as TlsServer, TLSSocket } from "node:tls";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { startChatgptUnblockListener } from "../../src/chatgpt/desktop-unblock/listener";
import { isRelayableUpgrade, readResponseHead, sendableCloseCode } from "../../src/chatgpt/desktop-unblock/ws-relay";
import { encodeWsFrame, parseWsFrames, WEBSOCKET_GUID, WsOpcode } from "../../src/chatgpt/desktop-unblock/ws-frame";
import type { DialUpstreamOptions } from "../../src/chatgpt/desktop-unblock/ws-upstream";

const ca = createLocalInterceptCa();
const leaf = issueLocalInterceptLeaf(ca, ["chatgpt.com"]);

/** One unmasked server frame; `b0` carries FIN and the opcode. */
function serverFrame(b0: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  return Buffer.concat([Buffer.from([b0, body.length]), body]);
}

interface UpstreamLog {
  heads: string[];
  pongs: string[];
  closes: { code: number; reason: string }[];
}

/**
 * Scripted chatgpt.com stand-in speaking raw RFC 6455, so the test can send what a real
 * server sends but Bun's server API cannot: fragments, interleaved pings, early frames.
 */
function startFakeUpstream(): { server: TlsServer; log: UpstreamLog; port: () => number } {
  const log: UpstreamLog = { heads: [], pongs: [], closes: [] };
  const server = createTlsServer({ cert: leaf.certPem, key: leaf.keyPem }, socket => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("latin1");
        buffer = Buffer.alloc(0);
        log.heads.push(head);
        if (head.startsWith("GET /refuse")) {
          socket.end("HTTP/1.1 403 Forbidden\r\ncf-ray: test-ray\r\ncontent-encoding: gzip\r\ncontent-length: 0\r\n\r\n");
          return;
        }
        upgraded = true;
        const key = /^sec-websocket-key: *([^\r\n]+)/im.exec(head)![1]!.trim();
        const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
        const offered = /^sec-websocket-protocol: *([^\r\n]+)/im.exec(head)?.[1]?.split(",").map(p => p.trim()) ?? [];
        const chosen = offered.at(-1);
        // The 101 and the first frame share one write: the relay must replay the early bytes.
        socket.write(Buffer.concat([
          Buffer.from(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + `Sec-WebSocket-Accept: ${accept}\r\n${chosen ? `Sec-WebSocket-Protocol: ${chosen}\r\n` : ""}\r\n`,
          ),
          serverFrame(0x81, "hello-early"),
        ]));
        return;
      }
      const parsed = parseWsFrames(chunk, buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.opcode === WsOpcode.PONG) log.pongs.push(frame.payload.toString());
        else if (frame.opcode === WsOpcode.CLOSE) {
          log.closes.push({ code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString() });
          socket.end(serverFrame(0x88, frame.payload));
        } else if (frame.opcode === WsOpcode.BINARY) socket.write(serverFrame(0x82, frame.payload));
        else if (frame.opcode === WsOpcode.TEXT) {
          const text = frame.payload.toString();
          if (text === "frag") {
            // Binary message in three fragments with a ping between them (legal per RFC 6455 §5.4).
            socket.write(Buffer.concat([
              serverFrame(0x02, "ab"),
              serverFrame(0x89, "hb"),
              serverFrame(0x00, "cd"),
              serverFrame(0x80, "ef"),
            ]));
          } else if (text === "close") {
            const payload = Buffer.concat([Buffer.from([0x0f, 0xa1]), Buffer.from("bye")]);
            socket.end(serverFrame(0x88, payload));
          } else if (text === "bigfrag") {
            // A message whose fragment payloads pass the 16 MiB byte ceiling (chunk count stays small).
            // FIN is cleared on both fragments, so the relay must buffer rather than flush.
            const piece = Buffer.alloc(12 * 1024 * 1024, 0x61);
            const unfin = (frame: Buffer): Buffer => { const copy = Buffer.from(frame); copy[0]! &= 0x7f; return copy; };
            socket.write(Buffer.concat([
              unfin(encodeWsFrame(WsOpcode.BINARY, piece, false)),
              unfin(encodeWsFrame(WsOpcode.CONTINUATION, piece, false)),
            ]));
          } else socket.write(serverFrame(0x81, `up:${text}`));
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  return { server, log, port: () => (server.address() as AddressInfo).port };
}

/** HTTP CONNECT proxy that sends every tunnel to the fake upstream, recording the request line. */
function startConnectProxy(upstreamPort: () => number): { server: NetServer; requests: string[]; heads: string[] } {
  const requests: string[] = [];
  const heads: string[] = [];
  const server = createNetServer(client => {
    let buffer = Buffer.alloc(0);
    client.on("error", () => {});
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.removeListener("data", onData);
      heads.push(buffer.subarray(0, end).toString());
      requests.push(buffer.subarray(0, buffer.indexOf("\r\n")).toString());
      const upstream = connectNet(upstreamPort(), "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  return { server, requests, heads };
}

/** TLS-speaking CONNECT proxy: the client must wrap the proxy port before its CONNECT. */
function startTlsConnectProxy(upstreamPort: () => number): { server: TlsServer; requests: string[] } {
  const requests: string[] = [];
  // A leaf for 127.0.0.1 (IP SAN), so the client's TLS wrap of the proxy port validates.
  const proxyLeaf = issueLocalInterceptLeaf(ca, ["127.0.0.1"]);
  const server = createTlsServer({ ca: [ca.certPem], cert: proxyLeaf.certPem, key: proxyLeaf.keyPem }, client => {
    let buffer = Buffer.alloc(0);
    client.on("error", () => {});
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.removeListener("data", onData);
      requests.push(buffer.subarray(0, buffer.indexOf("\r\n")).toString());
      const upstream = connectNet(upstreamPort(), "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  return { server, requests };
}

/** No-auth SOCKS5 proxy that sends every CONNECT to the fake upstream, recording the target. */
function startSocks5Proxy(upstreamPort: () => number): { server: NetServer; targets: string[] } {
  const targets: string[] = [];
  const server = createNetServer(client => {
    let buffer = Buffer.alloc(0);
    let greeted = false;
    client.on("error", () => {});
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!greeted) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        buffer = buffer.subarray(2 + buffer[1]!);
        greeted = true;
        client.write(Buffer.from([0x05, 0x00]));
      }
      if (buffer.length < 5) return;
      const hostLength = buffer[4]!;
      if (buffer.length < 5 + hostLength + 2) return;
      client.removeListener("data", onData);
      const host = buffer.subarray(5, 5 + hostLength).toString();
      targets.push(`${host}:${buffer.readUInt16BE(5 + hostLength)}`);
      const upstream = connectNet(upstreamPort(), "127.0.0.1", () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  return { server, targets };
}

/** A WebSocket client standing in for the desktop app, with an awaitable message queue. */
async function openApp(port: number, path: string): Promise<{
  ws: WebSocket;
  next: () => Promise<string | Uint8Array>;
  closed: Promise<{ code: number; reason: string }>;
}> {
  const ws = new WebSocket(`wss://127.0.0.1:${port}${path}`, {
    protocols: ["realtime-v1", "realtime-v2"],
    headers: { Cookie: "session=abc123", Origin: "https://chatgpt.com" },
    tls: { rejectUnauthorized: false },
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const queue: (string | Uint8Array)[] = [];
  const waiters: ((message: string | Uint8Array) => void)[] = [];
  ws.onmessage = event => {
    const message = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  };
  const closed = new Promise<{ code: number; reason: string }>(resolve => {
    ws.onclose = event => resolve({ code: event.code, reason: event.reason });
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("app websocket failed to open"));
  });
  const next = () => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string | Uint8Array>(resolve => waiters.push(resolve));
  };
  return { ws, next, closed };
}

/** Send a bare upgrade over raw TLS and return the listener's response head. */
function rawUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = connectTls({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: chatgpt.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.destroy();
      resolve(buffer.slice(0, end));
    });
    socket.on("error", reject);
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

function listenerFor(wsUpstream: DialUpstreamOptions) {
  return startChatgptUnblockListener({ leaf, wsUpstream: { ca: ca.certPem, connectTimeoutMs: 2000, ...wsUpstream } });
}

describe("chatgpt unblock websocket relay", () => {
  const upstream = startFakeUpstream();
  const direct = () => ({ proxy: null, target: { host: "127.0.0.1", port: upstream.port() } });
  const cleanups: (() => void)[] = [];

  beforeAll(async () => {
    await waitFor(() => upstream.server.listening, "fake upstream");
  });

  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
    upstream.server.close();
  });

  test("relays an upgrade end to end: handshake, early frames, text, binary, fragments, pings, upstream close", async () => {
    const listener = listenerFor(direct());
    cleanups.push(() => listener.stop(true));
    const app = await openApp(listener.port!, "/dictation/stream?x=1");

    // Upstream picked the last offered subprotocol; the app must see that choice.
    expect(app.ws.protocol).toBe("realtime-v2");
    const head = upstream.log.heads.at(-1)!;
    expect(head.split("\r\n")[0]).toBe("GET /dictation/stream?x=1 HTTP/1.1");
    expect(head).toMatch(/^host: chatgpt\.com$/im);
    expect(head).toMatch(/^cookie: session=abc123$/im);
    expect(head).toMatch(/^origin: https:\/\/chatgpt\.com$/im);
    expect(head).toMatch(/^sec-websocket-protocol: realtime-v1, realtime-v2$/im);
    expect(head).toMatch(/^sec-websocket-version: 13$/im);
    // The relay cannot inflate, so the app's permessage-deflate offer must not reach upstream.
    expect(head).not.toMatch(/sec-websocket-extensions/i);

    expect(await app.next()).toBe("hello-early");

    app.ws.send("hi");
    expect(await app.next()).toBe("up:hi");

    // Binary stays binary and arrives byte-exact.
    app.ws.send(new Uint8Array([1, 2, 3, 250]));
    expect(Array.from(await app.next() as Uint8Array)).toEqual([1, 2, 3, 250]);

    app.ws.send("frag");
    expect(Buffer.from(await app.next() as Uint8Array).toString()).toBe("abcdef");
    await waitFor(() => upstream.log.pongs.includes("hb"), "pong for the interleaved ping");

    app.ws.send("close");
    expect(await app.closed).toEqual({ code: 4001, reason: "bye" });
  });

  test("forwards the app's close to upstream with its code and reason", async () => {
    const listener = listenerFor(direct());
    cleanups.push(() => listener.stop(true));
    const app = await openApp(listener.port!, "/dictation/stream");
    expect(await app.next()).toBe("hello-early");
    const before = upstream.log.closes.length;
    app.ws.close(4000, "cya");
    await waitFor(() => upstream.log.closes.length > before, "upstream close frame");
    expect(upstream.log.closes.at(-1)).toEqual({ code: 4000, reason: "cya" });
  });

  test("a refused upstream upgrade reaches the app as the upstream's status", async () => {
    const listener = listenerFor(direct());
    cleanups.push(() => listener.stop(true));
    const head = await rawUpgrade(listener.port!, "/refuse");
    expect(head.split("\r\n")[0]).toMatch(/^HTTP\/1\.1 403/);
    expect(head).toMatch(/^cf-ray: test-ray$/im);
    // The relay replaces the body, so the upstream's encoding must not describe it.
    expect(head).not.toMatch(/content-encoding/i);
  });

  test("an unreachable upstream fails the upgrade with 502", async () => {
    const closed = createNetServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    const listener = listenerFor({ proxy: null, target: { host: "127.0.0.1", port: deadPort } });
    cleanups.push(() => listener.stop(true));
    const head = await rawUpgrade(listener.port!, "/dictation/stream");
    expect(head.split("\r\n")[0]).toMatch(/^HTTP\/1\.1 502/);
  });

  test("dials chatgpt.com through an HTTP CONNECT proxy", async () => {
    const proxy = startConnectProxy(upstream.port);
    cleanups.push(() => proxy.server.close());
    await waitFor(() => proxy.server.listening, "connect proxy");
    const listener = listenerFor({ proxy: `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}` });
    cleanups.push(() => listener.stop(true));
    const app = await openApp(listener.port!, "/dictation/stream");
    expect(await app.next()).toBe("hello-early");
    app.ws.send("via-connect");
    expect(await app.next()).toBe("up:via-connect");
    expect(proxy.requests).toEqual(["CONNECT chatgpt.com:443 HTTP/1.1"]);
    app.ws.close();
  });

  test("sends Proxy-Authorization when the CONNECT proxy URL carries credentials", async () => {
    const proxy = startConnectProxy(upstream.port);
    cleanups.push(() => proxy.server.close());
    await waitFor(() => proxy.server.listening, "authed connect proxy");
    const listener = listenerFor({ proxy: `http://user:p%40ss@127.0.0.1:${(proxy.server.address() as AddressInfo).port}` });
    cleanups.push(() => listener.stop(true));
    const app = await openApp(listener.port!, "/dictation/stream");
    expect(await app.next()).toBe("hello-early");
    app.ws.send("via-auth");
    expect(await app.next()).toBe("up:via-auth");
    expect(proxy.heads[0]).toContain("Proxy-Authorization: Basic " + Buffer.from("user:p@ss").toString("base64"));
    app.ws.close();
  });

  test("TLS-wraps an https:// proxy before the CONNECT handshake", async () => {
    const proxy = startTlsConnectProxy(upstream.port);
    cleanups.push(() => proxy.server.close());
    await waitFor(() => proxy.server.listening, "tls connect proxy");
    const listener = listenerFor({ proxy: `https://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`, ca: `${ca.certPem}` });
    cleanups.push(() => listener.stop(true));
    const app = await openApp(listener.port!, "/dictation/stream");
    expect(await app.next()).toBe("hello-early");
    app.ws.send("via-tls");
    expect(await app.next()).toBe("up:via-tls");
    expect(proxy.requests).toEqual(["CONNECT chatgpt.com:443 HTTP/1.1"]);
    app.ws.close();
  });

  test("dials chatgpt.com through a SOCKS5 proxy", async () => {
    const proxy = startSocks5Proxy(upstream.port);
    cleanups.push(() => proxy.server.close());
    await waitFor(() => proxy.server.listening, "socks5 proxy");
    const listener = listenerFor({ proxy: `socks5://127.0.0.1:${(proxy.server.address() as AddressInfo).port}` });
    cleanups.push(() => listener.stop(true));
    const app = await openApp(listener.port!, "/dictation/stream");
    expect(await app.next()).toBe("hello-early");
    app.ws.send("via-socks");
    expect(await app.next()).toBe("up:via-socks");
    expect(proxy.targets).toEqual(["chatgpt.com:443"]);
    app.ws.close();
  });

  test("a fragmented message whose payload passes the byte ceiling fails with 1009", async () => {
    const listener = listenerFor(direct());
    cleanups.push(() => listener.stop(true));
    const app = await openApp(listener.port!, "/dictation/stream");
    expect(await app.next()).toBe("hello-early");
    app.ws.send("bigfrag");
    const closed = await app.closed;
    expect(closed.code).toBe(1009);
  });
});

describe("chatgpt unblock websocket relay helpers", () => {
  const upgrade = (headers: Record<string, string>) => new Request("https://chatgpt.com/x", { headers });

  test("only version-13 websocket upgrades are taken by the relay", () => {
    expect(isRelayableUpgrade(upgrade({ upgrade: "websocket", "sec-websocket-version": "13" }))).toBe(true);
    expect(isRelayableUpgrade(upgrade({ upgrade: "WebSocket", "sec-websocket-version": "13" }))).toBe(true);
    expect(isRelayableUpgrade(upgrade({ upgrade: "websocket", "sec-websocket-version": "8" }))).toBe(false);
    expect(isRelayableUpgrade(upgrade({ upgrade: "h2c" }))).toBe(false);
    expect(isRelayableUpgrade(upgrade({}))).toBe(false);
  });

  test("close codes that may not appear on the wire are replaced", () => {
    expect(sendableCloseCode(1000)).toBe(1000);
    expect(sendableCloseCode(1011)).toBe(1011);
    expect(sendableCloseCode(4000)).toBe(4000);
    for (const reserved of [1004, 1005, 1006, 1015, 999, 2000, 5000]) expect(sendableCloseCode(reserved)).toBe(1000);
  });
});

describe("chatgpt unblock upstream handshake reader", () => {
  /** An emitter that stands in for the tunnel socket; an unhandled 'error' on it throws. */
  function fakeTunnel(): TLSSocket {
    const emitter = new EventEmitter() as EventEmitter & { pause(): void; setTimeout(ms: number, cb?: () => void): void };
    emitter.pause = () => {};
    emitter.setTimeout = () => {};
    return emitter as unknown as TLSSocket;
  }

  test("a tunnel error after the 101 head, before attach(), does not throw", async () => {
    const socket = fakeTunnel();
    const read = readResponseHead(socket, 1000);
    socket.emit("data", Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"));
    expect((await read)?.head).toStartWith("HTTP/1.1 101");
    expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
  });

  test("a tunnel error after a failed read does not throw either", async () => {
    const socket = fakeTunnel();
    const read = readResponseHead(socket, 1000);
    socket.emit("close");
    expect(await read).toBeNull();
    expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
  });
});
