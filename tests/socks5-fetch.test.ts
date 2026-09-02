import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import net, { createConnection, createServer as createTcpServer, Socket, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { configureSocks5Fetch } from "../src/lib/proxy-env";
import { providerOutboundGet } from "../src/lib/provider-outbound";
import { socks5Fetch } from "../src/lib/socks5-fetch";
import { applyProxyEnv } from "../src/config";
import { providerFetch } from "../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../src/types";

const proxyEnvKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(proxyEnvKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of proxyEnvKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  configureSocks5Fetch();
});

async function listen(server: TcpServer | ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: TcpServer | ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function socksProxy(options: {
  username?: string;
  password?: string;
  holdAfterConnect?: boolean;
  onHold?: (socket: Socket) => void;
} = {}): TcpServer {
  const proxy = createTcpServer(socket => {
    let stage: "greeting" | "auth" | "connect" = "greeting";
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (stage === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
          const methods = buffer.subarray(2, 2 + buffer[1]!);
          buffer = buffer.subarray(2 + methods.length);
          const needsAuth = options.username !== undefined;
          if (needsAuth && !methods.includes(0x02)) {
            socket.end(Buffer.from([0x05, 0xff]));
            return;
          }
          socket.write(Buffer.from([0x05, needsAuth ? 0x02 : 0x00]));
          stage = needsAuth ? "auth" : "connect";
          continue;
        }
        if (stage === "auth") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]! + 1) return;
          const usernameLength = buffer[1]!;
          if (buffer.length < 3 + usernameLength) return;
          const passwordLength = buffer[2 + usernameLength]!;
          if (buffer.length < 3 + usernameLength + passwordLength) return;
          const username = buffer.subarray(2, 2 + usernameLength).toString();
          const password = buffer.subarray(3 + usernameLength, 3 + usernameLength + passwordLength).toString();
          buffer = buffer.subarray(3 + usernameLength + passwordLength);
          const valid = username === options.username && password === options.password;
          socket.write(Buffer.from([0x01, valid ? 0x00 : 0xff]));
          if (!valid) return;
          stage = "connect";
          continue;
        }
        if (buffer.length < 7) return;
        const addressType = buffer[3]!;
        if (addressType !== 0x03) throw new Error(`test proxy expected a domain target, got ${addressType}`);
        const hostnameLength = buffer[4]!;
        const requestLength = 7 + hostnameLength;
        if (buffer.length < requestLength) return;
        const port = buffer.readUInt16BE(5 + hostnameLength);
        buffer = buffer.subarray(requestLength);
        if (options.holdAfterConnect) {
          socket.removeListener("data", onData);
          socket.pause();
          options.onHold?.(socket);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 1]));
          return;
        }
        const targetSocket = createConnection({ host: "127.0.0.1", port }, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 1]));
          socket.removeListener("data", onData);
          if (buffer.length > 0) socket.unshift(buffer);
          socket.pipe(targetSocket);
          targetSocket.pipe(socket);
        });
        targetSocket.once("error", error => socket.destroy(error));
        return;
      }
    };
    socket.on("data", onData);
    socket.once("error", () => undefined);
  });
  return proxy;
}

