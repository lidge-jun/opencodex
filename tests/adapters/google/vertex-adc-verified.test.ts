import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetVertexTokenCache, getVertexAccessToken } from "../../../src/lib/gcp-adc";
import { safeConfigDTO } from "../../../src/server/auth-cors";
import { staticCatalogConnectionTest } from "../../../src/server/management/static-catalog-probe";
import { binProviderStatus, usesUnverifiedVertexCredentials } from "../../../gui/src/provider-workspace/catalog";
import { authModeLabel } from "../../../gui/src/components/provider-workspace/ProviderRail";
import { buildConnectionProbeKey } from "../../../gui/src/components/provider-workspace/use-provider-probe-state";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import * as apiKeyResolve from "../../../src/providers/api-key-resolve";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ENV_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY", "CLOUDSDK_CONFIG", "GOOGLE_VERTEX_REFRESH_SKEW_MS"];
const VERTEX = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", project: "demo", location: "global", liveModels: false } as OcxProviderConfig;

let gcloudDir: string;
let realFetch: typeof fetch;
let tokenStatus = 200;
let tokenBody: unknown = { access_token: "vertex-tok", expires_in: 3600 };
let tokenRequests = 0;
let saved: Record<string, string | undefined> = {};

function writeUserAdc(refreshToken: string): void {
  writeFileSync(join(gcloudDir, "application_default_credentials.json"),
    JSON.stringify({ type: "authorized_user", client_id: "fixture", client_secret: "fixture", refresh_token: refreshToken }));
}

