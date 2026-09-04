import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { applyProxyEnv } from "../../src/config";
import { resolveProxyRoute } from "../../src/lib/proxy-env";
import type { OcxConfig } from "../../src/types";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "OCX_TEST_PROXY_REF", "OCX_TEST_NO_PROXY_REF"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of PROXY_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function configWithProxy(proxy?: string, noProxy?: string | string[]): OcxConfig {
  return { proxy, noProxy, providers: {} } as unknown as OcxConfig;
}

// The top-level config schema ends in `.passthrough()` and declares neither `proxy` nor
// `noProxy`, so these shapes survive validation and reach applyProxyEnv verbatim.
function configWithRawProxy(proxy: unknown, noProxy?: unknown): OcxConfig {
  return { proxy, noProxy, providers: {} } as unknown as OcxConfig;
}

describe("resolveProxyRoute", () => {
  test("wss uses HTTPS_PROXY and never HTTP_PROXY", () => {
    const target = new URL("wss://chatgpt.com/backend-api/codex/responses");
    expect(resolveProxyRoute(target, {
      HTTPS_PROXY: "http://secure-proxy.example:8443",
      HTTP_PROXY: "http://plain-proxy.example:8080",
    })).toEqual({ kind: "proxy", proxy: "http://secure-proxy.example:8443" });
    expect(resolveProxyRoute(target, {
      HTTP_PROXY: "http://plain-proxy.example:8080",
    })).toEqual({ kind: "direct" });
  });

  test.each([
    ["exact host", "wss://chatgpt.com/path", "chatgpt.com", "direct"],
    ["domain suffix", "wss://api.chatgpt.com/path", ".chatgpt.com", "direct"],
    ["wildcard suffix", "wss://api.chatgpt.com/path", "*.chatgpt.com", "direct"],
    ["wss default port", "wss://chatgpt.com/path", "chatgpt.com:443", "direct"],
    ["ws default port", "ws://chatgpt.com/path", "chatgpt.com:80", "direct"],
    ["port mismatch", "wss://chatgpt.com/path", "chatgpt.com:80", "proxy"],
    ["bracketed IPv6", "wss://[2001:db8::1]/path", "[2001:db8::1]:443", "direct"],
    ["URL-style entry", "wss://chatgpt.com/path", "https://chatgpt.com/ignored", "direct"],
  ] as const)("honors NO_PROXY for %s", (_label, target, noProxy, expectedKind) => {
    expect(resolveProxyRoute(new URL(target), {
      HTTPS_PROXY: "http://secure-proxy.example:8443",
      NO_PROXY: noProxy,
    }).kind).toBe(expectedKind);
  });

  test("uses stable proxy precedence and fails closed on the first unusable proxy", () => {
    const target = new URL("wss://chatgpt.com/backend-api/codex/responses");
    const route = (env: Record<string, string>) => resolveProxyRoute(target, env);
    expect([
      route({ HTTPS_PROXY: "http://upper-https:1", https_proxy: "http://lower-https:2", ALL_PROXY: "http://upper-all:3", all_proxy: "http://lower-all:4" }),
      route({ HTTPS_PROXY: " ", https_proxy: "http://lower-https:2", ALL_PROXY: "http://upper-all:3" }),
      route({ ALL_PROXY: "http://upper-all:3", all_proxy: "http://lower-all:4" }),
      route({ all_proxy: "https://lower-all:4" }),
      route({ HTTPS_PROXY: "socks5://unsupported:1080", ALL_PROXY: "http://must-not-win:3" }),
      route({ HTTPS_PROXY: "not a proxy URL", ALL_PROXY: "http://must-not-win:3" }),
      route({}),
    ]).toEqual([
      { kind: "proxy", proxy: "http://upper-https:1" },
      { kind: "proxy", proxy: "http://lower-https:2" },
      { kind: "proxy", proxy: "http://upper-all:3" },
      { kind: "proxy", proxy: "https://lower-all:4" },
      { kind: "fallback" },
      { kind: "fallback" },
      { kind: "direct" },
    ]);
  });

  test("preserves uppercase NO_PROXY precedence when it is explicitly empty", () => {
    expect(resolveProxyRoute(new URL("wss://chatgpt.com/path"), {
      HTTPS_PROXY: "http://secure-proxy.example:8443",
      NO_PROXY: "",
      no_proxy: "chatgpt.com",
    })).toEqual({ kind: "proxy", proxy: "http://secure-proxy.example:8443" });
  });

  test("Bun WebSocket sends WSS through an HTTP CONNECT proxy", async () => {
    let resolveConnect!: (target: string) => void;
    const connected = new Promise<string>(resolve => { resolveConnect = resolve; });
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      resolveConnect(request.url ?? "");
      socket.end("HTTP/1.1 502 Probe Complete\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("proxy did not bind a TCP port");
    const socket = new WebSocket("wss://proxy-probe.invalid/backend-api/codex/responses", {
      proxy: `http://127.0.0.1:${address.port}`,
    } as unknown as string[]);
    try {
      expect(await Promise.race([
        connected,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("CONNECT was not observed")), 5_000)),
      ])).toBe("proxy-probe.invalid:443");
    } finally {
      try { socket.close(); } catch { /* probe is already complete */ }
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 10_000);

  test.skipIf(process.platform !== "win32")("Bun fetch honors NO_PROXY on Windows", async () => {
    let providerRequests = 0;
    let proxyRequests = 0;
    const provider = createServer((_request, response) => {
      providerRequests += 1;
      response.end("direct");
    });
    const proxy = createServer((_request, response) => {
      proxyRequests += 1;
      response.end("proxied");
    });
    const listen = async (server: typeof provider): Promise<number> => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
      return address.port;
    };
    const [providerPort, proxyPort] = await Promise.all([listen(provider), listen(proxy)]);
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.NO_PROXY = "127.0.0.1";
    try {
      expect(await (await fetch(`http://127.0.0.1:${providerPort}/models`)).text()).toBe("direct");
      expect(providerRequests).toBe(1);
      expect(proxyRequests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>(resolve => provider.close(() => resolve())),
        new Promise<void>(resolve => proxy.close(() => resolve())),
      ]);
    }
  });
});

