/**
 * Integration coverage for the authenticated dashboard listener.
 *
 * These tests start real servers and speak HTTP to both sockets. The point under
 * test is the split surface: the dashboard port admits GUI + management routes with
 * the admin credential, refuses the whole /v1 data plane and the health endpoints,
 * and mints an opaque session whose CSRF arm guards mutations. The public listener
 * must behave identically with and without the dashboard listener configured.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { isDashboardListenerBindAddress, loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { findAvailablePort } from "../src/server/ports";
import type { OcxConfig } from "../src/types";

const ADMIN_TOKEN = "admin-secret-for-dashboard-listener";
const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function baseConfig(dashboardPort: number | null, hostname = dashboardHost ?? "127.0.0.1"): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "provider-credential-placeholder",
        disabled: true,
        models: ["gpt-test"],
      },
    },
    ...(dashboardPort === null
      ? {}
      : { dashboardListener: { enabled: true, port: dashboardPort, hostname } }),
  } as unknown as OcxConfig;
}

/** A free port the way production would choose one, so tests cannot collide on a fixed number. */
async function freePort(hostname = dashboardHost ?? "127.0.0.1"): Promise<number> {
  return await findAvailablePort(0, hostname);
}

function dashboardUrl(port: number, path: string): string {
  return `http://${dashboardHost ?? "127.0.0.1"}:${port}${path}`;
}

/**
 * The origin-gate test needs a bind hostname the management gate treats as non-loopback.
 * 127.0.0.2 is that on Linux and Windows, but macOS does not bind it (EADDRNOTAVAIL), so
 * use the host's real interface address the way tests/loopback-listener-integration.test.ts
 * does — the production shape for this listener is a tailnet/LAN bind anyway.
 */
function firstDashboardIPv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isDashboardListenerBindAddress(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}

