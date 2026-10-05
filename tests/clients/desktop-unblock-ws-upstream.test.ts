import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
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
});