describe("applyProxyEnv with values the schema does not constrain", () => {
  test("warns once per discarded proxy setting without exposing its raw value", () => {
    const secret = "raw-proxy-credential-sentinel-2947";
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const invalidProxy = { secret };
      applyProxyEnv(configWithRawProxy(invalidProxy));
      applyProxyEnv(configWithRawProxy(invalidProxy));
      expect(process.env.HTTP_PROXY).toBeUndefined();
      expect(process.env.HTTPS_PROXY).toBeUndefined();

      const invalidNoProxy = { secret };
      applyProxyEnv(configWithRawProxy("http://proxy.corp:8080", invalidNoProxy));
      applyProxyEnv(configWithRawProxy("http://proxy.corp:8080", invalidNoProxy));
      expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");

      const invalidElement = { secret };
      applyProxyEnv(configWithRawProxy("http://proxy.corp:8080", ["internal.example", invalidElement]));
      applyProxyEnv(configWithRawProxy("http://proxy.corp:8080", ["internal.example", invalidElement]));
      expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1],internal.example");
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("config.json proxy was discarded");
    expect(warnings[0]).toContain("direct egress");
    expect(warnings[1]).toContain("config.json noProxy was discarded");
    expect(warnings[1]).toContain("existing NO_PROXY and loopback bypasses remain");
    expect(warnings[2]).toContain("config.json noProxy contains invalid elements");
    expect(warnings[2]).toContain("invalid elements were ignored");
    expect(warnings.join("\n")).not.toContain(secret);
  });

  // applyProxyEnv runs at every process entry point that makes outbound requests, so a
  // throw here is a startup crash rather than a degraded proxy.
  test("a non-string proxy does not throw and sets no proxy env", () => {
    expect(() => applyProxyEnv(configWithRawProxy(42))).not.toThrow();
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
  });

  test("a non-string noProxy does not throw and keeps loopback exclusions", () => {
    expect(() => applyProxyEnv(configWithRawProxy("http://proxy.corp:8080", 42))).not.toThrow();
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
  });

  test.each([
    ["a number", 42],
    ["null", null],
    ["an object", { a: 1 }],
  ])("keeps the operator's usable noProxy entries when the array also holds %s", (_label, bad) => {
    expect(() => applyProxyEnv(configWithRawProxy("http://proxy.corp:8080", ["internal.example", bad]))).not.toThrow();
    expect(process.env.NO_PROXY).toBe("internal.example,localhost,127.0.0.1,::1,[::1]");
  });
});

