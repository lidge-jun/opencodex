import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { serveGuiFile } from "../src/server/gui-static";
import { isProxyAdmissionSecret } from "../src/server/auth-cors";
import {
  initializeManagementAuthState,
  issueGuiSession,
  removeManagementTokenPathBestEffort,
  requireManagementAuth,
} from "../src/server/management-auth";
import {
  hardenSecretPath,
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
  hardenSecretDir,
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
  testHome = mkdtempSync(join(tmpdir(), "ocx-management-auth-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
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
  test("management-token temp cleanup forgets successful ACL memos and retains failed removals", () => {
    const temporary = join(testHome, ".admin-token.tmp");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    try {
      writeFileSync(temporary, "secret", { mode: 0o600 });
      hardenSecretPath(temporary, { required: true });
      removeManagementTokenPathBestEffort(temporary);
      expect(hardenedSecretPathCountForTests()).toBe(0);

      writeFileSync(temporary, "secret", { mode: 0o600 });
      hardenSecretPath(temporary, { required: true });
      removeManagementTokenPathBestEffort(temporary, () => {
        throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" });
      });
      expect(hardenedSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

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
      const body = await management.json() as { error?: string; hint?: string; reason?: string };
      expect(body.error).toBe("management API unavailable");
      expect(body.hint).toContain("OPENCODEX_ADMIN_AUTH_TOKEN");
      expect(typeof body.reason).toBe("string");
      expect(body.reason!.length).toBeGreaterThan(0);
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
  }, SERVER_BUDGET_MS); // binds a real server + live fetches; windows runner measured ~5.04s against Bun's 5s default.

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

  test("directory ACL timeout keeps management unavailable and names OPENCODEX_ADMIN_AUTH_TOKEN", () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const adminToken = `ocx_admin_${"d".repeat(43)}`;
    writeFileSync(join(testHome, "admin-api-token"), `${adminToken}\n`, { mode: 0o600 });
    process.env.USERNAME ??= "tester";
    setPlatformForTests("win32");
    // Timeout only the management-token directory. File hardens must succeed so
    // startServer → saveConfig can atomic-write on real win32; Linux CI skips
    // that path via process.platform and hid the blanket-timeout failure mode.
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target === testHome) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();
    // Probe only: startServer would re-harden the same home for config mutation
    // and poison/conflict with this required directory timeout. HTTP 503 coverage
    // for ACL timeouts lives in "an icacls timeout keeps the management plane closed".
    const state = initializeManagementAuthState(remoteConfig());
    expect(state.available).toBe(false);
    if (state.available) return;
    expect(state.reason).toContain("OPENCODEX_ADMIN_AUTH_TOKEN");
  });

  test("required management harden retries after a soft loadConfig directory timeout", async () => {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const adminToken = `ocx_admin_${"f".repeat(43)}`;
    writeFileSync(join(testHome, "admin-api-token"), `${adminToken}\n`, { mode: 0o600 });
    process.env.USERNAME ??= "tester";
    setPlatformForTests("win32");

    let softPhase = true;
    let requiredPhaseCalls = 0;
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target.endsWith("admin-api-token")) {
        return { success: true, exitCode: 0, timedOut: false, stdout: "" };
      }
      if (softPhase) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      requiredPhaseCalls += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();

    const soft = hardenSecretDir(testHome, { required: false });
    expect(soft.ok).toBe(false);
    expect(soft.diagnostics).toMatch(/timed out|budget exhausted|previous attempt/i);

    softPhase = false;
    const state = initializeManagementAuthState(remoteConfig());
    expect(state.available).toBe(true);
    if (!state.available) return;
    expect(state.source).toBe("file");
    expect(requiredPhaseCalls).toBeGreaterThan(0);
  });

  test("OPENCODEX_ADMIN_AUTH_TOKEN bypasses file-backed ACL hardening", async () => {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "env-admin-secret";
    saveConfig(remoteConfig());
    process.env.USERNAME ??= "tester";
    setPlatformForTests("win32");
    // Env-token init never needs file ACL. Time out management-token paths so a
    // broken file-backed ACL cannot be what made management available; allow
    // other file hardens so startServer → saveConfig works on real win32
    // (config-mutation directory harden soft-fails home timeouts).
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target === testHome || target.endsWith("admin-api-token")) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();

    const state = initializeManagementAuthState(remoteConfig());
    expect(state.available).toBe(true);
    if (!state.available) return;
    expect(state.source).toBe("environment");

    const server = startServer(0);
    try {
      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-opencodex-api-key": "env-admin-secret" },
      });
      expect(management.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});
