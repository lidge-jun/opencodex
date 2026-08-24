import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HubConfig } from "../hub/src/config";
import { loadHubConfig, validateHubConfig } from "../hub/src/config";
import { HUB_CLIENT_IP_HEADER, resolveNetworkSubject } from "../hub/src/network";
import { HubService } from "../hub/src/server";

function config(): HubConfig {
  return {
    databasePath: "/tmp/hubapi-network-test.sqlite",
    digestSecret: "network-test-digest-secret-with-at-least-32-bytes",
    publicOrigin: "http://127.0.0.1:10400",
    hostname: "127.0.0.1",
    port: 10400,
    allowRegistration: false,
    sessionTtlSeconds: 3600,
    development: true,
    trustLoopbackProxy: false,
    opencodexOrigin: "http://127.0.0.1:10100",
    internalAdmissionToken: "network-test-admission-token-with-at-least-32-bytes",
    requestCostUnits: 100,
    pricingVersion: "network-test-v1",
    upstreamTimeoutMs: 5_000,
  };
}

describe("hub trusted reverse-proxy boundary", () => {
  test("production proxy trust requires an https origin and a loopback listener", () => {
    const production = {
      ...config(),
      development: false,
      trustLoopbackProxy: true,
      publicOrigin: "https://hubapi.example.test",
    };
    expect(validateHubConfig(production)).toMatchObject({ hostname: "127.0.0.1", trustLoopbackProxy: true });
    expect(() => validateHubConfig({ ...production, hostname: "0.0.0.0" })).toThrow("requires a loopback hub bind");
    expect(() => validateHubConfig({ ...config(), trustLoopbackProxy: true })).toThrow("production-only");
  });

  test("loads proxy trust only from an explicit environment switch", () => {
    const base = config();
    const loaded = loadHubConfig({
      HUB_DATABASE_PATH: base.databasePath,
      HUB_DIGEST_SECRET: base.digestSecret,
      HUB_PUBLIC_ORIGIN: "https://hubapi.example.test",
      HUB_HOSTNAME: "127.0.0.1",
      HUB_TRUST_LOOPBACK_PROXY: "1",
      HUB_OPENCODEX_ORIGIN: base.opencodexOrigin,
      HUB_INTERNAL_ADMISSION_TOKEN: base.internalAdmissionToken,
      HUB_REQUEST_COST_UNITS: String(base.requestCostUnits),
      HUB_PRICING_VERSION: base.pricingVersion,
    });
    expect(loaded.trustLoopbackProxy).toBe(true);
  });

  test("ignores forwarded identity in direct mode", () => {
    const request = new Request("https://hubapi.example.test/hub/health", { headers: { [HUB_CLIENT_IP_HEADER]: "198.51.100.9" } });
    expect(resolveNetworkSubject(config(), request, "203.0.113.4")).toBe("203.0.113.4");
  });

  test("trusts one valid client IP only across a loopback socket", () => {
    const trusted = { ...config(), development: false, trustLoopbackProxy: true, publicOrigin: "https://hubapi.example.test" };
    const request = new Request("https://hubapi.example.test/hub/health", { headers: { [HUB_CLIENT_IP_HEADER]: "198.51.100.9" } });
    expect(resolveNetworkSubject(trusted, request, "127.0.0.1")).toBe("198.51.100.9");
    expect(resolveNetworkSubject(trusted, request, "::ffff:127.0.0.1")).toBe("198.51.100.9");
    expect(resolveNetworkSubject(trusted, request, "203.0.113.5")).toBeNull();
    expect(resolveNetworkSubject(trusted, new Request(request.url), "127.0.0.1")).toBeNull();
    const chain = new Request(request.url, { headers: { [HUB_CLIENT_IP_HEADER]: "198.51.100.9, 127.0.0.1" } });
    expect(resolveNetworkSubject(trusted, chain, "127.0.0.1")).toBeNull();
  });

  test("the live trusted-proxy listener rejects missing evidence before dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hubapi-network-listener-"));
    const service = new HubService({
      ...config(),
      databasePath: join(directory, "hub.sqlite"),
      port: 0,
      development: false,
      trustLoopbackProxy: true,
      publicOrigin: "https://hubapi.example.test",
    });
    try {
      const server = service.start();
      const healthUrl = new URL("/hub/health", server.url);
      const rejected = await fetch(healthUrl);
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toEqual({ error: "untrusted_proxy" });
      const accepted = await fetch(healthUrl, { headers: { [HUB_CLIENT_IP_HEADER]: "198.51.100.9" } });
      expect(accepted.status).toBe(200);
    } finally {
      service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("checked-in deployment firewall", () => {
  test("Caddy exposes only the portal and four public inference routes", () => {
    const source = readFileSync("hub/deploy/Caddyfile.example", "utf8");
    for (const path of ["/hub", "/hub/*", "/v1/responses", "/v1/chat/completions", "/v1/messages", "/v1/models"]) {
      expect(source).toContain(path);
    }
    expect(source).toContain("reverse_proxy 127.0.0.1:10400");
    expect(source).toContain("header_up X-Hubapi-Client-IP {remote_host}");
    expect(source).toContain("respond 404");
    expect(source).not.toMatch(/\/api\/\*/);
  });

  test("nftables accepts loopback before dropping both private service ports", () => {
    const source = readFileSync("hub/deploy/hubapi-guard.nft", "utf8");
    expect(source).toContain('iifname "lo" accept');
    expect(source).toContain("tcp dport { 10100, 10400 }");
    expect(source).toContain("counter drop");
    expect(source.indexOf('iifname "lo" accept')).toBeLessThan(source.indexOf("counter drop"));
    expect(source).not.toContain("flush ruleset");
  });
});