const dashboardHost = firstDashboardIPv4();
const dashboardTest = test.skipIf(!dashboardHost);

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-dashboard-listener-"));
  process.env.OPENCODEX_HOME = testHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome && existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("dashboard listener surface", () => {
  test("drops unsafe raw listener bind addresses before startup", async () => {
    const dashboardPort = await freePort("127.0.0.1");
    for (const hostname of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "dashboard.example"]) {
      writeFileSync(
        join(testHome, "config.json"),
        JSON.stringify({
          ...baseConfig(null),
          dashboardListener: { enabled: true, port: dashboardPort, hostname },
        }),
      );
      expect(loadConfig().dashboardListener).toBeUndefined();
    }

    // A wildcard used to survive loading and bind this socket. Loading it must leave the
    // reserved port untouched even though the rest of the server starts normally.
    writeFileSync(
      join(testHome, "config.json"),
      JSON.stringify({
        ...baseConfig(null),
        dashboardListener: { enabled: true, port: dashboardPort, hostname: "0.0.0.0" },
      }),
    );
    const server = startServer(0);
    try {
      const dashboardBound = await fetch(`http://127.0.0.1:${dashboardPort}/healthz`)
        .then(() => true)
        .catch(() => false);
      expect(dashboardBound).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  dashboardTest("serves the SPA root and the management API, and demands the admin token", async () => {
    const dashboardPort = await freePort();
    saveConfig(baseConfig(dashboardPort));
    const server = startServer(0);
    try {
      const root = await fetch(dashboardUrl(dashboardPort, "/"));
      expect(root.status).toBe(200);

      const anon = await fetch(dashboardUrl(dashboardPort, "/api/config"));
      expect(anon.status).toBe(401);

      const authorized = await fetch(dashboardUrl(dashboardPort, "/api/config"), {
        headers: { "x-opencodex-api-key": ADMIN_TOKEN },
      });
      expect(authorized.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  dashboardTest("refuses the /v1 data plane and /readyz even with the admin token, serves /healthz", async () => {
    const dashboardPort = await freePort();
    saveConfig(baseConfig(dashboardPort));
    const server = startServer(0);
    try {
      for (const path of ["/v1/models", "/v1/responses", "/readyz"]) {
        const res = await fetch(dashboardUrl(dashboardPort, path), {
          headers: { "x-opencodex-api-key": ADMIN_TOKEN },
        });
        expect(res.status).toBe(404);
      }
      // Pin the upgrade refusal separately so reordering the allowlist cannot pass silently.
      const upgrade = await fetch(dashboardUrl(dashboardPort, "/v1/responses"), {
        headers: {
          "x-opencodex-api-key": ADMIN_TOKEN,
          Upgrade: "websocket",
          Connection: "Upgrade",
        },
      });
      expect(upgrade.status).toBe(404);
      // The dashboard overview polls /healthz; it must work (and discloses no more
      // than the already-public SPA shell).
      const health = await fetch(dashboardUrl(dashboardPort, "/healthz"));
      expect(health.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  dashboardTest("minting an opaque session keeps the dashboard usable across page refreshes", async () => {
    const dashboardPort = await freePort();
    saveConfig(baseConfig(dashboardPort));
    const server = startServer(0);
    try {
      const mint = await fetch(dashboardUrl(dashboardPort, "/api/auth/session"), {
        method: "POST",
        headers: { "x-opencodex-api-key": ADMIN_TOKEN },
      });
      expect(mint.status).toBe(200);
      expect(mint.headers.get("set-cookie")).toBeNull();
      const session = await mint.json() as { token: string; csrfToken: string; origin: string };
      expect(session.token).toMatch(/^ocx_session_/);
      expect(session.csrfToken).toBeTruthy();
      expect(session.origin).toContain(String(dashboardPort));

      // The session endpoint only mints; a refresh uses the opaque browser-stored token.
      const sessionGet = await fetch(dashboardUrl(dashboardPort, "/api/auth/session"), {
        headers: { "x-opencodex-api-key": session.token },
      });
      expect(sessionGet.status).toBe(405);

      const read = await fetch(dashboardUrl(dashboardPort, "/api/config"), {
        headers: { "x-opencodex-api-key": session.token },
      });
      expect(read.status).toBe(200);

      // Mutations need the CSRF arm: the session token alone must not pass the gate.
      const mutationHeaders = (csrf?: string) => ({
        "x-opencodex-api-key": session.token,
        Origin: session.origin,
        "X-OpenCodex-GUI-Origin": session.origin,
        ...(csrf === undefined ? {} : { "x-opencodex-csrf-token": csrf }),
      });
      const noCsrf = await fetch(dashboardUrl(dashboardPort, "/api/settings"), {
        method: "PUT",
        headers: mutationHeaders(),
        body: "{}",
      });
      expect(noCsrf.status).toBe(401);

      const withCsrf = await fetch(dashboardUrl(dashboardPort, "/api/settings"), {
        method: "PUT",
        headers: mutationHeaders(session.csrfToken),
        body: "{}",
      });
      // 403 would mean the cross-origin gate regressed; other statuses may reflect body validation.
      expect(withCsrf.status).not.toBe(401);
      expect(withCsrf.status).not.toBe(403);
    } finally {
      await server.stop(true);
    }
  });

  dashboardTest("rejects a session mint with a wrong admin token", async () => {
    const dashboardPort = await freePort();
    saveConfig(baseConfig(dashboardPort));
    const server = startServer(0);
    try {
      const mint = await fetch(dashboardUrl(dashboardPort, "/api/auth/session"), {
        method: "POST",
        headers: { "x-opencodex-api-key": "wrong-token" },
      });
      expect(mint.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  dashboardTest("leaves the public listener unchanged: loopback data plane stays token-free", async () => {
    const dashboardPort = await freePort();
    saveConfig(baseConfig(dashboardPort));
    const server = startServer(0);
    try {
      const publicRoot = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(publicRoot.status).toBe(200);
      // Loopback bind: the data plane admits without a credential (#1102 semantics),
      // and the admin token still gates /api on both sockets.
      const models = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(models.status).toBe(200);
      const anon = await fetch(`http://127.0.0.1:${server.port}/api/config`);
      expect(anon.status).toBe(401);
      const sessionEndpoint = await fetch(`http://127.0.0.1:${server.port}/api/auth/session`, {
        method: "POST",
        headers: { "x-opencodex-api-key": ADMIN_TOKEN },
      });
      expect(sessionEndpoint.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  dashboardTest("stop closes the dashboard socket too", async () => {
    const dashboardPort = await freePort();
    saveConfig(baseConfig(dashboardPort));
    const server = startServer(0);
    await server.stop(true);
    let stillServing = false;
    try {
      const res = await fetch(dashboardUrl(dashboardPort, "/api/config"));
      stillServing = res.status > 0;
    } catch {
      stillServing = false;
    }
    expect(stillServing).toBe(false);
  });

  dashboardTest("management origin gate follows the listener policy when the proxy stays loopback", async () => {
    // The regression this pins: handleManagementAPI re-derived the request origin
    // from the shared loopback config, so a non-loopback dashboard Host was rejected
    // as cross-origin (403) even after the listener policy had admitted it. The
    // listener binds a real private/tailnet interface: non-loopback for the origin
    // check and admissible under the public bind contract.
    const dashboardPort = await freePort(dashboardHost!);
    saveConfig(baseConfig(dashboardPort, dashboardHost));
    const server = startServer(0);
    try {
      const authorized = await fetch(`http://${dashboardHost}:${dashboardPort}/api/config`, {
        headers: { "x-opencodex-api-key": ADMIN_TOKEN },
      });
      expect(authorized.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});