function dashboardVertex(row: OcxProviderConfig = VERTEX): Record<string, unknown> {
  const config = { port: 0, defaultProvider: "google-vertex", providers: { "google-vertex": row } } as OcxConfig;
  return (safeConfigDTO(config) as { providers: Record<string, Record<string, unknown>> }).providers["google-vertex"]!;
}

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url !== OAUTH_TOKEN_URL) return new Response("nope", { status: 404 });
    tokenRequests += 1;
    return tokenStatus === 200
      ? new Response(JSON.stringify(tokenBody), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ error: "invalid_grant" }), { status: tokenStatus, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterAll(() => { globalThis.fetch = realFetch; });

beforeEach(() => {
  gcloudDir = mkdtempSync(join(tmpdir(), "ocx-vertex-verified-"));
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.CLOUDSDK_CONFIG = gcloudDir;
  tokenStatus = 200;
  tokenBody = { access_token: "vertex-tok", expires_in: 3600 };
  tokenRequests = 0;
});

afterEach(() => {
  __resetVertexTokenCache();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  removeTreeWithRetry(gcloudDir);
});

describe("Vertex ADC verification", () => {
  test("a gcloud ADC login reads unverified until a token is minted, then verified", async () => {
    writeUserAdc("fixture-refresh");
    const before = dashboardVertex();
    expect(before.vertexCredentialKind).toBe("ambient");
    expect(before.vertexCredentialVerified).toBe(false);
    expect(usesUnverifiedVertexCredentials({ name: "google-vertex", ...before } as never)).toBe(true);

    await getVertexAccessToken();
    const after = dashboardVertex();
    expect(after.vertexCredentialVerified).toBe(true);
    expect(usesUnverifiedVertexCredentials({ name: "google-vertex", ...after } as never)).toBe(false);
    expect(binProviderStatus({ name: "google-vertex", ...after, hasApiKey: false } as never)).toBe("ready");
  });

  test("replacing the ADC file drops the earlier proof", async () => {
    writeUserAdc("fixture-refresh");
    await getVertexAccessToken();
    writeUserAdc("fixture-other-login");
    expect(dashboardVertex().vertexCredentialVerified).toBe(false);
  });

  test("a refused refresh after the cached token expires drops the proof", async () => {
    writeUserAdc("fixture-refresh");
    let clock = Date.now();
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    try {
      tokenBody = { access_token: "vertex-tok", expires_in: 120 };
      await getVertexAccessToken();
      // Past the token's expiry less the 60 s refresh skew, with the proof still standing.
      clock += 61_000;
      expect(dashboardVertex().vertexCredentialVerified).toBe(true);
      tokenStatus = 400;
      await expect(getVertexAccessToken()).rejects.toThrow();
      expect(tokenRequests).toBe(2);
      expect(dashboardVertex().vertexCredentialVerified).toBe(false);
    } finally { now.mockRestore(); }
  });

  test.each([undefined, "N/A"])("an ambient row (apiKey %p) that sends GOOGLE_CLOUD_API_KEY never reads verified from an ADC token", async apiKey => {
    writeUserAdc("fixture-refresh");
    await getVertexAccessToken();
    const row = { ...VERTEX, ...(apiKey === undefined ? {} : { apiKey }) };
    expect(dashboardVertex(row).vertexCredentialVerified).toBe(true);
    process.env.GOOGLE_CLOUD_API_KEY = "fixture-ambient-key";
    const item = dashboardVertex(row);
    expect(item.vertexCredentialKind).toBe("ambient");
    expect(item.vertexCredentialVerified).toBeUndefined();
    expect(binProviderStatus({ name: "google-vertex", ...item, hasApiKey: false } as never)).not.toBe("ready");
  });

  test("an older exchange failing after the source changed keeps the newer exchange's proof", async () => {
    writeUserAdc("fixture-first-login");
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstSent!: () => void;
    const firstStarted = new Promise<void>(resolve => { firstSent = resolve; });
    const heldFetch = (async () => {
      firstSent();
      await firstHeld;
      return new Response(JSON.stringify({ access_token: "vertex-tok", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const first = getVertexAccessToken({ fetch: heldFetch });
    await firstStarted;
    // The credential file changes mid-exchange; a second exchange for the new source succeeds first.
    writeUserAdc("fixture-second-login-replaced");
    await getVertexAccessToken();
    expect(dashboardVertex().vertexCredentialVerified).toBe(true);
    releaseFirst();
    await expect(first).rejects.toThrow("source changed");
    expect(dashboardVertex().vertexCredentialVerified).toBe(true);
  });

  test("connection test on a static-catalog Vertex row verifies ADC instead of skipping it", async () => {
    writeUserAdc("fixture-refresh");
    const result = await staticCatalogConnectionTest("google-vertex", VERTEX);
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain("vertex-tok");
    expect(dashboardVertex().vertexCredentialVerified).toBe(true);
  });

  test("connection test reports a failed ADC exchange", async () => {
    writeUserAdc("fixture-refresh");
    tokenStatus = 400;
    expect(await staticCatalogConnectionTest("google-vertex", VERTEX)).toMatchObject({ ok: false });
  });

  test("connection test exchanges again instead of trusting a cached token, and inference keeps the cache", async () => {
    writeUserAdc("fixture-refresh");
    expect(await staticCatalogConnectionTest("google-vertex", VERTEX)).toMatchObject({ ok: true });
    expect(tokenRequests).toBe(1);
    // The refresh credential is revoked while the token it minted is still cached.
    tokenStatus = 400;
    expect(await staticCatalogConnectionTest("google-vertex", VERTEX)).toMatchObject({ ok: false });
    expect(tokenRequests).toBe(2);
    expect(dashboardVertex().vertexCredentialVerified).toBe(false);
    // An ordinary caller is not forced: it is served from the cache with no further exchange.
    expect(await getVertexAccessToken()).toBe("vertex-tok");
    expect(tokenRequests).toBe(2);
  });

  test.each([{}, { access_token: "", expires_in: 3600 }, { access_token: 7, expires_in: 3600 }])(
    "a 200 token response without a usable access_token %p is not verified and the probe fails", async body => {
      writeUserAdc("fixture-refresh");
      tokenBody = body;
      await expect(getVertexAccessToken()).rejects.toThrow("no access_token");
      expect(dashboardVertex().vertexCredentialVerified).toBe(false);
      expect(await staticCatalogConnectionTest("google-vertex", VERTEX)).toMatchObject({ ok: false });
      expect(dashboardVertex().vertexCredentialVerified).toBe(false);
    });

  test.each(["keychain:vertex-fixture", "${VERTEX_FIXTURE_KEY}"])(
    "a reference row %p answers static_catalog without reading the credential store", async reference => {
      const resolve = spyOn(apiKeyResolve, "resolveProviderApiKey").mockReturnValue(undefined);
      try {
        expect(await staticCatalogConnectionTest("google-vertex", { ...VERTEX, apiKey: reference }))
          .toEqual({ applicable: false, reason: "static_catalog", latencyMs: 0 });
        expect(resolve).not.toHaveBeenCalled();
      } finally { resolve.mockRestore(); }
    });

  test("other static catalogs still skip credential resolution", async () => {
    const antigravity = { adapter: "google", baseUrl: "https://cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist", liveModels: false } as OcxProviderConfig;
    expect(await staticCatalogConnectionTest("google-antigravity", antigravity)).toEqual({ applicable: false, reason: "static_catalog", latencyMs: 0 });
    expect(await staticCatalogConnectionTest("google-vertex", { ...VERTEX, apiKey: "fixture-key" })).toEqual({ applicable: false, reason: "static_catalog", latencyMs: 0 });
  });

  test("a verified ADC row still reads as host credentials, not an API key", async () => {
    writeUserAdc("fixture-refresh");
    await getVertexAccessToken();
    const item = { name: "google-vertex", ...dashboardVertex() } as Parameters<typeof authModeLabel>[0];
    expect(item.vertexCredentialVerified).toBe(true);
    expect(authModeLabel(item, (key => key) as Parameters<typeof authModeLabel>[1])).toBe("pws.vertexHostAuth");
  });

  test("a server-side verification change discards a retained connection probe result", async () => {
    writeUserAdc("fixture-refresh");
    const unverified = { name: "google-vertex", ...dashboardVertex() } as Parameters<typeof buildConnectionProbeKey>[1];
    await getVertexAccessToken();
    const verified = { name: "google-vertex", ...dashboardVertex() } as Parameters<typeof buildConnectionProbeKey>[1];
    expect(buildConnectionProbeKey("http://127.0.0.1", verified)).not.toBe(buildConnectionProbeKey("http://127.0.0.1", unverified));
  });
});
