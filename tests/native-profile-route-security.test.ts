import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import type { NativeProfileManager } from "../src/codex/native-profile-manager";
import { startServer } from "../src/server";
import { initializeManagementAuthState, issueGuiSession, type ManagementAuthState } from "../src/server/management-auth";
import { consumeGuiPairingGrant, createGuiPairingGrant } from "../src/server/gui-session";
import type { OcxConfig } from "../src/types";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const previousHome = process.env.HOME;
const previousOpenCodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let testHome = "";

interface NativeOperation {
  name: string;
  path: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
}

const operations: readonly NativeOperation[] = [
  { name: "list", path: "/api/native-main-profiles", method: "GET" },
  { name: "doctor", path: "/api/native-main-profiles/doctor", method: "GET" },
  { name: "register", path: "/api/native-main-profiles/register", method: "POST", body: { label: "Test profile" } },
  { name: "stage", path: "/api/native-main-profiles/stage", method: "POST" },
  { name: "stage heartbeat", path: "/api/native-main-profiles/stage/heartbeat", method: "POST", body: { stageId: "stage-1", writerToken: "writer-token" } },
  { name: "stage finish", path: "/api/native-main-profiles/stage/finish", method: "POST", body: { stageId: "stage-1", writerToken: "writer-token", label: "Test profile" } },
  { name: "stage cancel", path: "/api/native-main-profiles/stage/cancel", method: "POST", body: { stageId: "stage-1", writerToken: "writer-token" } },
  { name: "switch", path: "/api/native-main-profiles/switch", method: "POST", body: { target: "profile-1", confirmedStopped: true } },
  { name: "recover", path: "/api/native-main-profiles/recover", method: "POST", body: { rollback: true, confirmedStopped: true } },
];

function loopbackConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
      },
    },
  };
}

