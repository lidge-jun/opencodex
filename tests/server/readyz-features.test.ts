/**
 * OCX-3: `GET /readyz` advertises peer features from one registry (`src/remote/features.ts`).
 * Presence and absence follow each owning source, the ids survive the peer-side parser, and the
 * unauthenticated body carries static ids only. The served-by case checks the advertisement
 * against real responses, so the emitter's flag cannot claim a header that is not sent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { LINK_MANAGEMENT_READ_PATHS } from "../../src/link/management-routes";
import { LINK_RELAY_AUTH_VERSION } from "../../src/link/relay-auth";
import { ensureQuotaPoolIdentity } from "../../src/quota-pool/identity";
import {
  buildPeerFeatures,
  currentPeerFeatureSources,
  FALLBACK_STATE_PATH,
  PEER_FEATURES,
  QUOTA_POOL_PATH,
  servedPeerFeatures,
  type PeerFeatureSources,
} from "../../src/remote/features";
import { parseRemoteReadyMetadata, readyProtocolMetadata } from "../../src/remote/protocol";
import { SERVED_BY_HEADER, SERVED_BY_HEADER_EMITTED } from "../../src/remote/served-by";
import { startServer } from "../../src/server";
import { MANAGEMENT_ROUTES } from "../../src/server/management/route-registry";
import { createReadinessGate } from "../../src/server/readiness";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const none: PeerFeatureSources = {
  managementRoutes: [],
  linkManagementReadPaths: [],
  servedByHeaderEmitted: false,
  relayAuthVersion: "2",
  linkPeerReportVersion: "1",
};
const all: PeerFeatureSources = {
  managementRoutes: [{ method: "GET", path: QUOTA_POOL_PATH }, { method: "GET", path: FALLBACK_STATE_PATH }],
  linkManagementReadPaths: ["/api/settings"],
  servedByHeaderEmitted: true,
  relayAuthVersion: "2",
  linkPeerReportVersion: "1",
};

describe("peer feature registry", () => {
  test("presence and absence follow each owning source", () => {
    expect(servedPeerFeatures(none)).toEqual(["relay-auth/2", "link-peer-report/1"]);
    expect(servedPeerFeatures(all)).toEqual(["quota-pool/1", "fallback-policy/1", "link-management-relay", "served-by-header", "relay-auth/2", "link-peer-report/1"]);
    expect(servedPeerFeatures({ ...none, managementRoutes: [{ method: "PUT", path: FALLBACK_STATE_PATH }] })).toEqual(["relay-auth/2", "link-peer-report/1"]);
    expect(servedPeerFeatures({ ...none, managementRoutes: [{ method: "POST", path: QUOTA_POOL_PATH }] })).toEqual(["relay-auth/2", "link-peer-report/1"]);
    expect(servedPeerFeatures({ ...none, managementRoutes: [{ method: "GET", path: "/api/quota-pool/extra" }] })).toEqual(["relay-auth/2", "link-peer-report/1"]);
    expect(servedPeerFeatures({ ...none, relayAuthVersion: "3", linkPeerReportVersion: "2" })).toEqual(["relay-auth/3", "link-peer-report/2"]);
  });

  test("this build reads the live sources", () => {
    const features = buildPeerFeatures();
    expect(features).toEqual(servedPeerFeatures(currentPeerFeatureSources()));
    expect(features.includes("quota-pool/1"))
      .toBe(MANAGEMENT_ROUTES.some(route => route.method === "GET" && route.path === QUOTA_POOL_PATH));
    expect(features.includes("fallback-policy/1"))
      .toBe(MANAGEMENT_ROUTES.some(route => route.method === "GET" && route.path === FALLBACK_STATE_PATH));
    expect(features.includes("link-management-relay")).toBe(LINK_MANAGEMENT_READ_PATHS.length > 0);
    expect(features.includes("served-by-header")).toBe(SERVED_BY_HEADER_EMITTED);
    expect(features).toContain(`relay-auth/${LINK_RELAY_AUTH_VERSION}`);
  });

  test("every id fits the peer-side parser", () => {
    const features = servedPeerFeatures(all);
    expect(features).toHaveLength(PEER_FEATURES.length);
    const metadata = { protocol: 1, minimumClientProtocol: 1, managementUrl: "https://hub.example.test" };
    expect(parseRemoteReadyMetadata({ ...metadata, features })?.features).toEqual(features);
    const live = readyProtocolMetadata(getDefaultConfig(), new Request("http://127.0.0.1/readyz"));
    expect(parseRemoteReadyMetadata(live)?.features).toEqual(buildPeerFeatures());
  });
});

describe("GET /readyz features on a live server", () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  let home = "";
  let codexHome: IsolatedCodexHome | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-readyz-features-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    codexHome = installIsolatedCodexHome("ocx-readyz-features-codex-");
    saveConfig(getDefaultConfig());
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
    codexHome?.restore();
    codexHome = null;
    removeTreeWithRetry(home);
  });

  test("the unauthenticated body lists the registry and nothing account-shaped", async () => {
    const server = startServer(0, { readinessGate: createReadinessGate() });
    try {
      const response = await fetch(new URL("/readyz", server.url));
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.features).toEqual(buildPeerFeatures());
      expect(JSON.stringify(body.features)).not.toMatch(/account|email|token|secret|acct|@/i);
    } finally {
      await server.stop(true);
    }
  });

  test("served-by-header is advertised exactly when responses carry the header", async () => {
    saveConfig({
      ...getDefaultConfig(),
      defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, liveModels: false, models: ["m"] } },
    });
    ensureQuotaPoolIdentity();
    const server = startServer(0, { readinessGate: createReadinessGate() });
    try {
      const readyz = await fetch(new URL("/readyz", server.url));
      const advertised = ((await readyz.json()) as { features: string[] }).features.includes("served-by-header");
      expect(advertised).toBe(SERVED_BY_HEADER_EMITTED);
      expect(advertised).toBe(true);
      const models = await fetch(new URL("/v1/models", server.url));
      expect(models.status).toBe(200);
      expect(models.headers.has(SERVED_BY_HEADER)).toBe(advertised);
      // The header names the Home on model discovery only; other routes stay unstamped.
      for (const response of [readyz, await fetch(new URL("/v1/opencodex-readyz-features-probe", server.url))]) {
        expect(response.headers.has(SERVED_BY_HEADER)).toBe(false);
      }
    } finally {
      await server.stop(true);
    }
  });
});
