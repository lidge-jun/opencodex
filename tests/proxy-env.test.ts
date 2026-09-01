import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyProxyEnv } from "../src/config";
import type { OcxConfig } from "../src/types";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "OCX_TEST_PROXY_REF", "OCX_TEST_NO_PROXY_REF"] as const;
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
  const { applyProxyEnvWith } = require("../src/config") as typeof import("../src/config");
  const { parseWindowsProxyServer, readWindowsSystemProxy } = require("../src/lib/windows-system-proxy") as typeof import("../src/lib/windows-system-proxy");

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

