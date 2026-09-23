import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { applyProxyEnv } from "../../src/config";
import { configuredOutboundFetch, noProxyMatches, resolveProxyRoute, configureSocks5Fetch, type ProxyCapableRequestInit } from "../../src/lib/proxy-env";
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
  configureSocks5Fetch();
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
  test("writes no proxy state into an environment that has none", () => {
    applyProxyEnv(configWithProxy());
    for (const key of PROXY_ENV_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  test("keeps mandatory loopback exclusions for an inherited SOCKS proxy when config.proxy is unset", () => {
    process.env.ALL_PROXY = "socks5://untrusted-proxy.invalid:1080";
    process.env.NO_PROXY = "operator-owned.example";
    applyProxyEnv(configWithProxy(undefined, "internal.example"));
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBe("operator-owned.example,localhost,127.0.0.1,::1,[::1]");
  });

  test.each([
    ["an inherited HTTP proxy", { HTTP_PROXY: "http://proxy.invalid:3128" }],
    ["an inherited HTTPS proxy", { https_proxy: "http://proxy.invalid:3128" }],
    ["an inherited HTTP ALL_PROXY", { ALL_PROXY: "http://proxy.invalid:3128" }],
    ["an inherited lowercase HTTPS all_proxy", { all_proxy: "https://proxy.invalid:3128" }],
  ] as const)("adds only loopback addresses for %s and no config.proxy", (_label, inherited) => {
    // Bun applies an inherited HTTP(S) proxy itself and matches NO_PROXY entries as domain
    // suffixes, so adding "localhost" there would also send any *.localhost name direct.
    // Loopback addresses cannot widen that way and keep local 127.0.0.1 calls off the proxy.
    Object.assign(process.env, inherited);
    process.env.NO_PROXY = "operator-owned.example";
    applyProxyEnv(configWithProxy());
    expect(process.env.NO_PROXY).toBe("operator-owned.example,127.0.0.1,::1,[::1]");
  });

  test("leaves an inherited NO_PROXY untouched when no proxy is inherited", () => {
    process.env.NO_PROXY = "operator-owned.example";
    applyProxyEnv(configWithProxy());
    expect(process.env.NO_PROXY).toBe("operator-owned.example");
  });

  test.each(["ALL_PROXY", "all_proxy"])("inherited SOCKS %s cannot intercept loopback fetches", async key => {
    process.env[key] = "socks5://untrusted-proxy.invalid:1080";
    applyProxyEnv(configWithProxy());
    let directCalls = 0;
    const response = await configuredOutboundFetch("http://127.0.0.1:11434/v1/chat/completions", undefined, async () => {
      directCalls += 1;
      return new Response("direct");
    });
    expect(await response.text()).toBe("direct");
    expect(directCalls).toBe(1);
  });

  test.each(["ALL_PROXY", "all_proxy"])("inherited SOCKS %s still owns non-loopback fetches", async key => {
    // A local proxy that drops every connection: the SOCKS handshake fails at once, with no
    // DNS lookup for the proxy or the IP-literal target, on every runner.
    const refusing = createTcpServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      refusing.once("error", reject);
      refusing.listen(0, "127.0.0.1", resolve);
    });
    const address = refusing.address();
    if (!address || typeof address === "string") throw new Error("proxy fixture did not bind a TCP port");
    process.env[key] = `socks5://127.0.0.1:${address.port}`;
    applyProxyEnv(configWithProxy());
    // The bypass must be scoped to loopback only: a non-loopback URL still routes through
    // the inherited SOCKS proxy, which fails here. The direct fallback must NOT be
    // consulted — if it were, the bypass leaked.
    let directCalls = 0;
    try {
      await expect(configuredOutboundFetch("http://203.0.113.10/v1/chat/completions", undefined, async () => {
        directCalls += 1;
        return new Response("direct");
      })).rejects.toThrow();
      expect(directCalls).toBe(0);
    } finally {
      await new Promise<void>(resolve => refusing.close(() => resolve()));
    }
  });

  test.each([
    ["alone", "ALL_PROXY", {}, "http://localhost:11434/v1/models", "localhost,127.0.0.1,::1,[::1]", false],
    ["beside an inherited HTTP proxy", "ALL_PROXY", { HTTP_PROXY: "http://proxy.invalid:3128" }, "http://127.0.0.1:11434/v1/models", "127.0.0.1,::1,[::1]", false],
    ["with lowercase HTTP all_proxy", "ALL_PROXY", { all_proxy: "http://proxy.invalid:3128" }, "http://localhost:11434/v1/models", "127.0.0.1,::1,[::1]", true],
    ["with uppercase HTTP ALL_PROXY", "all_proxy", { ALL_PROXY: "http://proxy.invalid:3128" }, "http://localhost:11434/v1/models", "127.0.0.1,::1,[::1]", true],
  ] as const)("an inherited SOCKS proxy %s: loopback goes direct, *.localhost stays on SOCKS", async (_label, socksKey, inherited, loopbackUrl, expectedNoProxy, forcedDirect) => {
    const refusing = createTcpServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      refusing.once("error", reject);
      refusing.listen(0, "127.0.0.1", resolve);
    });
    const address = refusing.address();
    if (!address || typeof address === "string") throw new Error("proxy fixture did not bind a TCP port");
    // socks5h: the proxy resolves the name, so the fixture fails the request without local DNS.
    process.env[socksKey] = `socks5h://127.0.0.1:${address.port}`;
    Object.assign(process.env, inherited);
    // Windows environment names are case-insensitive: ALL_PROXY and all_proxy are one variable,
    // so the opposite-case HTTP value replaces the SOCKS one and no SOCKS proxy is left.
    const collapsed = process.platform === "win32"
      && Object.keys(inherited).some(key => key !== socksKey && key.toLowerCase() === socksKey.toLowerCase());
    applyProxyEnv(configWithProxy());
    // Beside an HTTP(S) proxy Bun reads NO_PROXY too, with suffix matching, so no bare localhost.
    expect(process.env.NO_PROXY).toBe(expectedNoProxy);
    let directCalls = 0;
    let directProxy: string | false | undefined;
    const direct = async (_input: RequestInfo | URL, init?: RequestInit) => {
      directCalls += 1;
      directProxy = (init as ProxyCapableRequestInit | undefined)?.proxy;
      return new Response("direct");
    };
    try {
      expect(await (await configuredOutboundFetch(loopbackUrl, undefined, direct)).text()).toBe("direct");
      expect(directCalls).toBe(1);
      if (collapsed) {
        // Only the HTTP proxy remains, so nothing forces direct egress and Bun's own proxy
        // environment (with the loopback NO_PROXY above) decides for both hosts.
        expect(process.env[socksKey]).toBe("http://proxy.invalid:3128");
        expect(directProxy).toBeUndefined();
        expect(await (await configuredOutboundFetch("http://app.localhost:11434/v1/models", undefined, direct)).text()).toBe("direct");
        expect(directCalls).toBe(2);
        expect(directProxy).toBeUndefined();
        return;
      }
      if (forcedDirect) expect(directProxy).toBe(false);
      await expect(configuredOutboundFetch("http://app.localhost:11434/v1/models", undefined, direct)).rejects.toThrow();
      expect(directCalls).toBe(1);
    } finally {
      await new Promise<void>(resolve => refusing.close(() => resolve()));
    }
  });

  test("a configured proxy also merges loopback into an inherited lowercase no_proxy", () => {
    // Bun's native fetch consults a non-empty lowercase no_proxy before NO_PROXY, with suffix
    // matching, so it gains the loopback addresses but never a bare localhost.
    process.env.no_proxy = "internal.example";
    applyProxyEnv(configWithProxy("http://proxy.invalid:3128", "localhost,internal.corp"));
    // Windows environment names are case-insensitive: there no_proxy IS NO_PROXY.
    expect(process.env.no_proxy).toBe(process.platform === "win32"
      ? "internal.example,localhost,internal.corp,127.0.0.1,::1,[::1]"
      : "internal.example,127.0.0.1,::1,[::1]");
    const loopback = new URL("http://127.0.0.1:11434/v1/models");
    expect(noProxyMatches(loopback, { no_proxy: process.env.no_proxy })).toBe(true);
  });

  test("loopback names and IP literals match exactly; a leading dot still means subdomains", () => {
    const env = { NO_PROXY: "localhost,127.0.0.1,::1,[::1],example.com,.localtest" };
    const matches = (url: string) => noProxyMatches(new URL(url), env);
    expect(matches("http://localhost:11434/")).toBe(true);
    expect(matches("http://127.0.0.1:11434/")).toBe(true);
    expect(matches("http://[::1]:11434/")).toBe(true);
    expect(matches("http://app.localhost/")).toBe(false);
    expect(matches("https://api.example.com/")).toBe(true);
    expect(matches("http://app.localtest/")).toBe(true);
    expect(noProxyMatches(new URL("http://app.localhost/"), { NO_PROXY: ".localhost" })).toBe(true);
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

  test("mirrors SOCKS URLs into ALL_PROXY and leaves HTTP(S)_PROXY unset", () => {
    applyProxyEnv(configWithProxy("socks5://127.0.0.1:10808"));
    expect(process.env.ALL_PROXY).toBe("socks5://127.0.0.1:10808");
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
  });

  test("SOCKS config.proxy wins over inherited HTTP(S)_PROXY in this process", () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:10808";
    process.env.HTTPS_PROXY = "http://127.0.0.1:10808";
    applyProxyEnv(configWithProxy("socks5://127.0.0.1:10808"));
    expect(process.env.ALL_PROXY).toBe("socks5://127.0.0.1:10808");
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
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
    expect(parseWindowsProxyServer("127.0.0.1:7890")).toEqual({ kind: "proxy", httpUrl: "http://127.0.0.1:7890", httpsUrl: "http://127.0.0.1:7890" });
    expect(parseWindowsProxyServer("http=10.0.0.5:3128;https=10.0.0.6:3129;ftp=x:1")).toEqual({ kind: "proxy", httpUrl: "http://10.0.0.5:3128", httpsUrl: "http://10.0.0.6:3129" });
    expect(parseWindowsProxyServer("http=10.0.0.5:3128")).toEqual({ kind: "proxy", httpUrl: "http://10.0.0.5:3128" });
    expect(parseWindowsProxyServer("https=10.0.0.6:3129")).toEqual({ kind: "proxy", httpsUrl: "http://10.0.0.6:3129" });
    expect(parseWindowsProxyServer("socks=127.0.0.1:1080")).toEqual({ kind: "socks-only" });
    expect(parseWindowsProxyServer("")).toEqual({ kind: "disabled" });
  });

  test("readWindowsSystemProxy honors ProxyEnable and platform", () => {
    const on = () => ({ proxyEnable: "0x1", proxyServer: "127.0.0.1:7893" });
    expect(readWindowsSystemProxy(on, "win32")).toEqual({ kind: "proxy", httpUrl: "http://127.0.0.1:7893", httpsUrl: "http://127.0.0.1:7893" });
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

  test("auto preserves per-scheme Windows proxy scope", () => {
    const lines = capture(() => applyProxyEnvWith(configWithProxy("auto"), {
      platform: "win32",
      reader: () => ({ proxyEnable: "0x1", proxyServer: "http=proxy-a:8080;https=user:secret-pass-92@proxy-b:8443" }),
    }));
    expect(process.env.HTTP_PROXY).toBe("http://proxy-a:8080");
    expect(process.env.HTTPS_PROXY).toBe("http://user:secret-pass-92@proxy-b:8443");
    expect(process.env.ALL_PROXY).toBeUndefined();
    expect(lines.join("\n")).toContain("HTTP http://proxy-a:8080");
    expect(lines.join("\n")).toContain("HTTPS http://proxy-b:8443");
    expect(lines.join("\n")).not.toContain("secret-pass-92");

    delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY;
    capture(() => applyProxyEnvWith(configWithProxy("auto"), {
      platform: "win32",
      reader: () => ({ proxyEnable: "0x1", proxyServer: "https=proxy-b:8443" }),
    }));
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBe("http://proxy-b:8443");
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
