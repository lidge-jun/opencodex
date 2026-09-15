import { afterEach, describe, expect, test } from "bun:test";
import {
  describeProviderEgressForLog,
  egressRequestUrl,
  InvalidProviderEgressError,
  providerEgressRouteKey,
  resolveProviderEgress,
  sanitizeProxyUrlForLog,
} from "../../src/lib/provider-egress";
import type { OcxProviderConfig } from "../../src/types";

type ProxyHolder = Pick<OcxProviderConfig, "proxy">;

function holder(proxy?: unknown): ProxyHolder {
  return proxy === undefined ? {} : { proxy: proxy as string };
}

const ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedEnv: Record<string, string | undefined>;

function clearProxyEnv(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

afterEach(() => {
  if (!savedEnv) return;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("provider egress contract", () => {
  test("absent proxy inherits the global path", () => {
    clearProxyEnv();
    expect(resolveProviderEgress({ providerName: "openai", provider: holder(), url: "https://api.example/v1" })).toEqual({ kind: "inherit" });
  });

  test("explicit undefined proxy inherits the global path", () => {
    clearProxyEnv();
    expect(resolveProviderEgress({ providerName: "openai", provider: { proxy: undefined }, url: "https://api.example/v1" })).toEqual({ kind: "inherit" });
  });

  test("http and https proxy URLs resolve to an explicit route", () => {
    clearProxyEnv();
    const http = resolveProviderEgress({ providerName: "xai", provider: holder("http://127.0.0.1:7897"), url: "https://api.example/v1" });
    const https = resolveProviderEgress({ providerName: "xai", provider: holder("https://proxy.example:8443"), url: "https://api.example/v1" });
    expect(http.kind).toBe("proxy");
    expect(https.kind).toBe("proxy");
    if (http.kind === "proxy" && https.kind === "proxy") {
      expect(http.proxyUrl).toContain("127.0.0.1:7897");
      expect(https.proxyUrl).toContain("proxy.example:8443");
      expect(http.routeKey).not.toBe(https.routeKey);
    }
  });

  test("distinct proxies and distinct credentials map to distinct route keys", () => {
    clearProxyEnv();
    const keyA = providerEgressRouteKey("http://127.0.0.1:8080");
    const keyB = providerEgressRouteKey("http://127.0.0.1:8081");
    const keyUser1 = providerEgressRouteKey("http://alice:s3cret-1@127.0.0.1:8080");
    const keyUser2 = providerEgressRouteKey("http://alice:s3cret-2@127.0.0.1:8080");
    expect(new Set([keyA, keyB, keyUser1, keyUser2]).size).toBe(4);
    for (const key of [keyA, keyB, keyUser1, keyUser2]) {
      expect(key).not.toContain("s3cret");
      expect(key).not.toContain("alice");
    }
  });

  test("log forms never carry proxy credentials", () => {
    clearProxyEnv();
    expect(sanitizeProxyUrlForLog("http://alice:s3cret-1@127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    const egress = resolveProviderEgress({ providerName: "xai", provider: holder("http://alice:s3cret-1@127.0.0.1:8080"), url: "https://api.example/v1" });
    const label = describeProviderEgressForLog(egress);
    expect(label).not.toContain("s3cret");
    expect(label).not.toContain("alice");
    expect(describeProviderEgressForLog({ kind: "inherit" })).toBe("inherit");
  });

  test("direct, null, empty, and whitespace fail closed", () => {
    clearProxyEnv();
    for (const proxy of ["direct", "DIRECT", " Direct ", "auto", "AUTO", null, "", "   "]) {
      expect(() => resolveProviderEgress({ providerName: "deepseek", provider: holder(proxy), url: "https://api.example/v1" })).toThrow(InvalidProviderEgressError);
    }
  });

  test("unknown schemes, socks, and garbage fail closed without echoing credentials", () => {
    clearProxyEnv();
    const bad = ["socks5://127.0.0.1:1080", "socks5://bob:s3cret-9@127.0.0.1:1080", "ftp://127.0.0.1:21", "not a url", "http://", "gopher://127.0.0.1:70"];
    for (const proxy of bad) {
      let message = "";
      try {
        resolveProviderEgress({ providerName: "xai", provider: holder(proxy), url: "https://api.example/v1" });
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidProviderEgressError);
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("s3cret");
    }
  });

  test("non-string proxy values fail closed", () => {
    clearProxyEnv();
    expect(() => resolveProviderEgress({ providerName: "xai", provider: { proxy: 8080 } as unknown as ProxyHolder, url: "https://api.example/v1" })).toThrow(InvalidProviderEgressError);
  });

  test("auto is deferred and fails closed even with a proxy snapshot present", () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    expect(() => resolveProviderEgress({ providerName: "openrouter", provider: holder("auto"), url: "https://api.example/v1" })).toThrow(InvalidProviderEgressError);
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    expect(() => resolveProviderEgress({ providerName: "openrouter", provider: holder("auto"), url: "https://api.example/v1" })).toThrow(InvalidProviderEgressError);
  });

  test("modelId is accepted for the future extension and ignored today", () => {
    clearProxyEnv();
    const egress = resolveProviderEgress({ providerName: "openrouter", modelId: "deepseek/deepseek-v4", provider: holder("http://127.0.0.1:7897"), url: "https://api.example/v1" });
    expect(egress.kind).toBe("proxy");
  });

  test("explicit provider proxy fails closed when the request URL is unparseable", () => {
    clearProxyEnv();
    expect(() =>
      resolveProviderEgress({ providerName: "xai", provider: holder("http://127.0.0.1:7897"), url: "not a url" })
    ).toThrow(InvalidProviderEgressError);
  });

  test("invalid explicit proxy still fails closed when the request URL is unparseable", () => {
    clearProxyEnv();
    expect(() =>
      resolveProviderEgress({ providerName: "xai", provider: holder("socks5://127.0.0.1:1080"), url: "not a url" })
    ).toThrow(InvalidProviderEgressError);
  });

  test("egressRequestUrl handles string, URL, and Request inputs", () => {
    expect(egressRequestUrl("https://api.example/v1")?.protocol).toBe("https:");
    expect(egressRequestUrl(new URL("https://api.example/v1"))?.host).toBe("api.example");
    expect(egressRequestUrl(new Request("https://api.example/v1"))?.pathname).toBe("/v1");
    expect(egressRequestUrl("not a url")).toBeNull();
  });
});
