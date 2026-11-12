/**
 * #8338: Remember this device on a standalone dashboard behind a reverse proxy, only through the
 * operator's `dashboardTrustedProxy`. The proxy hop is proven by the kernel-observed peer; the
 * browser's host and scheme come only from the headers the operator trusts, and any forwarded
 * value that contradicts the configured origin is refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { startServer } from "../../src/server";
import * as authCors from "../../src/server/auth-cors";
import { createManagementSessionControl, initializeManagementAuthState, issueGuiSession, requireManagementAuth } from "../../src/server/management-auth";
import type { ManagementContext } from "../../src/server/management/context";
import { handleSessionRoutes } from "../../src/server/management/session-routes";
import type { OcxConfig } from "../../src/types";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { remoteConfig } from "../helpers/management-auth-fixture";

const PUBLIC = "https://ocx.example.test";
const PROXY = "192.0.2.10";
type Proxy = NonNullable<OcxConfig["dashboardTrustedProxy"]>;
const keys = ["OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
let previous: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  home = mkdtempSync(join(tmpdir(), "ocx-dashboard-proxy-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  process.env.OPENCODEX_API_AUTH_TOKEN = "ocx_data_fixture";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx_admin_fixture";
});
afterEach(async () => {
  await drainAndRemoveFixtureRoots({ roots: [{ path: home }], restoreEnvironment: () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  } });
});

function withProxy(proxy: Partial<Proxy> | null = {}, base: OcxConfig = remoteConfig()): OcxConfig {
  return proxy === null ? base : { ...base, dashboardTrustedProxy: { origin: PUBLIC, proxyAddresses: [PROXY], ...proxy } as Proxy };
}

/** A request as the proxy delivers it: plain HTTP to this process, Host kept, browser Origin https. */
function proxied(path = "/api/session/remember", options: { peer?: string | null; headers?: Record<string, string>; method?: string } = {}) {
  const req = new Request("http://ocx.example.test" + path, { method: options.method ?? "POST", headers: {
    Host: "ocx.example.test", Origin: PUBLIC, "User-Agent": "proxy-fixture", "X-OpenCodex-API-Key": "ocx_admin_fixture",
    ...options.headers,
  } });
  const peer = options.peer === undefined ? PROXY : options.peer;
  if (peer !== null) authCors.markDashboardProxyPeer(req, peer);
  return req;
}

function remember(config: OcxConfig, req: Request) {
  const state = initializeManagementAuthState(config);
  const response = handleSessionRoutes({ req, url: new URL(req.url), config, principal: "admin-token",
    sessionControl: createManagementSessionControl(state) } as ManagementContext)!;
  return { state, response };
}

/** `sameOrigin`: the request does come from the configured origin, and only Remember refuses it. */
async function expectRefused(config: OcxConfig, req: Request, sameOrigin = false) {
  const { response } = remember(config, req);
  expect(response.status).toBe(403);
  expect((await response.json()).code).toBe("remember_requires_direct_origin");
  expect(response.headers.get("set-cookie")).toBeNull();
  if (!sameOrigin) {
    expect(authCors.isAllowedManagementOrigin(req, config) && authCors.managementRequestOrigin(req, config) === PUBLIC).toBe(false);
  }
}

describe("without the setting", () => {
  test("a proxied request still cannot remember the device", async () => {
    await expectRefused(withProxy(null), proxied());
  });
});

