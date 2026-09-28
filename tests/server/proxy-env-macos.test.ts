import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyProxyEnvWith } from "../../src/config";
import { readMacOSSystemProxy } from "../../src/config/macos-system-proxy";
import { noProxyMatches, resolveProxyRoute, configureSocks5Fetch } from "../../src/lib/proxy-env";
import type { OcxConfig } from "../../src/types";

const KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;
let saved: Record<string, string | undefined>;
const config = (proxy?: string, noProxy?: string | string[]): OcxConfig => ({ proxy, noProxy, providers: {} }) as OcxConfig;
const scutil = (body: string): string => `<dictionary> {\n${body}\n}`;
const both = "HTTPEnable : 1\nHTTPProxy : proxy.example\nHTTPPort : 8080\nHTTPSEnable : 1\nHTTPSProxy : ::1\nHTTPSPort : 8443";
const snapshot = (): Record<string, string | undefined> => Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  saved = snapshot();
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  configureSocks5Fetch();
});

describe('macOS proxy: "auto" (#5853)', () => {
  // Windows environment names are case-insensitive, so NO_PROXY and no_proxy are one variable
  // there. Cases that need the two bypass lists to differ can only run where they can differ.
  const caseSensitiveEnv = process.platform !== "win32";
  test.skipIf(!caseSensitiveEnv)("enabled schemes and safe IP exceptions reach Bun's lowercase bypass", () => {
    process.env.NO_PROXY = "upper.example";
    process.env.no_proxy = "lower.example";
    applyProxyEnvWith(config("auto", "private.example"), {
      platform: "darwin",
      macOSReader: () => scutil(`${both}\nExceptionsList : <array> {\n0 : 203.0.113.7\n1 : ::1\n}`),
    });
    expect(process.env.HTTP_PROXY).toBe("http://proxy.example:8080");
    expect(process.env.HTTPS_PROXY).toBe("http://[::1]:8443");
    expect(process.env.NO_PROXY).toBe("upper.example,private.example,203.0.113.7,[::1],127.0.0.1,::1");
    expect(process.env.no_proxy).toBe("lower.example,127.0.0.1,::1,[::1],private.example,203.0.113.7");
    for (const hostname of ["private.example", "child.private.example"]) {
      const url = new URL(`https://${hostname}/`);
      expect(noProxyMatches(url, { no_proxy: process.env.no_proxy })).toBe(true);
      expect(resolveProxyRoute(new URL(`wss://${hostname}/`))).toEqual({ kind: "direct" });
    }
    const unrelated = new URL("https://unrelated.example/");
    expect(noProxyMatches(unrelated, { no_proxy: process.env.no_proxy })).toBe(false);
    expect(resolveProxyRoute(new URL("wss://unrelated.example/")))
      .toEqual({ kind: "proxy", proxy: "http://[::1]:8443" });
    expect(noProxyMatches(new URL("http://203.0.113.7"), { no_proxy: process.env.no_proxy })).toBe(true);
    expect(noProxyMatches(new URL("http://203.0.113.70"), { no_proxy: process.env.no_proxy })).toBe(false);
    expect(resolveProxyRoute(new URL("https://example.org"))).toEqual({ kind: "proxy", proxy: "http://[::1]:8443" });
  });

  test.each(["localhost", "LOCALHOST", "LoCaLhOsT."])(
    "configured %s refuses discovery with inherited lowercase bypass", localhost => {
      process.env.no_proxy = "lower.example";
      process.env.NO_PROXY = "upper.example";
      const before = snapshot();
      const lines: string[] = [];
      const original = console.log;
      console.log = (...args) => { lines.push(args.join(" ")); };
      try {
        applyProxyEnvWith(config("auto", [localhost, "private.example"]), {
          platform: "darwin", macOSReader: () => scutil(both),
        });
      } finally { console.log = original; }
      expect(snapshot()).toEqual(before);
      expect(lines.join(" ")).toContain("discovery refused");
      expect(lines.join(" ")).not.toContain("private.example");
    },
  );

  test.skipIf(!caseSensitiveEnv)("without inherited lowercase bypass, configured localhost keeps the uppercase-only route", () => {
    applyProxyEnvWith(config("auto", ["localhost", "private.example"]), {
      platform: "darwin", macOSReader: () => scutil(both),
    });
    expect(process.env.NO_PROXY?.split(",")).toContain("localhost");
    expect(process.env.NO_PROXY?.split(",")).toContain("private.example");
    expect(process.env.no_proxy).toBeUndefined();
    expect(resolveProxyRoute(new URL("ws://localhost/"))).toEqual({ kind: "direct" });
    expect(resolveProxyRoute(new URL("ws://app.localhost/")))
      .toEqual({ kind: "proxy", proxy: "http://proxy.example:8080" });
    expect(resolveProxyRoute(new URL("ws://private.example/"))).toEqual({ kind: "direct" });
  });

  test("the all-host wildcard has the same bypass scope on both transports", () => {
    process.env.no_proxy = "lower.example";
    applyProxyEnvWith(config("auto"), {
      platform: "darwin",
      macOSReader: () => scutil(`${both}\nExceptionsList : <array> {\n0 : *\n}`),
    });
    expect(process.env.NO_PROXY?.split(",")).toContain("*");
    expect(process.env.no_proxy?.split(",")).toContain("*");
  });

  test("default macOS exceptions activate .local without routing link-local literals direct", () => {
    process.env.NO_PROXY = "upper.example";
    process.env.no_proxy = "lower.example";
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); };
    try {
      applyProxyEnvWith(config("auto"), {
        platform: "darwin",
        macOSReader: () => scutil(`${both}\nExceptionsList : <array> {\n0 : *.local\n1 : 169.254/16\n}`),
      });
    } finally { console.log = original; }
    expect(process.env.HTTP_PROXY).toBe("http://proxy.example:8080");
    expect(process.env.NO_PROXY?.split(",")).toContain(".local");
    expect(process.env.no_proxy?.split(",")).toContain(".local");
    expect(process.env.NO_PROXY).not.toContain("169.254/16");
    expect(process.env.no_proxy).not.toContain("169.254/16");
    expect(lines.filter(line => line.includes("link-local"))).toHaveLength(1);
    expect(lines.join(" ")).not.toContain("169.254/16");
    for (const hostname of ["foo.local", "a.b.local", "local"]) {
      const url = new URL(`http://${hostname}/`);
      expect(noProxyMatches(url, { no_proxy: process.env.no_proxy })).toBe(true);
      expect(resolveProxyRoute(new URL(`ws://${hostname}/`))).toEqual({ kind: "direct" });
    }
    for (const hostname of ["xlocal", "169.254.1.2"]) {
      const url = new URL(`http://${hostname}/`);
      expect(noProxyMatches(url, { no_proxy: process.env.no_proxy })).toBe(false);
      expect(resolveProxyRoute(new URL(`ws://${hostname}/`))).toEqual({ kind: "proxy", proxy: process.env.HTTP_PROXY });
    }
  });

  test.each(["169.254/16", "169.254.0.0/16", "fe80::/10", "FE80:0:0:0:0:0:0:0/10", "[fe80::]/10"])(
    "drops only the exact link-local range %s", exception => {
      expect(readMacOSSystemProxy(() => scutil(`${both}\nExceptionsList : <array> {\n0 : ${exception}\n}`)))
        .toEqual({ kind: "proxy", httpUrl: "http://proxy.example:8080", httpsUrl: "http://[::1]:8443", exceptions: [], droppedLinkLocal: true });
    },
  );

  test.each(["HTTP", "HTTPS"])("preserves %s-only settings", scheme => {
    applyProxyEnvWith(config(" AUTO "), {
      platform: "darwin",
      macOSReader: () => scutil(`${scheme}Enable : 1\n${scheme}Proxy : 127.0.0.1\n${scheme}Port : 7890`),
    });
    expect(process.env[`${scheme}_PROXY`]).toBe("http://127.0.0.1:7890");
    expect(process.env[scheme === "HTTP" ? "HTTPS_PROXY" : "HTTP_PROXY"]).toBeUndefined();
  });

  test.each([
    "localhost", "example.com", "bad entry", "10.0.0.0/8", "169.254.0.0/15",
    "fe80::/9", "fe80::1/10", "*.*.local", "foo*.local", "*.bad_name", "*.",
  ])("refuses an unrepresentable exception %s without any environment write", exception => {
    process.env.NO_PROXY = "upper.example";
    process.env.no_proxy = "lower.example";
    const before = snapshot();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); };
    try {
      applyProxyEnvWith(config("auto", "configured.example"), {
        platform: "darwin",
        macOSReader: () => scutil(`${both}\nExceptionsList : <array> {\n0 : ${exception}\n}`),
      });
    } finally { console.log = original; }
    expect(snapshot()).toEqual(before);
    expect(lines.join(" ")).toContain("discovery refused");
    expect(lines.join(" ")).not.toContain(exception);
  });

  test.each([
    ["disabled", "HTTPEnable : 0"],
    ["bad port", "HTTPEnable : 1\nHTTPProxy : proxy.example\nHTTPPort : 0"],
    ["bad enable", `${both}\nHTTPEnable : maybe`],
    ["bad syntax", "HTTPEnable : 1\nHTTPProxy : proxy.example\nHTTPPort : 8080\nExceptionsList : <array> {\n0 : 127.0.0.1"],
    ["SOCKS-only", "SOCKSEnable : 1\nSOCKSProxy : socks.example\nSOCKSPort : 1080"],
    ["scoped-only", `__SCOPED__ : <dictionary> {\nen0 : <dictionary> {\n${both}\n}\n}`],
    ["simple host bypass", `${both}\nExcludeSimpleHostnames : 1`],
    ["PAC", `${both}\nProxyAutoConfigEnable : 1`],
  ])("%s settings leave egress unchanged", (_case, body) => {
    process.env.NO_PROXY = "upper.example";
    process.env.no_proxy = "lower.example";
    const before = snapshot();
    applyProxyEnvWith(config("auto"), { platform: "darwin", macOSReader: () => scutil(body) });
    expect(snapshot()).toEqual(before);
  });

  test("a failed scutil read leaves egress unchanged", () => {
    const before = snapshot();
    applyProxyEnvWith(config("auto"), { platform: "darwin", macOSReader: () => { throw new Error("secret"); } });
    expect(snapshot()).toEqual(before);
    expect(readMacOSSystemProxy(() => "garbage")).toEqual({ kind: "unreadable" });
  });

  test("a credential-shaped system proxy host is rejected without logging it", () => {
    const before = snapshot();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); };
    try {
      applyProxyEnvWith(config("auto"), {
        platform: "darwin",
        macOSReader: () => scutil("HTTPEnable : 1\nHTTPProxy : user:secret@proxy\nHTTPPort : 8080"),
      });
    } finally { console.log = original; }
    expect(snapshot()).toEqual(before);
    expect(lines.join(" ")).not.toContain("secret");
  });

  test("proxy unset never consults the system and leaves a proxy-free environment alone", () => {
    let called = false;
    const before = snapshot();
    applyProxyEnvWith(config(), { platform: "darwin", macOSReader: () => { called = true; return scutil(both); } });
    expect(called).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  test.each(["HTTP_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])("inherited %s wins without system discovery", key => {
    process.env[key] = key.toLowerCase().includes("all") ? "socks5h://socks.example:1080" : "http://inherited.example:8080";
    process.env.NO_PROXY = "upper.example";
    process.env.no_proxy = "lower.example";
    const before = snapshot();
    let called = false;
    applyProxyEnvWith(config("auto"), { platform: "darwin", macOSReader: () => { called = true; return scutil(both); } });
    expect(called).toBe(false);
    expect(snapshot()).toEqual(before);
    if (caseSensitiveEnv && key.toLowerCase().includes("all")) {
      // SOCKS wrapper reads uppercase; Bun's native HTTP transport reads lowercase.
      expect(resolveProxyRoute(new URL("http://upper.example"))).toEqual({ kind: "direct" });
      expect(resolveProxyRoute(new URL("http://lower.example")).kind).toBe("fallback");
    }
  });

  test.skipIf(!caseSensitiveEnv)("mixed inherited SOCKS and HTTP routes keep their distinct bypass decisions", () => {
    process.env.ALL_PROXY = "socks5h://socks.example:1080";
    process.env.HTTP_PROXY = "http://http.example:8080";
    process.env.NO_PROXY = "upper.example";
    process.env.no_proxy = "lower.example";
    const before = snapshot();
    applyProxyEnvWith(config("auto"), { platform: "darwin", macOSReader: () => { throw new Error("must not read"); } });
    expect(snapshot()).toEqual(before);
    for (const [hostname, socksBypass, bunBypass] of [
      ["upper.example", true, false],
      ["lower.example", false, true],
    ] as const) {
      const url = new URL(`http://${hostname}/`);
      expect(noProxyMatches(url, { NO_PROXY: process.env.NO_PROXY })).toBe(socksBypass);
      expect(noProxyMatches(url, { no_proxy: process.env.no_proxy })).toBe(bunBypass);
    }
  });

  test.skipIf(process.platform === "win32")("Bun's lowercase bypass and the WebSocket route's uppercase bypass remain distinct", () => {
    process.env.HTTP_PROXY = "http://http.example:8080";
    process.env.NO_PROXY = "upper.example.com";
    process.env.no_proxy = "lower.example.com";
    const before = snapshot();
    applyProxyEnvWith(config("auto"), { platform: "darwin", macOSReader: () => { throw new Error("must not read"); } });
    expect(snapshot()).toEqual(before);
    const upper = new URL("http://upper.example.com/");
    const lower = new URL("http://lower.example.com/");
    // Bun uses the non-empty lowercase value; resolveProxyRoute uses uppercase
    // even when that key is explicitly defined as an empty string.
    expect(noProxyMatches(upper, { no_proxy: process.env.no_proxy })).toBe(false);
    expect(noProxyMatches(lower, { no_proxy: process.env.no_proxy })).toBe(true);
    expect(resolveProxyRoute(new URL("ws://upper.example.com/"))).toEqual({ kind: "direct" });
    expect(resolveProxyRoute(new URL("ws://lower.example.com/"))).toEqual({ kind: "proxy", proxy: process.env.HTTP_PROXY });
    process.env.NO_PROXY = "";
    expect(resolveProxyRoute(new URL("ws://lower.example.com/"))).toEqual({ kind: "proxy", proxy: process.env.HTTP_PROXY });
  });

  test("the outbound proxy matcher does not widen localhost to app.localhost", () => {
    process.env.no_proxy = "lower.example";
    applyProxyEnvWith(config("auto"), {
      platform: "darwin",
      macOSReader: () => scutil("HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 8080"),
    });
    expect(process.env.no_proxy).not.toContain("localhost");
    for (const hostname of ["localhost", "app.localhost"]) {
      const url = new URL(`http://${hostname}:12345/`);
      expect(noProxyMatches(url, { no_proxy: process.env.no_proxy })).toBe(false);
      expect(resolveProxyRoute(url, { HTTP_PROXY: process.env.HTTP_PROXY, no_proxy: process.env.no_proxy }))
        .toEqual({ kind: "proxy", proxy: "http://127.0.0.1:8080" });
    }
  });
});
