import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import type {
  CloudflareTunnelController,
  CloudflareTunnelStatus,
} from "../src/server/cloudflare-tunnel";
import type { OcxConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
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
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
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
    expect(await response?.json()).toEqual({
      status: "error",
      mode: "quick",
      publicUrl: null,
      supportsSse: false,
      error: "cloudflared is not installed",
      enabled: false,
      canEnable: true,
      endpoint: "http://127.0.0.1:54321/v1/responses",
    });
    expect(cfg.cloudflareTunnel?.enabled).not.toBe(true);
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
    cfg.cloudflareTunnel = { enabled: true };
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