describe("through the configured proxy", () => {
  test("Remember issues a Secure host-only device for the configured origin, which resumes and authorizes", async () => {
    const config = withProxy();
    const req = proxied();
    expect(authCors.managementRequestOrigin(req, config)).toBe(PUBLIC);
    expect(authCors.isAllowedManagementOrigin(req, config)).toBe(true);
    const { state, response } = remember(config, req);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toStartWith("__Host-ocx_dashboard_");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    const { device } = await response.json();
    const pair = cookie.split(";")[0]!;
    const resumed = issueGuiSession(proxied("/opencodex-session", { method: "GET",
      headers: { Cookie: pair, "X-OpenCodex-Device-Proof": device.proof } }), config, initializeManagementAuthState(config));
    expect(resumed?.issuance).toBe("remembered-admin");
    const resumedState = initializeManagementAuthState(config);
    const session = issueGuiSession(proxied("/opencodex-session", { method: "GET",
      headers: { Cookie: pair, "X-OpenCodex-Device-Proof": device.proof } }), config, resumedState)!;
    const read = proxied("/api/config", { method: "GET", headers: { Cookie: pair, "X-OpenCodex-API-Key": session.token, "X-OpenCodex-GUI-Origin": PUBLIC } });
    expect(requireManagementAuth(read, resumedState, config)).toBeNull();
    // The same cookie and proof from a client that is not the proxy resume nothing.
    expect(issueGuiSession(proxied("/opencodex-session", { method: "GET", peer: "192.0.2.99",
      headers: { Cookie: pair, "X-OpenCodex-Device-Proof": device.proof } }), config, state)).toBeNull();
  });

  test("a mapped IPv4 peer matches its IPv4 address", () => {
    const { response } = remember(withProxy(), proxied("/api/session/remember", { peer: "::ffff:192.0.2.10" }));
    expect(response.status).toBe(200);
  });

  test("trusting X-Forwarded-Host reads the browser host from it, never from Host", async () => {
    const config = withProxy({ trustHeaders: ["x-forwarded-host"] });
    const upstream = { Host: "pc-a.internal:10100" };
    expect(remember(config, proxied(undefined, { headers: { ...upstream, "X-Forwarded-Host": "ocx.example.test" } })).response.status).toBe(200);
    await expectRefused(config, proxied(undefined, { headers: upstream }));
  });

  test("trusting X-Forwarded-Proto requires it to say https", async () => {
    const config = withProxy({ trustHeaders: ["x-forwarded-proto"] });
    expect(remember(config, proxied(undefined, { headers: { "X-Forwarded-Proto": "https" } })).response.status).toBe(200);
    await expectRefused(config, proxied());
  });
});

describe("refusals", () => {
  const cases: Array<[string, Partial<Proxy> | null, Parameters<typeof proxied>[1]]> = [
    ["a client that is not the proxy, even with matching forwarded headers", {},
      { peer: "192.0.2.99", headers: { "X-Forwarded-Host": "ocx.example.test", "X-Forwarded-Proto": "https" } }],
    ["a request with no observed peer", {}, { peer: null }],
    ["a forged X-Forwarded-Proto: http", {}, { headers: { "X-Forwarded-Proto": "http" } }],
    ["a forged X-Forwarded-Host naming another site", {}, { headers: { "X-Forwarded-Host": "evil.example.test" } }],
    ["a chained X-Forwarded-Host", { trustHeaders: ["x-forwarded-host"] }, { headers: { "X-Forwarded-Host": "evil.example.test, ocx.example.test" } }],
    ["a chained X-Forwarded-Proto", {}, { headers: { "X-Forwarded-Proto": "http, https" } }],
    ["a Host that is not the configured origin", {}, { headers: { Host: "other.example.test" } }],
    ["a browser Origin that is not the configured origin", {}, { headers: { Origin: "https://evil.example.test" } }],
    ["an http browser Origin for the same host", {}, { headers: { Origin: "http://ocx.example.test" } }],
    ["an http origin written straight into the live config", { origin: "http://ocx.example.test" }, {}],
    ["a wildcard origin written straight into the live config", { origin: "https://*.example.test" }, {}],
    ["an address range written straight into the live config", { proxyAddresses: ["192.0.2.0/24"] }, {}],
    ["a wildcard address written straight into the live config", { proxyAddresses: ["*"] }, {}],
  ];
  for (const [name, proxy, options] of cases) {
    test(name, async () => { await expectRefused(withProxy(proxy), proxied(undefined, options)); });
  }

  test("a cross-site fetch from the configured origin still cannot remember", async () => {
    await expectRefused(withProxy(), proxied(undefined, { headers: { "Sec-Fetch-Site": "cross-site" } }), true);
  });

  test("a loopback bind or a non-standalone role never honors the setting", async () => {
    await expectRefused(withProxy({}, { ...remoteConfig(), hostname: "127.0.0.1" }), proxied());
    await expectRefused(withProxy({}, { ...remoteConfig(), runtimeRole: "client" }), proxied());
  });
});

