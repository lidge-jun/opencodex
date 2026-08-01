import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { serveGuiFile } from "../src/server/gui-static";
import { isProxyAdmissionSecret } from "../src/server/auth-cors";
import {
  initializeManagementAuthState,
  issueGuiSession,
  requireManagementAuth,
} from "../src/server/management-auth";
import {
  REMOTE_ASSERTION_AUDIENCE,
  remoteAssertionPathHash,
  resetRemoteAssertionReplayCacheForTest,
} from "../src/server/remote-assertion";
import {
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

function websocketHandshakeOpens(url: URL, token: string): Promise<boolean> {
  return new Promise(resolve => {
    const target = new URL("/v1/responses", url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(target, {
      headers: { "X-OpenCodex-API-Key": token },
    } as unknown as string[]);
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(opened);
    };
    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("close", () => finish(false));
    const timer = setTimeout(() => finish(false), 5_000);
  });
}

beforeEach(() => {
  resetRemoteAssertionReplayCacheForTest();
  testHome = mkdtempSync(join(tmpdir(), "ocx-management-auth-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
});

function remoteAssertionRequest(options: {
  url?: string;
  method?: string;
  instanceId?: string;
  issuer?: string;
  expiresIn?: number;
  issuedOffset?: number;
  jti?: string;
} = {}): { request: Request; config: OcxConfig; assertion: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const url = options.url ?? "http://127.0.0.1:10100/api/config?view=remote&z=2&a=1";
  const method = options.method ?? "GET";
  const now = Math.floor(Date.now() / 1000);
  const iat = now + (options.issuedOffset ?? 0);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "gateway-1" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: options.issuer ?? "opencodex-remote",
    aud: REMOTE_ASSERTION_AUDIENCE,
    instance_id: options.instanceId ?? "instance-1",
    user_id: "user-1",
    method,
    path_sha256: remoteAssertionPathHash(url),
    iat,
    exp: iat + (options.expiresIn ?? 30),
    jti: options.jti ?? randomUUID(),
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const assertion = `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
  const config: OcxConfig = {
    ...remoteConfig(),
    remoteAccess: {
      enabled: true,
      instanceId: "instance-1",
      issuer: "opencodex-remote",
      publicKeys: [{
        kid: "gateway-1",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      }],
    },
  };
  return {
    request: new Request(url, { method, headers: { "X-OpenCodex-Remote-Assertion": assertion } }),
    config,
    assertion,
  };
}

describe("remote management assertions", () => {
  test("accepts a valid Ed25519 assertion and rejects replay", () => {
    const { request, config } = remoteAssertionRequest();
    const state = initializeManagementAuthState(config);
    expect(requireManagementAuth(request, state, config)).toBeNull();
    expect(requireManagementAuth(request, state, config)?.status).toBe(401);
  });

  test("binds the assertion to instance, method, and normalized path", () => {
    const valid = remoteAssertionRequest();
    const state = initializeManagementAuthState(valid.config);
    const wrongMethod = new Request(valid.request.url, {
      method: "POST",
      headers: valid.request.headers,
    });
    expect(requireManagementAuth(wrongMethod, state, valid.config)?.status).toBe(401);

    const wrongPath = new Request("http://127.0.0.1:10100/api/config?view=other", {
      headers: valid.request.headers,
    });
    expect(requireManagementAuth(wrongPath, state, valid.config)?.status).toBe(401);

    const wrongInstance = { ...valid.config, remoteAccess: { ...valid.config.remoteAccess!, instanceId: "instance-2" } };
    expect(requireManagementAuth(valid.request, state, wrongInstance)?.status).toBe(401);
  });

  test("rejects expired and overlong assertions", () => {
    for (const options of [{ issuedOffset: -60, expiresIn: 30 }, { expiresIn: 31 }]) {
      const { request, config } = remoteAssertionRequest(options);
      const state = initializeManagementAuthState(config);
      expect(requireManagementAuth(request, state, config)?.status).toBe(401);
    }
  });
});

afterEach(() => {
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  resetHardenedStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("management and data-plane credential separation", () => {
  test("data and management environment tokens authorize only their own planes", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const managementWithDataToken = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(managementWithDataToken.status).toBe(401);

      const managementWithAdminToken = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(managementWithAdminToken.status).toBe(200);

      const dataWithDataToken = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(dataWithDataToken.status).toBe(200);

      const dataWithAdminToken = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(dataWithAdminToken.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("a management token that matches the data environment token closes only the management plane", async () => {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "data-secret";
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(management.status).toBe(503);
    } finally {
      await server.stop(true);
    }
  });

  test("a management token that matches a configured data key closes only the management plane", async () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    const config = remoteConfig();
    config.apiKeys = [{
      id: "conflict",
      name: "Conflicting data key",
      key: "admin-secret",
      createdAt: "2026-07-28T00:00:00.000Z",
    }];
    saveConfig(config);
    const server = startServer(0);
    try {
      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(management.status).toBe(503);
    } finally {
      await server.stop(true);
    }
  });

  test("a protected management token file is generated and remains management-only", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const adminToken = readFileSync(join(testHome, "admin-api-token"), "utf8").trim();
      expect(adminToken).toMatch(/^ocx_admin_[A-Za-z0-9_-]{43}$/);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": adminToken },
      });
      expect(management.status).toBe(200);

      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": adminToken },
      });
      expect(data.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("an icacls timeout keeps the management plane closed without stopping the data plane", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target.includes(".admin-token.tmp")) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });

    const server = startServer(0);
    try {
      const health = await fetch(new URL("/healthz", server.url));
      expect(health.status).toBe(200);

      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "data-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "ocx_admin_unhardened" },
      });
      expect(management.status).toBe(503);
      expect(await management.json()).toEqual({ error: "management API unavailable" });
    } finally {
      await server.stop(true);
    }
  });

  test("a configured data key satisfies the remote data-plane startup requirement", async () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    const config = remoteConfig();
    config.apiKeys = [{
      id: "configured",
      name: "Configured data key",
      key: "ocx_data_configured-secret",
      createdAt: "2026-07-28T00:00:00.000Z",
    }];
    saveConfig(config);

    const server = startServer(0);
    try {
      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-opencodex-api-key": "ocx_data_configured-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "ocx_data_configured-secret" },
      });
      expect(management.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("management browser origins must match the request origin exactly", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const server = startServer(0);
    try {
      const crossPort = await fetch(new URL("/api/config", server.url), {
        headers: {
          "x-opencodex-api-key": "admin-secret",
          origin: "http://127.0.0.1:65534",
        },
      });
      expect(crossPort.status).toBe(403);

      const sameOrigin = await fetch(new URL("/api/config", server.url), {
        headers: {
          "x-opencodex-api-key": "admin-secret",
          origin: server.url.origin,
        },
      });
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(server.url.origin);
    } finally {
      await server.stop(true);
    }
  });

  test("a local GUI page receives an origin-bound session with CSRF protection", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    const state = initializeManagementAuthState(config);
    const pageRequest = new Request("http://localhost:10100/", {
      headers: { Host: "localhost:10100" },
    });
    const session = issueGuiSession(pageRequest, config, state);
    expect(session).not.toBeNull();

    const guiDist = join(testHome, "gui");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(guiDist);
    writeFileSync(join(guiDist, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    const page = serveGuiFile("/", guiDist, session ?? undefined);
    expect(page?.headers.get("cache-control")).toBe("no-store");
    const html = await page?.text();
    expect(html).toContain(`name="opencodex-session-token" content="${session?.token}"`);
    expect(html).toContain(`name="opencodex-session-csrf" content="${session?.csrfToken}"`);

    const sameOriginRead = new Request("http://localhost:10100/api/config", {
      headers: {
        Host: "localhost:10100",
        "x-opencodex-api-key": session?.token ?? "",
        "x-opencodex-gui-origin": "http://localhost:10100",
      },
    });
    expect(requireManagementAuth(sameOriginRead, state, config)).toBeNull();

    const crossPortRead = new Request("http://localhost:10100/api/config", {
      headers: {
        Host: "localhost:10100",
        Origin: "http://localhost:20100",
        "x-opencodex-api-key": session?.token ?? "",
        "x-opencodex-gui-origin": "http://localhost:20100",
      },
    });
    expect(requireManagementAuth(crossPortRead, state, config)?.status).toBe(401);

    const mutationWithoutCsrf = new Request("http://localhost:10100/api/config", {
      method: "POST",
      headers: {
        Host: "localhost:10100",
        Origin: "http://localhost:10100",
        "x-opencodex-api-key": session?.token ?? "",
        "x-opencodex-gui-origin": "http://localhost:10100",
      },
    });
    expect(requireManagementAuth(mutationWithoutCsrf, state, config)?.status).toBe(401);

    const mutationWithCsrf = new Request("http://localhost:10100/api/config", {
      method: "POST",
      headers: {
        Host: "localhost:10100",
        Origin: "http://localhost:10100",
        "x-opencodex-api-key": session?.token ?? "",
        "x-opencodex-gui-origin": "http://localhost:10100",
        "x-opencodex-csrf-token": session?.csrfToken ?? "",
      },
    });
    expect(requireManagementAuth(mutationWithCsrf, state, config)).toBeNull();

    expect(issueGuiSession(new Request("http://attacker.test/", {
      headers: { Host: "attacker.test" },
    }), config, state)).toBeNull();
    expect(issueGuiSession(new Request("http://localhost:10100/"), config, state)).toBeNull();
  });

  test("a non-loopback binding never issues a GUI session from a forged loopback Host", () => {
    const config = remoteConfig();
    const state = initializeManagementAuthState(config);
    const request = new Request("http://localhost:10100/", {
      headers: { Host: "localhost:10100" },
    });
    expect(issueGuiSession(request, config, state)).toBeNull();
  });

  test("all local credential shapes are rejected by the upstream-forwarding guard", () => {
    const config = remoteConfig();
    config.apiKeys = [
      {
        id: "manual",
        name: "Manual data key",
        key: "manually-configured-data-secret",
        createdAt: "2026-07-28T00:00:00.000Z",
      },
      {
        id: "legacy",
        name: "Legacy data key",
        key: `ocx_${"a".repeat(40)}`,
        createdAt: "2026-07-28T00:00:00.000Z",
      },
    ];
    for (const secret of [
      "data-secret",
      "admin-secret",
      "manually-configured-data-secret",
      `ocx_${"a".repeat(40)}`,
      "ocx_data_generated",
      "ocx_admin_generated",
      "ocx_session_generated",
    ]) {
      expect(isProxyAdmissionSecret(secret, config)).toBe(true);
    }
    expect(isProxyAdmissionSecret("ocx_provider_upstream", config)).toBe(false);
  });

  test("Responses authentication and WebSocket handshakes accept data credentials only", async () => {
    const config = remoteConfig();
    config.websockets = true;
    saveConfig(config);
    const server = startServer(0);
    try {
      for (const rejected of ["admin-secret", "ocx_session_browser-secret"]) {
        const response = await fetch(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencodex-api-key": rejected,
          },
          body: JSON.stringify({ model: "test/gpt-test", input: "hello" }),
        });
        expect(response.status).toBe(401);
        expect(await websocketHandshakeOpens(server.url, rejected)).toBe(false);
      }
      expect(await websocketHandshakeOpens(server.url, "data-secret")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("an invalid existing management token file keeps management unavailable", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    writeFileSync(join(testHome, "admin-api-token"), "corrupt-token\n", { mode: 0o600 });
    const server = startServer(0);
    try {
      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "corrupt-token" },
      });
      expect(management.status).toBe(503);
      expect(readFileSync(join(testHome, "admin-api-token"), "utf8")).toBe("corrupt-token\n");
      expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("an existing management token ACL hardening failure keeps management unavailable", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const adminToken = `ocx_admin_${"b".repeat(43)}`;
    writeFileSync(join(testHome, "admin-api-token"), `${adminToken}\n`, { mode: 0o600 });
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target.endsWith("admin-api-token")) {
        return { success: false, exitCode: 5, timedOut: false, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    const server = startServer(0);
    try {
      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": adminToken },
      });
      expect(management.status).toBe(503);
      expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});