describe("applyProxyEnv", () => {
  test("no-op when config.proxy is unset", () => {
    process.env.NO_PROXY = "operator-owned.example";
    applyProxyEnv(configWithProxy(undefined, "internal.example"));
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBe("operator-owned.example");
  });

  test("merges configured comma-separated noProxy entries", () => {
    applyProxyEnv(configWithProxy("http://proxy.corp:8080", "internal.example,10.0.0.0/8"));
    expect(process.env.NO_PROXY).toBe("internal.example,10.0.0.0/8,localhost,127.0.0.1,::1,[::1]");
  });

  test("merges configured noProxy array entries like the string form", () => {
    applyProxyEnv(configWithProxy("http://proxy.corp:8080", ["internal.example", "10.0.0.0/8"]));
    expect(process.env.NO_PROXY).toBe("internal.example,10.0.0.0/8,localhost,127.0.0.1,::1,[::1]");
  });

  test("mirrors config.proxy into HTTP(S)_PROXY and excludes loopback (IPv4 + IPv6)", () => {
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.HTTP_PROXY).toBe("http://proxy.corp:8080");
    expect(process.env.HTTPS_PROXY).toBe("http://proxy.corp:8080");
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
  });

  test("user-set env vars win over config", () => {
    process.env.HTTPS_PROXY = "http://user-proxy:3128";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.HTTPS_PROXY).toBe("http://user-proxy:3128");
    expect(process.env.HTTP_PROXY).toBe("http://proxy.corp:8080");
  });

  test.each(["ALL_PROXY", "all_proxy"])("config fills a scheme proxy ahead of %s for WSS", key => {
    process.env[key] = "http://fallback-proxy.example:8081";
    applyProxyEnv(configWithProxy("http://configured-proxy.example:8080"));
    expect(process.env[key]).toBe("http://fallback-proxy.example:8081");
    expect(resolveProxyRoute(new URL("wss://chatgpt.com/backend-api/codex/responses")))
      .toEqual({ kind: "proxy", proxy: "http://configured-proxy.example:8080" });
  });

  test("appends loopback entries to an existing NO_PROXY without duplicating", () => {
    process.env.NO_PROXY = "internal.corp,localhost";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.NO_PROXY).toBe("internal.corp,localhost,127.0.0.1,::1,[::1]");
  });

  test("dedup is case-insensitive against existing entries", () => {
    process.env.NO_PROXY = "LOCALHOST,[::1]";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080"));
    expect(process.env.NO_PROXY).toBe("LOCALHOST,[::1],127.0.0.1,::1");
  });

  test("dedup is case-insensitive for configured entries while preserving their casing", () => {
    applyProxyEnv(configWithProxy("http://proxy.corp:8080", "LOCALHOST"));
    expect(process.env.NO_PROXY).toBe("LOCALHOST,127.0.0.1,::1,[::1]");
  });

  test("resolves ${VAR}-style noProxy references", () => {
    process.env.OCX_TEST_NO_PROXY_REF = "internal.example,10.0.0.0/8";
    applyProxyEnv(configWithProxy("http://proxy.corp:8080", "${OCX_TEST_NO_PROXY_REF}"));
    expect(process.env.NO_PROXY).toBe("internal.example,10.0.0.0/8,localhost,127.0.0.1,::1,[::1]");
  });

  test("resolves ${VAR}-style env references like other config secrets", () => {
    process.env.OCX_TEST_PROXY_REF = "http://ref-proxy:9999";
    applyProxyEnv(configWithProxy("${OCX_TEST_PROXY_REF}"));
    expect(process.env.HTTP_PROXY).toBe("http://ref-proxy:9999");
  });
});