function testManager(calls: string[]): NativeProfileManager {
  const dispatched = (operation: string) => {
    calls.push(operation);
    return { operation };
  };
  return {
    list: async () => dispatched("list"),
    doctor: async () => dispatched("doctor"),
    register: async () => dispatched("register"),
    prepareStage: async () => dispatched("stage"),
    heartbeatStage: async () => dispatched("stage heartbeat"),
    finishStage: async () => dispatched("stage finish"),
    cancelStage: async () => { dispatched("stage cancel"); return { removed: true, plaintextMayRemain: false }; },
    switch: async () => dispatched("switch"),
    recover: async () => dispatched("recover"),
  } as unknown as NativeProfileManager;
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-native-profile-route-security-"));
  process.env.HOME = testHome;
  process.env.OPENCODEX_HOME = testHome;
  process.env.CODEX_HOME = join(testHome, "codex-home");
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "native-main-admin-token";
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("native-main profile routes at the management admission boundary", () => {
  test("rejects missing or wrong credentials and hostile origins before every native operation dispatches", async () => {
    const config = loopbackConfig();
    saveConfig(config);
    const calls: string[] = [];
    const server = startServer(0, { managementApi: { nativeProfileApi: { manager: testManager(calls) } } });
    try {
      for (const operation of operations) {
        const request = (headers: HeadersInit = {}) => fetch(new URL(operation.path, server.url), {
          method: operation.method,
          headers: operation.body ? { "content-type": "application/json", ...headers } : headers,
          body: operation.body ? JSON.stringify(operation.body) : undefined,
        });

        expect((await request()).status).toBe(401);
        expect((await request({ "x-opencodex-api-key": "wrong-admin-token" })).status).toBe(401);
        expect((await request({
          "x-opencodex-api-key": "native-main-admin-token",
          origin: "https://attacker.example",
        })).status).toBe(403);
        expect(calls).toEqual([]);

        expect((await request({ "x-opencodex-api-key": "native-main-admin-token" })).status).toBe(200);
        expect(calls).toEqual([operation.name]);
        calls.length = 0;
      }
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("requires a same-origin GUI session CSRF token for every native mutation before dispatch", async () => {
    const config = loopbackConfig();
    saveConfig(config);
    const calls: string[] = [];
    const managementAuth: ManagementAuthState = initializeManagementAuthState(config);
    const server = startServer(0, {
      managementAuthState: managementAuth,
      managementApi: { nativeProfileApi: { manager: testManager(calls) } },
    });
    try {
      const session = issueGuiSession(new Request(new URL("/", server.url), {
        headers: { Host: server.url.host },
      }), config, managementAuth);
      expect(session).not.toBeNull();
      if (!session) throw new Error("expected a loopback GUI session");

      for (const operation of operations.filter(operation => operation.method === "POST")) {
        const request = (csrf?: string) => fetch(new URL(operation.path, server.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Origin: server.url.origin,
            "x-opencodex-api-key": session.token,
            "x-opencodex-gui-origin": server.url.origin,
            ...(csrf === undefined ? {} : { "x-opencodex-csrf-token": csrf }),
          },
          body: operation.body ? JSON.stringify(operation.body) : undefined,
        });

        expect((await request()).status).toBe(401);
        expect((await request("wrong-csrf-token")).status).toBe(401);
        expect(calls).toEqual([]);

        expect((await request(session.csrfToken)).status).toBe(200);
        expect(calls).toEqual([operation.name]);
        calls.length = 0;
      }
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("remote GUI sessions require the bound server, browser origin, and CSRF before native mutation dispatch", async () => {
    const config: OcxConfig = {
      ...loopbackConfig(),
      hostname: "0.0.0.0",
      runtimeRole: "hub",
      hub: { managementPublicOrigin: "https://hub.example.test" },
      remoteGui: {},
      corsAllowOrigins: ["https://dashboard.example.test"],
      apiKeys: [{ id: "data", name: "data", key: "data-secret", createdAt: "2026-08-28T00:00:00.000Z" }],
    };
    saveConfig(config);
    const calls: string[] = [];
    const managementAuth = initializeManagementAuthState(config);
    if (!managementAuth.available) throw new Error("expected management auth state");
    const grant = createGuiPairingGrant("https://dashboard.example.test", config, managementAuth);
    const session = consumeGuiPairingGrant(new Request("https://hub.example.test/opencodex-session", {
      method: "POST",
      headers: { Host: "hub.example.test", Origin: "https://dashboard.example.test" },
    }), { grant: grant.grant }, config, managementAuth);
    if (!session) throw new Error("expected remote GUI session");
    const server = startServer(0, {
      managementAuthState: managementAuth,
      managementApi: { nativeProfileApi: { manager: testManager(calls) } },
    });
    try {
      const operation = operations.find(candidate => candidate.method === "POST")!;
      const request = (headers: Record<string, string>) => fetch(new URL(operation.path, server.url), {
        method: "POST",
        headers: { "content-type": "application/json", Host: "hub.example.test", ...headers },
        body: operation.body ? JSON.stringify(operation.body) : undefined,
      });
      const base = {
        Origin: "https://dashboard.example.test",
        "x-opencodex-api-key": session.token,
        "x-opencodex-gui-origin": "https://dashboard.example.test",
        "x-opencodex-csrf-token": session.csrfToken,
      };
      const withoutHeader = (name: string): Record<string, string> => Object.fromEntries(
        Object.entries(base).filter(([header]) => header !== name),
      );
      expect((await request({ ...base, "x-opencodex-gui-origin": "https://evil.example.test" })).status).toBe(401);
      expect((await request({ ...base, Origin: "https://evil.example.test" })).status).toBe(401);
      expect((await request(withoutHeader("Origin"))).status).toBe(401);
      expect((await request(withoutHeader("x-opencodex-gui-origin"))).status).toBe(401);
      expect((await request(withoutHeader("x-opencodex-csrf-token"))).status).toBe(401);
      expect((await request({ ...base, Host: `127.0.0.1:${server.port}` })).status).toBe(401);
      expect((await request({ ...base, "x-opencodex-csrf-token": "" })).status).toBe(401);
      expect(calls).toEqual([]);
      expect((await request(base)).status).toBe(200);
      expect(calls).toEqual([operation.name]);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);
});
