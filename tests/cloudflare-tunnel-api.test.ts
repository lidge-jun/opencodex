import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import { storedCloudflareTunnelTokenPath } from "../src/server/cloudflare-setup";
import type {
  CloudflareTunnelController,
  CloudflareTunnelStatus,
} from "../src/server/cloudflare-tunnel";
import type { OcxConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const cloudflareEnvKeys = [
  "OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN",
  "OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN_FILE",
  "OPENCODEX_CLOUDFLARE_PUBLIC_URL",
] as const;
const previousCloudflareEnv = Object.fromEntries(
  cloudflareEnvKeys.map(key => [key, process.env[key]]),
) as Record<(typeof cloudflareEnvKeys)[number], string | undefined>;
const runnerToken = `eyJ${"r".repeat(64)}`;
const cloudflareApiToken = `cf-api-${"s".repeat(40)}`;
let testDir = "";

function config(withKey = true): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "test",
    providers: {
      test: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", models: ["model"] },
    },
    ...(withKey
      ? { apiKeys: [{ id: "id", name: "remote", key: "ocx_secret", createdAt: "2026-01-01T00:00:00.000Z" }] }
      : {}),
    cloudflareTunnel: { mode: "quick" },
  };
}

function stoppedStatus(): CloudflareTunnelStatus {
  return {
    status: "stopped",
    mode: "quick",
    publicUrl: null,
    supportsSse: false,
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1:54321${path}`, init);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "opencodex-cloudflare-api-"));
  process.env.OPENCODEX_HOME = testDir;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  for (const key of cloudflareEnvKeys) delete process.env[key];
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  for (const key of cloudflareEnvKeys) {
    const previous = previousCloudflareEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(testDir, { recursive: true, force: true });
});

describe("Cloudflare tunnel management API", () => {
  test("rejects non-object, malformed, and unknown-field request bodies", async () => {
    const controller = {
      getStatus: stoppedStatus,
      start: async () => stoppedStatus(),
      stop: async () => stoppedStatus(),
    } as unknown as CloudflareTunnelController;
    const cfg = config();

    for (const body of ["null", "[]", "true", '"enabled"', "not-json"]) {
      const req = request("/api/cloudflare-tunnel", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      const response = await handleManagementAPI(req, new URL(req.url), cfg, {
        cloudflareTunnel: controller,
        listenPort: 54321,
      });
      expect(response?.status).toBe(400);
    }

    const unknownReq = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, token: "must-not-be-accepted" }),
    });
    const unknownResponse = await handleManagementAPI(unknownReq, new URL(unknownReq.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 54321,
    });
    expect(unknownResponse?.status).toBe(400);
    expect(await unknownResponse?.json()).toEqual({ error: "unknown field: token" });

    const badModeReq = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, mode: "warp" }),
    });
    const badModeResponse = await handleManagementAPI(badModeReq, new URL(badModeReq.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 54321,
    });
    expect(badModeResponse?.status).toBe(400);
    expect(await badModeResponse?.json()).toEqual({ error: "mode must be quick or named" });
  });

  test("uses the live listener port and swaps the API endpoint only while running", async () => {
    let status = stoppedStatus();
    const starts: unknown[] = [];
    let stops = 0;
    const controller = {
      getStatus: () => status,
      start: async (options: unknown) => {
        starts.push(options);
        status = {
          status: "running",
          mode: "quick",
          publicUrl: "https://safe-name.trycloudflare.com",
          supportsSse: false,
          startedAt: "2026-07-22T00:00:00.000Z",
        };
        return status;
      },
      stop: async () => {
        stops += 1;
        status = stoppedStatus();
        return status;
      },
    } as unknown as CloudflareTunnelController;
    const cfg = config();
    const deps = { cloudflareTunnel: controller, listenPort: 54321 };

    const initial = await handleManagementAPI(request("/api/keys"), new URL("http://127.0.0.1:54321/api/keys"), cfg, deps);
    expect(initial?.status).toBe(200);
    expect(await initial?.json()).toMatchObject({
      endpoint: "http://127.0.0.1:54321/v1/responses",
      tunnel: { status: "stopped", publicUrl: null },
    });

    const enableReq = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const enabled = await handleManagementAPI(enableReq, new URL(enableReq.url), cfg, deps);
    expect(enabled?.status).toBe(200);
    expect(await enabled?.json()).toMatchObject({
      status: "running",
      endpoint: "https://safe-name.trycloudflare.com/v1/responses",
    });
    expect(starts).toEqual([{
      originUrl: "http://127.0.0.1:54321",
      actualPort: 54321,
      configuredPort: 10100,
      mode: "quick",
    }]);
    expect(cfg.cloudflareTunnel?.enabled).toBe(true);
    expect(loadConfig().cloudflareTunnel?.enabled).toBe(true);

    const keysWhileRunning = await handleManagementAPI(request("/api/keys"), new URL("http://127.0.0.1:54321/api/keys"), cfg, deps);
    expect(await keysWhileRunning?.json()).toMatchObject({
      endpoint: "https://safe-name.trycloudflare.com/v1/responses",
    });

    const disableReq = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const disabled = await handleManagementAPI(disableReq, new URL(disableReq.url), cfg, deps);
    expect(disabled?.status).toBe(200);
    expect(await disabled?.json()).toMatchObject({
      status: "stopped",
      endpoint: "http://127.0.0.1:54321/v1/responses",
    });
    expect(stops).toBe(1);
    expect(cfg.cloudflareTunnel?.enabled).toBe(false);
    expect(loadConfig().cloudflareTunnel?.enabled).toBe(false);
  });

  test("refuses to publish an endpoint that has no admission secret", async () => {
    let starts = 0;
    const controller = {
      getStatus: stoppedStatus,
      start: async () => { starts += 1; return stoppedStatus(); },
      stop: async () => stoppedStatus(),
    } as unknown as CloudflareTunnelController;
    const cfg = config(false);
    const req = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 54321,
    });
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ status: "stopped", endpoint: "http://127.0.0.1:54321/v1/responses" });
    expect(starts).toBe(0);
  });

  test("allows the API page to enable with only the environment admission token", async () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "environment-admission-secret";
    let status = stoppedStatus();
    let starts = 0;
    const controller = {
      getStatus: () => status,
      start: async () => {
        starts += 1;
        status = {
          status: "running",
          mode: "quick",
          publicUrl: "https://env-token.trycloudflare.com",
          supportsSse: false,
        };
        return status;
      },
      stop: async () => stoppedStatus(),
    } as CloudflareTunnelController;
    const cfg = config(false);
    const deps = { cloudflareTunnel: controller, listenPort: 54321 };

    const keysResponse = await handleManagementAPI(
      request("/api/keys"),
      new URL("http://127.0.0.1:54321/api/keys"),
      cfg,
      deps,
    );
    expect(await keysResponse?.json()).toMatchObject({
      keys: [],
      tunnel: { canEnable: true, enabled: false },
    });

    const req = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), cfg, deps);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      canEnable: true,
      enabled: true,
      endpoint: "https://env-token.trycloudflare.com/v1/responses",
    });
    expect(starts).toBe(1);
  });

  test("allows Quick Tunnel as an explicit one-click option even before Named setup or API keys", async () => {
    let status = stoppedStatus();
    const starts: unknown[] = [];
    const controller = {
      getStatus: () => status,
      start: async (options: unknown) => {
        starts.push(options);
        status = {
          status: "running",
          mode: "quick",
          publicUrl: "https://debug.trycloudflare.com",
          supportsSse: false,
        };
        return status;
      },
      stop: async () => stoppedStatus(),
    } as unknown as CloudflareTunnelController;
    const cfg = {
      ...config(false),
      cloudflareTunnel: { enabled: false, mode: "named" as const },
    };
    const deps = { cloudflareTunnel: controller, listenPort: 54321 };

    const namedReq = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const namedResponse = await handleManagementAPI(namedReq, new URL(namedReq.url), cfg, deps);
    expect(namedResponse?.status).toBe(409);
    expect(await namedResponse?.json()).toMatchObject({
      error: "Create an opencodex API key before enabling public access.",
    });
    expect(starts).toEqual([]);

    const quickReq = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, mode: "quick" }),
    });
    const quickResponse = await handleManagementAPI(quickReq, new URL(quickReq.url), cfg, deps);
    expect(quickResponse?.status).toBe(200);
    expect(await quickResponse?.json()).toMatchObject({
      status: "running",
      mode: "quick",
      supportsSse: false,
      endpoint: "https://debug.trycloudflare.com/v1/responses",
    });
    expect(starts).toEqual([{
      originUrl: "http://127.0.0.1:54321",
      actualPort: 54321,
      configuredPort: 10100,
      mode: "quick",
    }]);
    expect(cfg.cloudflareTunnel?.mode).toBe("quick");
    expect(cfg.cloudflareTunnel?.enabled).toBe(true);
  });

  test("returns sanitized controller failures without replacing the local endpoint", async () => {
    let status = stoppedStatus();
    const controller = {
      getStatus: () => status,
      start: async () => {
        status = {
          status: "error",
          mode: "quick",
          publicUrl: null,
          supportsSse: false,
          error: "cloudflared is not installed",
        };
        return status;
      },
      stop: async () => status,
    } as unknown as CloudflareTunnelController;
    const cfg = config();
    const req = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 54321,
    });
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      status: "error",
      mode: "quick",
      publicUrl: null,
      supportsSse: false,
      error: "cloudflared is not installed",
      enabled: false,
      canEnable: true,
      endpoint: "http://127.0.0.1:54321/v1/responses",
      configured: true,
      setupRequired: false,
      configurationSource: "quick",
    });
    expect(cfg.cloudflareTunnel?.enabled).not.toBe(true);
  });

  test("reports the default Named Tunnel as SSE-capable but unconfigured and refuses to start", async () => {
    let starts = 0;
    const controller = {
      getStatus: stoppedStatus,
      start: async () => { starts += 1; return stoppedStatus(); },
      stop: async () => stoppedStatus(),
    } as CloudflareTunnelController;
    const cfg = config();
    delete cfg.cloudflareTunnel;
    const deps = { cloudflareTunnel: controller, listenPort: 10100 };

    const getResponse = await handleManagementAPI(
      request("/api/cloudflare-tunnel"),
      new URL("http://127.0.0.1:54321/api/cloudflare-tunnel"),
      cfg,
      deps,
    );
    expect(await getResponse?.json()).toMatchObject({
      status: "stopped",
      mode: "named",
      supportsSse: true,
      configured: false,
      setupRequired: true,
      configurationSource: "none",
      canEnable: false,
      endpoint: "http://127.0.0.1:10100/v1/responses",
    });

    const enableRequest = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const enableResponse = await handleManagementAPI(enableRequest, new URL(enableRequest.url), cfg, deps);
    expect(enableResponse?.status).toBe(409);
    expect(await enableResponse?.json()).toMatchObject({
      mode: "named",
      supportsSse: true,
      configured: false,
      setupRequired: true,
      error: "Configure a Named Cloudflare Tunnel before enabling public access.",
    });
    expect(starts).toBe(0);
  });

  test("does not present a legacy enabled Quick preference as active before Named setup", async () => {
    const cfg = config();
    cfg.cloudflareTunnel = { enabled: true };
    const response = await handleManagementAPI(
      request("/api/cloudflare-tunnel"),
      new URL("http://127.0.0.1:54321/api/cloudflare-tunnel"),
      cfg,
      {
        cloudflareTunnel: {
          getStatus: stoppedStatus,
          start: async () => stoppedStatus(),
          stop: async () => stoppedStatus(),
        },
        listenPort: 10100,
      },
    );
    expect(await response?.json()).toMatchObject({
      enabled: false,
      mode: "named",
      configured: false,
      setupRequired: true,
      supportsSse: true,
    });
  });

  test("configures a pasted Named Tunnel token, starts with fixed-file overrides, and leaks no secret", async () => {
    let status = stoppedStatus();
    const starts: unknown[] = [];
    const controller = {
      getStatus: () => status,
      start: async (options: unknown) => {
        starts.push(options);
        status = {
          status: "running",
          mode: "named",
          publicUrl: "https://api.example.com",
          supportsSse: true,
          startedAt: "2026-07-22T00:00:00.000Z",
        };
        return status;
      },
      stop: async () => {
        status = stoppedStatus();
        return status;
      },
    } as CloudflareTunnelController;
    const cfg = config();
    const persisted: OcxConfig[] = [];
    const req = request("/api/cloudflare-tunnel/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "token",
        publicUrl: "https://api.example.com/",
        tunnelToken: `cloudflared service install ${runnerToken}`,
        enable: true,
      }),
    });

    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
      persistConfig: value => { persisted.push(structuredClone(value)); },
    });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    const payload = await response?.json();
    expect(payload).toMatchObject({
      status: "running",
      mode: "named",
      publicUrl: "https://api.example.com",
      supportsSse: true,
      configured: true,
      setupRequired: false,
      configurationSource: "local",
      configuredPublicUrl: "https://api.example.com",
      endpoint: "https://api.example.com/v1/responses",
      enabled: true,
    });
    const tokenPath = storedCloudflareTunnelTokenPath();
    expect(starts).toEqual([{
      originUrl: "http://127.0.0.1:10100",
      actualPort: 10100,
      configuredPort: 10100,
      mode: "named",
      namedTunnel: { publicUrl: "https://api.example.com", tokenFile: tokenPath },
    }]);
    expect(cfg.cloudflareTunnel).toMatchObject({
      version: 2,
      enabled: true,
      mode: "named",
      publicUrl: "https://api.example.com",
    });
    expect(cfg.websockets).toBeUndefined();
    expect(persisted).toHaveLength(2);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(runnerToken);
    expect(serialized).not.toContain("tokenFingerprint");
    expect(serialized).not.toContain(tokenPath);
    expect(serialized).not.toContain(testDir);
  });

  test("auto-provisions a Named Tunnel without persisting or returning the Cloudflare API token", async () => {
    let starts = 0;
    const controller = {
      getStatus: stoppedStatus,
      start: async () => { starts += 1; return stoppedStatus(); },
      stop: async () => stoppedStatus(),
    } as CloudflareTunnelController;
    const cfg = config();
    const provisionCalls: Array<{ input: unknown; originUrl: string }> = [];
    const req = request("/api/cloudflare-tunnel/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "api",
        apiToken: cloudflareApiToken,
        accountId: "a".repeat(32),
        zoneId: "b".repeat(32),
        hostname: "api.example.com",
        tunnelName: "opencodex-user",
        enable: false,
      }),
    });

    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
      persistConfig: () => {},
      provisionCloudflareTunnel: async (input, originUrl) => {
        provisionCalls.push({ input, originUrl });
        return {
          publicUrl: "https://api.example.com",
          tunnelToken: runnerToken,
          tunnelId: "11111111-2222-4333-8444-555555555555",
          dnsRecordId: "c".repeat(32),
        };
      },
    });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(provisionCalls).toEqual([{
      input: {
        apiToken: cloudflareApiToken,
        accountId: "a".repeat(32),
        zoneId: "b".repeat(32),
        hostname: "api.example.com",
        tunnelName: "opencodex-user",
      },
      originUrl: "http://127.0.0.1:10100",
    }]);
    expect(starts).toBe(0);
    expect(cfg.cloudflareTunnel).toMatchObject({
      version: 2,
      enabled: false,
      mode: "named",
      publicUrl: "https://api.example.com",
      managedTunnelId: "11111111-2222-4333-8444-555555555555",
      managedDnsRecordId: "c".repeat(32),
    });
    expect(cfg.websockets).toBeUndefined();
    const payload = await response?.json();
    expect(payload).toMatchObject({
      status: "stopped",
      mode: "named",
      supportsSse: true,
      configured: true,
      setupRequired: false,
      configurationSource: "local",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(cloudflareApiToken);
    expect(serialized).not.toContain(runnerToken);
    expect(serialized).not.toContain("tokenFingerprint");
    expect(serialized).not.toContain(storedCloudflareTunnelTokenPath());
  });

  test("requires explicit confirmation before automatic setup replaces local Named metadata", async () => {
    const controller = {
      getStatus: stoppedStatus,
      start: async () => stoppedStatus(),
      stop: async () => stoppedStatus(),
    } as CloudflareTunnelController;
    const cfg = config();
    const manual = request("/api/cloudflare-tunnel/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "token",
        publicUrl: "https://old.example.com",
        tunnelToken: runnerToken,
        enable: false,
      }),
    });
    expect((await handleManagementAPI(manual, new URL(manual.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
      persistConfig: () => {},
    }))?.status).toBe(200);

    const automaticBody = {
      method: "api",
      apiToken: cloudflareApiToken,
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      hostname: "new.example.com",
      enable: false,
    };
    let provisions = 0;
    const provisionCloudflareTunnel = async () => {
      provisions += 1;
      return {
        publicUrl: "https://new.example.com",
        tunnelToken: runnerToken,
        tunnelId: "11111111-2222-4333-8444-555555555555",
        dnsRecordId: "c".repeat(32),
      };
    };
    const unconfirmed = request("/api/cloudflare-tunnel/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(automaticBody),
    });
    const blocked = await handleManagementAPI(unconfirmed, new URL(unconfirmed.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
      persistConfig: () => {},
      provisionCloudflareTunnel,
    });
    expect(blocked?.status).toBe(409);
    expect(await blocked?.json()).toMatchObject({ error: expect.stringContaining("replaceExisting") });
    expect(provisions).toBe(0);

    const confirmed = request("/api/cloudflare-tunnel/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...automaticBody, replaceExisting: true }),
    });
    expect((await handleManagementAPI(confirmed, new URL(confirmed.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
      persistConfig: () => {},
      provisionCloudflareTunnel,
    }))?.status).toBe(200);
    expect(provisions).toBe(1);
  });

  test("blocks public-access transitions while Cloudflare provisioning is in progress", async () => {
    let releaseProvision!: (value: {
      publicUrl: string;
      tunnelToken: string;
      tunnelId: string;
      dnsRecordId: string;
    }) => void;
    let provisioningStarted!: () => void;
    const started = new Promise<void>(resolve => { provisioningStarted = resolve; });
    const pendingProvision = new Promise<{
      publicUrl: string;
      tunnelToken: string;
      tunnelId: string;
      dnsRecordId: string;
    }>(resolve => { releaseProvision = resolve; });
    let tunnelStarts = 0;
    const controller = {
      getStatus: stoppedStatus,
      start: async () => { tunnelStarts += 1; return stoppedStatus(); },
      stop: async () => stoppedStatus(),
    } as CloudflareTunnelController;
    const cfg = config();
    const setupRequest = request("/api/cloudflare-tunnel/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "api",
        apiToken: cloudflareApiToken,
        accountId: "a".repeat(32),
        zoneId: "b".repeat(32),
        hostname: "api.example.com",
        enable: false,
      }),
    });
    const setupResponsePromise = handleManagementAPI(setupRequest, new URL(setupRequest.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
      persistConfig: () => {},
      provisionCloudflareTunnel: async () => {
        provisioningStarted();
        return pendingProvision;
      },
    });
    await started;

    const enableRequest = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const blocked = await handleManagementAPI(enableRequest, new URL(enableRequest.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
    });
    expect(blocked?.status).toBe(409);
    expect(await blocked?.json()).toMatchObject({ error: "Cloudflare setup is already in progress." });
    expect(tunnelStarts).toBe(0);

    releaseProvision({
      publicUrl: "https://api.example.com",
      tunnelToken: runnerToken,
      tunnelId: "11111111-2222-4333-8444-555555555555",
      dnsRecordId: "c".repeat(32),
    });
    expect((await setupResponsePromise)?.status).toBe(200);
  });

  test("restores the previous config and token when setup persistence fails", async () => {
    const controller = {
      getStatus: stoppedStatus,
      start: async () => stoppedStatus(),
      stop: async () => stoppedStatus(),
    } as CloudflareTunnelController;
    const cfg = config();
    const req = request("/api/cloudflare-tunnel/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "token",
        publicUrl: "https://api.example.com",
        tunnelToken: runnerToken,
        enable: false,
      }),
    });

    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
      persistConfig: () => { throw new Error("read-only config"); },
    });
    expect(response?.status).toBe(500);
    expect(cfg.websockets).toBeUndefined();
    expect(cfg.cloudflareTunnel).toEqual({ mode: "quick" });
    expect(existsSync(storedCloudflareTunnelTokenPath())).toBe(false);
  });

  test("stops an errored connector before replacing its Named Tunnel credentials", async () => {
    let status: CloudflareTunnelStatus = {
      status: "error",
      mode: "named",
      publicUrl: "https://old.example.com",
      supportsSse: true,
      error: "connector failed",
    };
    let stops = 0;
    const controller = {
      getStatus: () => status,
      start: async () => status,
      stop: async () => {
        stops += 1;
        status = stoppedStatus();
        return status;
      },
    } as CloudflareTunnelController;
    const cfg = config();
    const req = request("/api/cloudflare-tunnel/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "token",
        publicUrl: "https://replacement.example.com",
        tunnelToken: runnerToken,
        enable: false,
      }),
    });

    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
      persistConfig: () => {},
    });
    expect(stops).toBe(1);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      status: "stopped",
      configured: true,
      configuredPublicUrl: "https://replacement.example.com",
      supportsSse: true,
    });
  });

  test("refuses to replace environment-managed Named Tunnel configuration", async () => {
    process.env.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN = runnerToken;
    process.env.OPENCODEX_CLOUDFLARE_PUBLIC_URL = "https://environment.example.com";
    let replacements = 0;
    let provisions = 0;
    const controller = {
      getStatus: stoppedStatus,
      start: async () => stoppedStatus(),
      stop: async () => stoppedStatus(),
    } as CloudflareTunnelController;
    const cfg = config();
    const req = request("/api/cloudflare-tunnel/setup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "token",
        publicUrl: "https://replacement.example.com",
        tunnelToken: runnerToken,
      }),
    });

    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 10100,
      replaceCloudflareTunnelToken: () => {
        replacements += 1;
        throw new Error("must not be called");
      },
      provisionCloudflareTunnel: async () => {
        provisions += 1;
        throw new Error("must not be called");
      },
    });
    expect(response?.status).toBe(409);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.json()).toMatchObject({
      mode: "named",
      supportsSse: true,
      configured: true,
      configurationSource: "environment",
      configurationEditable: false,
      error: "Cloudflare Tunnel configuration is managed by environment variables.",
    });
    expect(replacements).toBe(0);
    expect(provisions).toBe(0);
  });

  test("always stops on disable when persistence fails", async () => {
    let status: CloudflareTunnelStatus = {
      status: "running",
      mode: "quick",
      publicUrl: "https://safe-name.trycloudflare.com",
      supportsSse: false,
    };
    let stops = 0;
    const controller = {
      getStatus: () => status,
      start: async () => status,
      stop: async () => {
        stops += 1;
        status = stoppedStatus();
        return status;
      },
    } as CloudflareTunnelController;
    const cfg = config();
    cfg.cloudflareTunnel = { enabled: true, mode: "quick" };
    const req = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 54321,
      persistConfig: () => { throw new Error("read-only config"); },
    });
    expect(stops).toBe(1);
    expect(response?.status).toBe(500);
    expect(await response?.json()).toMatchObject({
      status: "stopped",
      enabled: true,
      endpoint: "http://127.0.0.1:54321/v1/responses",
    });
    expect(cfg.cloudflareTunnel.enabled).toBe(true);
  });

  test("rolls back a newly started tunnel when persistence fails", async () => {
    let status = stoppedStatus();
    let stops = 0;
    const controller = {
      getStatus: () => status,
      start: async () => {
        status = {
          status: "running",
          mode: "quick",
          publicUrl: "https://safe-name.trycloudflare.com",
          supportsSse: false,
        };
        return status;
      },
      stop: async () => {
        stops += 1;
        status = stoppedStatus();
        return status;
      },
    } as CloudflareTunnelController;
    const cfg = config();
    const req = request("/api/cloudflare-tunnel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    const response = await handleManagementAPI(req, new URL(req.url), cfg, {
      cloudflareTunnel: controller,
      listenPort: 54321,
      persistConfig: () => { throw new Error("read-only config"); },
    });
    expect(stops).toBe(1);
    expect(response?.status).toBe(500);
    expect(await response?.json()).toMatchObject({
      status: "stopped",
      enabled: false,
      endpoint: "http://127.0.0.1:54321/v1/responses",
    });
    expect(cfg.cloudflareTunnel?.enabled).toBeUndefined();
  });
});