describe("socks5Fetch", () => {
  test("performs a real domain CONNECT and streams the HTTP response", async () => {
    const target = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first");
      setTimeout(() => response.end(" second"), 10);
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    try {
      const response = await socks5Fetch(
        `http://provider.invalid:${targetPort}/models`,
        { headers: { authorization: "Bearer test" } },
        `socks5://127.0.0.1:${proxyPort}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("first second");
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("closes a keep-alive socket after a fixed-length response completes", async () => {
    let targetConnection: Socket | undefined;
    const target = createTcpServer(socket => {
      targetConnection = socket;
      socket.once("error", () => undefined);
      let request = Buffer.alloc(0);
      socket.on("data", chunk => {
        request = Buffer.concat([request, chunk]);
        if (!request.toString("latin1").includes("\r\n\r\n")) return;
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok");
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    try {
      const response = await socks5Fetch(
        `http://provider.invalid:${targetPort}/keep-alive`,
        undefined,
        `socks5://127.0.0.1:${proxyPort}`,
      );
      expect(await response.text()).toBe("ok");
      await Bun.sleep(50);
      expect(targetConnection?.destroyed).toBe(true);
    } finally {
      targetConnection?.destroy();
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("closes a keep-alive socket for a bodyless response", async () => {
    let targetConnection: Socket | undefined;
    const target = createTcpServer(socket => {
      targetConnection = socket;
      socket.once("error", () => undefined);
      socket.on("data", chunk => {
        if (!chunk.toString("latin1").includes("\r\n\r\n")) return;
        socket.write("HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n");
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    try {
      const response = await socks5Fetch(
        `http://provider.invalid:${targetPort}/no-content`,
        undefined,
        `socks5://127.0.0.1:${proxyPort}`,
      );
      expect(await response.text()).toBe("");
      await Bun.sleep(50);
      expect(targetConnection?.destroyed).toBe(true);
    } finally {
      targetConnection?.destroy();
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("rejects a request stuck in body backpressure when the socket errors", async () => {
    let heldSocket: Socket | undefined;
    const proxy = socksProxy({ holdAfterConnect: true, onHold: socket => { heldSocket = socket; } });
    const proxyPort = await listen(proxy);
    let resolveBackpressure: (() => void) | undefined;
    const backpressure = new Promise<void>(resolve => {
      resolveBackpressure = resolve;
    });
    let clientSocket: Socket | undefined;
    let backpressureObserved = false;
    let listenerCountsBeforeWait: { drain: number; error: number; close: number } | undefined;
    const writeCounts = new Map<Socket, number>();
    const originalWrite = Socket.prototype.write;
    Socket.prototype.write = function(this: Socket, ...args: Parameters<typeof originalWrite>): boolean {
      const result = originalWrite.apply(this, args);
      const writeCount = (writeCounts.get(this) ?? 0) + 1;
      writeCounts.set(this, writeCount);
      if (!backpressureObserved && writeCount === 4) {
        backpressureObserved = true;
        clientSocket = this;
        listenerCountsBeforeWait = {
          drain: this.listenerCount("drain"),
          error: this.listenerCount("error"),
          close: this.listenerCount("close"),
        };
        resolveBackpressure?.();
        queueMicrotask(() => this.destroy(new Error("test write failure")));
        return false;
      }
      return result;
    };
    const init = {
      method: "POST",
      body: new Uint8Array(8 * 1024 * 1024),
      duplex: "half",
    } satisfies RequestInit & { duplex: "half" };
    const pending = socks5Fetch("http://provider.invalid/", init, `socks5://127.0.0.1:${proxyPort}`);
    const pendingHandled = pending.catch(() => undefined);
    try {
      const backpressureOutcome = await Promise.race([
        backpressure.then(() => "ready"),
        Bun.sleep(1_000).then(() => "timed out"),
      ]);
      if (backpressureOutcome !== "ready") {
        throw new Error(`backpressure was not observed; writes=${JSON.stringify([...writeCounts.values()])}`);
      }
      expect(backpressureObserved).toBe(true);
      const outcome = await Promise.race([
        pending.then(
          () => "resolved",
          error => error,
        ),
        Bun.sleep(1_000).then(() => "timed out"),
      ]);
      expect(outcome).toBeInstanceOf(Error);
      if (!(outcome instanceof Error)) throw new Error("failed backpressure did not settle");
      expect(outcome.message).toBe("test write failure");
      if (!clientSocket || !listenerCountsBeforeWait) throw new Error("backpressure socket was not captured");
      expect(clientSocket.listenerCount("drain")).toBe(listenerCountsBeforeWait.drain);
      expect(clientSocket.listenerCount("error")).toBe(listenerCountsBeforeWait.error);
      expect(clientSocket.listenerCount("close")).toBe(listenerCountsBeforeWait.close);
    } finally {
      Socket.prototype.write = originalWrite;
      heldSocket?.destroy();
      await Promise.race([pendingHandled, Bun.sleep(250)]);
      await Promise.race([close(proxy), Bun.sleep(250)]);
    }
  });

  test("supports RFC 1929 username/password authentication", async () => {
    const target = createHttpServer((_request, response) => response.end("authenticated"));
    const proxy = socksProxy({ username: "user", password: "pass" });
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    try {
      const response = await socks5Fetch(
        `http://provider.invalid:${targetPort}/`,
        undefined,
        `socks5://user:pass@127.0.0.1:${proxyPort}`,
      );
      expect(await response.text()).toBe("authenticated");
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("forwards POST bodies through a chunked SOCKS5 tunnel", async () => {
    const target = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        expect(request.method).toBe("POST");
        expect(Buffer.concat(chunks).toString()).toBe('{"hello":"socks"}');
        response.end("posted");
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    try {
      const response = await socks5Fetch(
        `http://provider.invalid:${targetPort}/submit`,
        { method: "POST", body: '{"hello":"socks"}' },
        `socks5://127.0.0.1:${proxyPort}`,
      );
      expect(await response.text()).toBe("posted");
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("streams a large declared chunk as bounded slices instead of one buffer", async () => {
    const slice = 64 * 1024;
    const payload = Buffer.alloc(slice * 3 + 128, 0x61);
    const received: Buffer[] = [];
    const target = createTcpServer(socket => {
      socket.once("error", () => undefined);
      let request = Buffer.alloc(0);
      socket.on("data", chunk => {
        request = Buffer.concat([request, chunk]);
        if (!request.toString("latin1").includes("\r\n\r\n")) return;
        socket.write(
          `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n${payload.byteLength.toString(16)}\r\n`,
        );
        socket.write(payload);
        socket.write("\r\n0\r\n\r\n");
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    try {
      const response = await socks5Fetch(
        `http://provider.invalid:${targetPort}/chunked`,
        undefined,
        `socks5://127.0.0.1:${proxyPort}`,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("chunked response had no body");
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        received.push(Buffer.from(next.value));
      }
      expect(received.length).toBeGreaterThan(1);
      expect(Math.max(...received.map(chunk => chunk.byteLength))).toBeLessThanOrEqual(slice);
      expect(Buffer.concat(received).equals(payload)).toBe(true);
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("rejects a chunk size that is only a hexadecimal prefix", async () => {
    const target = createTcpServer(socket => {
      socket.once("error", () => undefined);
      socket.on("data", chunk => {
        if (!chunk.toString("latin1").includes("\r\n\r\n")) return;
        socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1g\r\nxxxx\r\n0\r\n\r\n");
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    try {
      const response = await socks5Fetch(
        `http://provider.invalid:${targetPort}/bad-chunk-size`,
        undefined,
        `socks5://127.0.0.1:${proxyPort}`,
      );
      await expect(response.text()).rejects.toThrow("invalid chunk size");
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("cancels a huge declared chunk and releases the socket", async () => {
    const originalCreateConnection = net.createConnection;
    let clientSocket: Socket | undefined;
    const target = createTcpServer(socket => {
      socket.once("error", () => undefined);
      let request = Buffer.alloc(0);
      socket.on("data", chunk => {
        request = Buffer.concat([request, chunk]);
        if (!request.toString("latin1").includes("\r\n\r\n")) return;
        socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n7fffffff\r\n");
        socket.write(Buffer.alloc(8 * 1024, 0x62));
      });
    });
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    net.createConnection = ((...args: Parameters<typeof originalCreateConnection>) => {
      const socket = originalCreateConnection(...(args as Parameters<typeof originalCreateConnection>));
      const opts = args[0];
      if (typeof opts === "object" && opts !== null && "port" in opts && Number(opts.port) === proxyPort) {
        clientSocket = socket;
      }
      return socket;
    }) as typeof net.createConnection;
    try {
      const response = await socks5Fetch(
        `http://provider.invalid:${targetPort}/huge-chunk`,
        undefined,
        `socks5://127.0.0.1:${proxyPort}`,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("huge chunked response had no body");
      const pending = reader.read();
      await Bun.sleep(50);
      await reader.cancel();
      await Promise.race([pending.catch(() => undefined), Bun.sleep(250)]);
      await Bun.sleep(50);
      if (!clientSocket) throw new Error("SOCKS5 client socket was not captured");
      expect(clientSocket.destroyed).toBe(true);
      expect(clientSocket.listenerCount("data")).toBe(0);
      expect(clientSocket.listenerCount("error")).toBe(0);
      expect(clientSocket.listenerCount("end")).toBe(0);
      expect(clientSocket.listenerCount("close")).toBe(0);
    } finally {
      net.createConnection = originalCreateConnection;
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("rejects SOCKS4 URLs", async () => {
    await expect(socks5Fetch("http://provider.invalid/", undefined, "socks4://127.0.0.1:1080"))
      .rejects.toThrow("unsupported SOCKS5 proxy protocol");
  });

  test("aborts while the SOCKS5 proxy is still handshaking", async () => {
    const proxy = createTcpServer(() => undefined);
    const proxyPort = await listen(proxy);
    const controller = new AbortController();
    const pending = socks5Fetch(
      "http://provider.invalid/",
      { signal: controller.signal },
      `socks5://127.0.0.1:${proxyPort}`,
    );
    controller.abort(new Error("test abort"));
    try {
      await expect(pending).rejects.toThrow("test abort");
    } finally {
      await close(proxy);
    }
  });
});

describe("configured SOCKS5 fetch", () => {
  test("routes ordinary global fetch through the real SOCKS5 transport", async () => {
    const target = createHttpServer((_request, response) => response.end("global"));
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    applyProxyEnv({
      proxy: `socks5://127.0.0.1:${proxyPort}`,
      noProxy: "localhost,127.0.0.1,::1,[::1]",
    } as OcxConfig);
    try {
      const response = await fetch(`http://provider.invalid:${targetPort}/`);
      expect(await response.text()).toBe("global");
      const providerResponse = await providerFetch({
        baseUrl: `http://provider.invalid:${targetPort}/v1`,
      } as OcxProviderConfig)(`http://provider.invalid:${targetPort}/v1/models`);
      expect(await providerResponse.text()).toBe("global");
      const discoveryResponse = await providerOutboundGet(
        "provider",
        { baseUrl: `http://provider.invalid:${targetPort}/v1` },
        `http://provider.invalid:${targetPort}/v1/models`,
      );
      expect(await discoveryResponse.text()).toBe("global");
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });

  test("bypasses the SOCKS5 tunnel for NO_PROXY hosts", async () => {
    const target = createHttpServer((_request, response) => response.end("direct"));
    const proxy = socksProxy();
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    applyProxyEnv({
      proxy: `socks5://127.0.0.1:${proxyPort}`,
      noProxy: "localhost",
    } as OcxConfig);
    try {
      const response = await fetch(`http://localhost:${targetPort}/`);
      expect(await response.text()).toBe("direct");
    } finally {
      await Promise.all([close(proxy), close(target)]);
    }
  });
});