describe("configuration", () => {
  const invalid: Array<[string, unknown]> = [
    ["http origin", { origin: "http://ocx.example.test", proxyAddresses: [PROXY] }],
    ["wildcard origin", { origin: "https://*.example.test", proxyAddresses: [PROXY] }],
    ["percent-encoded wildcard origin", { origin: "https://%2A.example.test", proxyAddresses: [PROXY] }],
    ["origin with a path", { origin: "https://ocx.example.test/dash", proxyAddresses: [PROXY] }],
    ["no proxy address", { origin: PUBLIC, proxyAddresses: [] }],
    ["address range", { origin: PUBLIC, proxyAddresses: ["192.0.2.0/24"] }],
    ["wildcard address", { origin: PUBLIC, proxyAddresses: ["*"] }],
    ["host name instead of an address", { origin: PUBLIC, proxyAddresses: ["proxy.internal"] }],
    ["Host listed as a header", { origin: PUBLIC, proxyAddresses: [PROXY], trustHeaders: ["host"] }],
    ["unknown field", { origin: PUBLIC, proxyAddresses: [PROXY], allowAll: true }],
  ];
  for (const [name, value] of invalid) {
    test(`a live write refuses ${name}`, () => {
      const result = validateConfigCandidate({ ...remoteConfig(), dashboardTrustedProxy: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("dashboardTrustedProxy");
    });
  }

  test("a malformed hand edit loads with the setting dropped, and a valid one loads intact", () => {
    const dropped = configSchema.parse({ ...remoteConfig(), dashboardTrustedProxy: { origin: "http://ocx.example.test", proxyAddresses: [PROXY] } });
    expect((dropped as OcxConfig).dashboardTrustedProxy).toBeUndefined();
    const kept = { origin: PUBLIC, proxyAddresses: [PROXY, "::1"], trustHeaders: ["x-forwarded-proto"] };
    expect(validateConfigCandidate({ ...remoteConfig(), dashboardTrustedProxy: kept }).ok).toBe(true);
    expect((configSchema.parse({ ...remoteConfig(), dashboardTrustedProxy: kept }) as OcxConfig).dashboardTrustedProxy).toEqual(kept as Proxy);
  });
});

describe("the real listener", () => {
  async function rememberThroughListener(proxyAddresses: string[]) {
    saveConfig(withProxy({ proxyAddresses }));
    const server = startServer(0);
    try {
      const url = new URL("/api/session/remember", server.url);
      const response = await fetch(url, { method: "POST", headers: { Host: "ocx.example.test", Origin: PUBLIC,
        "User-Agent": "proxy-fixture", "X-OpenCodex-API-Key": "ocx_admin_fixture" } });
      return { status: response.status, cookie: response.headers.get("set-cookie"), body: await response.json() as { code?: string } };
    } finally { await server.stop(true); }
  }

  test("records the connecting peer, so a listed proxy address remembers and an unlisted one is refused", async () => {
    const listed = await rememberThroughListener(["127.0.0.1", "::1"]);
    expect(listed.status).toBe(200);
    expect(listed.cookie).toStartWith("__Host-ocx_dashboard_");
    const unlisted = await rememberThroughListener([PROXY]);
    expect(unlisted.status).toBe(403);
    expect(unlisted.body.code).toBe("remember_requires_direct_origin");
  });
});
