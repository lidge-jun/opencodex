import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore } from "../../src/link/store";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ENV_KEY = "link-env-admission";
const OTHER_KEY = "link-other-admission";
const PENDING_KEY = "link-pending-admission";
const LINKED_KEY = "link-linked-admission";
const LINKED_ID = "linked-key";

type Route = { method: "GET" | "POST"; path: string; body?: string };

const ROUTES: readonly Route[] = [
  { method: "GET", path: "/readyz" },
  { method: "GET", path: "/v1/catalog" },
  { method: "GET", path: "/v1/hub-state" },
  { method: "GET", path: "/v1/usage" },
  { method: "GET", path: "/v1/models" },
  { method: "POST", path: "/v1/responses", body: "{}" },
  { method: "POST", path: "/v1/responses/compact", body: "{}" },
  { method: "POST", path: "/v1/chat/completions", body: "{}" },
  { method: "POST", path: "/v1/messages", body: "{}" },
  { method: "POST", path: "/v1/messages/count_tokens", body: "{}" },
  { method: "POST", path: "/v1/images/generations", body: "{}" },
  { method: "POST", path: "/v1/images/edits", body: "{}" },
  { method: "POST", path: "/v1/audio/transcriptions", body: "{}" },
  { method: "POST", path: "/v1/realtime/calls", body: "{}" },
  { method: "POST", path: "/v1/live", body: "{}" },
  { method: "POST", path: "/v1/alpha/search", body: "{}" },
  { method: "POST", path: "/v1/alpha/history/v2/list_windows", body: "{}" },
  { method: "POST", path: "/v1/alpha/history/v2/list_items", body: "{}" },
  { method: "POST", path: "/v1/alpha/history/v2/read_item", body: "{}" },
  { method: "POST", path: "/v1/alpha/history/v2/search_contents", body: "{}" },
  { method: "POST", path: "/v1/alpha/notes/v2/thread_hint", body: "{}" },
  { method: "POST", path: "/v1/alpha/notes/v2/list_files_by_prefix", body: "{}" },
  { method: "POST", path: "/v1/alpha/notes/v2/read_file", body: "{}" },
  { method: "POST", path: "/v1/alpha/notes/v2/search_contents", body: "{}" },
  { method: "POST", path: "/v1/alpha/notes/v2/append_to_file", body: "{}" },
  { method: "POST", path: "/v1/alpha/notes/v2/write_file", body: "{}" },
  { method: "GET", path: "/v1/opencodex/artifacts/missing" },
];

const previous = {
  home: process.env.OPENCODEX_HOME,
  codexHome: process.env.CODEX_HOME,
  apiToken: process.env.OPENCODEX_API_AUTH_TOKEN,
};
let testHome = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(closeActiveConnections?: boolean): Promise<void>; port?: number; url: URL } | null = null;

function key(id: string, value: string, pendingRotation?: { id: string; key: string; createdAt: string; expiresAt: string }) {
  return { id, name: id, key: value, createdAt: "2026-09-25T00:00:00.000Z", ...(pendingRotation ? { pendingRotation } : {}) };
}

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    runtimeRole: "hub",
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, models: ["test-model"] },
    },
    apiKeys: [
      key("other-key", OTHER_KEY),
      key("pending-key", "pending-base", {
        id: "pending-rotation",
        key: PENDING_KEY,
        createdAt: "2026-09-25T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      key(LINKED_ID, LINKED_KEY),
    ],
    clientIntegrations: { codex: false },
  } as OcxConfig;
}

function headers(value: string): HeadersInit {
  return { "x-opencodex-api-key": value, "content-type": "application/json" };
}

async function request(base: string, route: Route, credential?: string, extra?: HeadersInit): Promise<Response> {
  return fetch(`${base}${route.path}`, {
    method: route.method,
    headers: { ...(credential ? headers(credential) : {}), ...(extra ?? {}) },
    ...(route.body === undefined ? {} : { body: route.body }),
  });
}

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-link-admission-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = ENV_KEY;
  codexHome = installIsolatedCodexHome("ocx-link-admission-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "mock/test-model" }] }));
  const { saveConfig } = await import("../../src/config");
  writeLinkStore(linkStorePath(), {
    version: 1,
    listenerPort: null,
    links: [{
      id: "lnk_0123456789abcdef",
      alias: "admission-test",
      direction: "client-initiated",
      hostKeyFingerprint: "SHA256:abcdefghijklmnop",
      tunnelPort: 2222,
      apiKeyId: LINKED_ID,
      createdAt: "2026-09-25T00:00:00.000Z",
    }],
  });
  saveConfig(config());
  const { startServer } = await import("../../src/server");
  server = startServer(0);
});

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  codexHome?.restore();
  codexHome = null;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous.home;
  if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous.codexHome;
  if (previous.apiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previous.apiToken;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("hub-link admission", () => {
  test("applies the four-credential matrix on every allowlisted route", async () => {
    const linkPort = JSON.parse(await Bun.file(linkStorePath()).text()).listenerPort as number;
    const base = `http://127.0.0.1:${linkPort}`;
    const denied = [["environment", ENV_KEY], ["unlinked active", OTHER_KEY], ["pending rotation", PENDING_KEY]] as const;
    for (const route of ROUTES) {
      for (const [label, credential] of denied) {
        const response = await request(base, route, credential);
        expect({ route: route.path, label, status: response.status }).toEqual({ route: route.path, label, status: 401 });
      }
      const admitted = await request(base, route, LINKED_KEY);
      const body = await admitted.text();
      expect({ route: route.path, status: admitted.status }).not.toMatchObject({ status: 401 });
      expect(body).not.toContain("opencodex API key required");
    }
  });

  test("rejects every upgrade attempt before a handler and keeps the link allowlist closed", async () => {
    const linkPort = JSON.parse(await Bun.file(linkStorePath()).text()).listenerPort as number;
    const base = `http://127.0.0.1:${linkPort}`;
    for (const route of ROUTES) {
      for (const upgrade of ["websocket", "h2c"]) {
        const response = await request(base, route, LINKED_KEY, { connection: "Upgrade", upgrade });
        expect({ route: route.path, upgrade, status: response.status }).toEqual({ route: route.path, upgrade, status: 404 });
      }
    }
    for (const path of ["/", "/dashboard", "/api/config", "/opencodex-session", "/healthz", "/v1/no-such"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${base}/readyz`, { method: "HEAD", headers: headers(LINKED_KEY) })).status).toBe(404);
    expect((await fetch(`${base}/v1/catalog`, { method: "HEAD", headers: headers(LINKED_KEY) })).status).toBe(200);
  });
});
