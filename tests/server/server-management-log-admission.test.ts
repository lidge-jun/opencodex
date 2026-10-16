import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { resetContextRelayActivationForTests } from "../../src/codex/context-compat";
import { startServer } from "../../src/server";
import { initializeManagementAuthState } from "../../src/server/management-auth";
import {
  resetHardenedStateForTests, setIcaclsRunnerForTests, setPlatformForTests,
} from "../../src/lib/windows-secret-acl";
import { setSystemRestartIoForTests } from "../../src/server/management/system-restart";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { remoteConfig } from "../helpers/management-auth-fixture";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

const previousHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-management-auth-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.CODEX_HOME = testHome;
  resetContextRelayActivationForTests();
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
});

afterEach(async () => {
  const root = testHome;
  testHome = "";
  resetContextRelayActivationForTests();
  await drainAndRemoveFixtureRoots({
    roots: root ? [{ path: root }] : [],
    restoreEnvironment: () => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      setSystemRestartIoForTests();
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
      if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
      else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
    },
  });
});

test("log cursors remain behind management admission and origin gates", async () => {
  const config = remoteConfig();
  saveConfig(config);
  const state = initializeManagementAuthState(config);
  if (!state.available) throw new Error("expected management auth state");
  const server = startServer(0, { managementAuthState: state });
  const origin = server.url.origin;
  const token = "ocx_session_log_cursor_test";
  state.sessions.set(token, {
    serverOrigin: origin, browserOrigin: origin, csrfToken: "csrf-log-test",
    expiresAt: Date.now() + 60_000, issuance: "loopback",
  });
  const adminHeaders = { "x-opencodex-api-key": "admin-secret" };
  const acceptedHeaders: HeadersInit[] = [adminHeaders, {
    Origin: origin, "x-opencodex-api-key": token, "x-opencodex-gui-origin": origin,
  }];
  try {
    const initial = await fetch(new URL("/api/logs", server.url), { headers: adminHeaders });
    expect(initial.status).toBe(200);
    const body = await initial.json() as { cursor: string };
    expect(typeof body.cursor).toBe("string");
    for (const suffix of ["", `?cursor=${body.cursor}`, "?cursor=malformed"]) {
      const url = new URL(`/api/logs${suffix}`, server.url);
      for (const credential of [undefined, "data-secret", "wrong-admin"]) {
        const response = await fetch(url, { headers: credential ? { "x-opencodex-api-key": credential } : {} });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "opencodex admin token required" });
      }
      const foreign = await fetch(url, { headers: { ...adminHeaders, Origin: "https://attacker.test" } });
      expect(foreign.status).toBe(403);
      await foreign.text();
      for (const headers of acceptedHeaders) {
        const allowed = await fetch(url, { headers });
        expect(allowed.status).toBe(suffix.includes("malformed") ? 400 : 200);
        await allowed.text();
      }
    }
  } finally {
    await server.stop(true);
  }
}, SERVER_BUDGET_MS);

test("unavailable management authority rejects log cursors before parsing", async () => {
  saveConfig(remoteConfig());
  const server = startServer(0, { managementAuthState: { available: false, reason: "fixture unavailable" } });
  try {
    const legacy = Buffer.from(JSON.stringify({ v: 1, t: 1, id: "fixture" })).toString("base64url");
    for (const suffix of ["", `?cursor=${legacy}`, "?cursor=malformed"]) {
      const response = await fetch(new URL(`/api/logs${suffix}`, server.url), {
        headers: { "x-opencodex-api-key": "admin-secret" },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "management API unavailable" });
    }
  } finally {
    await server.stop(true);
  }
}, SERVER_BUDGET_MS);
