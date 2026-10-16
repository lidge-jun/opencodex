import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { dialUpstreamTunnel, proxyDialPort } from "../../src/chatgpt/desktop-unblock/ws-upstream";

describe("ChatGPT intercept upstream proxy dial", () => {
  test("an omitted or scheme-default proxy port dials the scheme default", () => {
    expect(proxyDialPort(new URL("http://proxy.example"), "http-connect")).toBe(80);
    expect(proxyDialPort(new URL("http://proxy.example:80"), "http-connect")).toBe(80);
    expect(proxyDialPort(new URL("http://proxy.example:3128"), "http-connect")).toBe(3128);
    expect(proxyDialPort(new URL("https://proxy.example"), "http-connect")).toBe(443);
    expect(proxyDialPort(new URL("socks5://proxy.example"), "socks5")).toBe(1080);
    expect(proxyDialPort(new URL("socks5h://proxy.example:9050"), "socks5")).toBe(9050);
  });

  /** A proxy that reads the first handshake bytes and then closes cleanly without replying. */
  async function closingProxy(): Promise<{ server: Server; port: number }> {
    const server = createServer(socket => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as AddressInfo).port };
  }

  for (const scheme of ["http", "socks5"] as const) {
    test(`a ${scheme} proxy closing mid-handshake fails the dial before the timeout`, async () => {
      const { server, port } = await closingProxy();
      try {
        const started = Date.now();
        const tunnel = await dialUpstreamTunnel({ proxy: `${scheme}://127.0.0.1:${port}`, connectTimeoutMs: 8_000 });
        expect(tunnel).toBeNull();
        expect(Date.now() - started).toBeLessThan(4_000);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }

  /** Capture CONNECT bytes, refuse the tunnel, and require the client to close its socket. */
  async function observingProxy() {
    const sockets = new Set<Socket>();
    const chunks: Buffer[] = [];
    let closed!: () => void;
    const peerClosed = new Promise<void>(resolve => { closed = resolve; });
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => { sockets.delete(socket); closed(); });
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).includes("\r\n\r\n")) {
          socket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as AddressInfo).port,
      written: () => Buffer.concat(chunks).toString("latin1"),
      async expectClosed() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            peerClosed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("proxy socket was not closed")), 1_000);
            }),
          ]);
        } finally { clearTimeout(timer); }
      },
      async stop() {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      },
    };
  }

  for (const [label, userinfo, decoded] of [
    ["no credentials", "", null],
    ["username only", "user@", "user:"],
    ["password only", ":pass@", ":pass"],
    ["percent-encoded credentials", "u%40ser:p%3Ass@", "u@ser:p:ss"],
  ] as const) {
    test(`HTTP CONNECT writes the expected authorization with ${label}`, async () => {
      const proxy = await observingProxy();
      try {
        expect(await dialUpstreamTunnel({ proxy: `http://${userinfo}127.0.0.1:${proxy.port}` })).toBeNull();
        await proxy.expectClosed();
        const authorization = decoded === null ? "" : `Proxy-Authorization: Basic ${Buffer.from(decoded).toString("base64")}\r\n`;
        expect(proxy.written()).toBe("CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n"
          + `Proxy-Connection: Keep-Alive\r\n${authorization}\r\n`);
      } finally { await proxy.stop(); }
    });
  }

  for (const userinfo of ["%zz:pass", "user:%zz", ":%zz"]) {
    test(`HTTP CONNECT closes without sending malformed credentials (${userinfo})`, async () => {
      const proxy = await observingProxy();
      try {
        expect(await dialUpstreamTunnel({ proxy: `http://${userinfo}@127.0.0.1:${proxy.port}` })).toBeNull();
        await proxy.expectClosed();
        expect(proxy.written()).toBe("");
      } finally { await proxy.stop(); }
    });
  }
});

