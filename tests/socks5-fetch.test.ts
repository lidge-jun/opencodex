import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createTcpServer, type Server as TcpServer } from "node:net";
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

function socksProxy(options: { username?: string; password?: string } = {}): TcpServer {
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