describe("applyProxyEnv with proxy: \"auto\" (#1525)", () => {
  const { applyProxyEnvWith } = require("../../src/config") as typeof import("../../src/config");
  const { parseWindowsProxyServer, readWindowsSystemProxy } = require("../../src/lib/windows-system-proxy") as typeof import("../../src/lib/windows-system-proxy");

  function capture(run: () => void): string[] {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try { run(); } finally { console.log = original; }
    return lines;
  }

  test("parses bare, per-scheme, and socks-only ProxyServer values", () => {
    expect(parseWindowsProxyServer("127.0.0.1:7890")).toEqual({ kind: "proxy", url: "http://127.0.0.1:7890" });
    expect(parseWindowsProxyServer("http=10.0.0.5:3128;https=10.0.0.6:3129;ftp=x:1")).toEqual({ kind: "proxy", url: "http://10.0.0.6:3129" });
    expect(parseWindowsProxyServer("http=10.0.0.5:3128")).toEqual({ kind: "proxy", url: "http://10.0.0.5:3128" });
    expect(parseWindowsProxyServer("socks=127.0.0.1:1080")).toEqual({ kind: "socks-only" });
    expect(parseWindowsProxyServer("")).toEqual({ kind: "disabled" });
  });

  test("readWindowsSystemProxy honors ProxyEnable and platform", () => {
    const on = () => ({ proxyEnable: "0x1", proxyServer: "127.0.0.1:7893" });
    expect(readWindowsSystemProxy(on, "win32")).toEqual({ kind: "proxy", url: "http://127.0.0.1:7893" });
    expect(readWindowsSystemProxy(() => ({ proxyEnable: "0x0", proxyServer: "127.0.0.1:7893" }), "win32")).toEqual({ kind: "disabled" });
    expect(readWindowsSystemProxy(() => null, "win32")).toEqual({ kind: "unreadable" });
    expect(readWindowsSystemProxy(on, "darwin")).toEqual({ kind: "unsupported" });
  });

  test("auto on Windows mirrors the discovered proxy and logs only the origin", () => {
    const lines = capture(() => applyProxyEnvWith(configWithProxy("auto"), {
      platform: "win32",
      reader: () => ({ proxyEnable: "0x1", proxyServer: "user:secret-pass-91@127.0.0.1:7893" }),
    }));
    expect(process.env.HTTP_PROXY).toBe("http://user:secret-pass-91@127.0.0.1:7893");
    expect(process.env.HTTPS_PROXY).toBe("http://user:secret-pass-91@127.0.0.1:7893");
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
    expect(lines.join("\n")).toContain("http://127.0.0.1:7893");
    expect(lines.join("\n")).not.toContain("secret-pass-91");
  });

  test("auto never leaks the literal into HTTP_PROXY when discovery yields nothing", () => {
    for (const [platform, reader] of [
      ["darwin", () => ({ proxyEnable: "0x1", proxyServer: "127.0.0.1:1" })],
      ["win32", () => ({ proxyEnable: "0x0", proxyServer: "127.0.0.1:1" })],
      ["win32", () => ({ proxyEnable: "0x1", proxyServer: "socks=127.0.0.1:1080" })],
      ["win32", () => null],
    ] as const) {
      delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY;
      const lines = capture(() => applyProxyEnvWith(configWithProxy("auto"), { platform, reader }));
      expect(process.env.HTTP_PROXY).toBeUndefined();
      expect(process.env.HTTPS_PROXY).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('proxy "auto"');
    }
  });

  test("auto defers to an existing proxy environment without consulting the registry", () => {
    process.env.HTTPS_PROXY = "http://from-env:9";
    let consulted = false;
    applyProxyEnvWith(configWithProxy("auto"), { platform: "win32", reader: () => { consulted = true; return null; } });
    expect(consulted).toBe(false);
    expect(process.env.HTTPS_PROXY).toBe("http://from-env:9");
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });
});
