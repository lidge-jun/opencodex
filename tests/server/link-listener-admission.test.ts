import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { linkStorePath } from "../../src/link/paths";
import { emptyLinkStore, writeLinkStore } from "../../src/link/store";
import { requestPolicyView, resolveApiAuth } from "../../src/server/auth-cors";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const ENV_KEY = "link-env-admission";
const OTHER_KEY = "link-other-admission";
const PENDING_KEY = "link-pending-admission";
const LINKED_KEY = "link-linked-admission";
const LINKED_ID = "linked-key";

type RouteExpectation = "ready" | "catalog" | "models" | "hub-state" | "usage" | "artifact-missing" | "handler-error";
type Route = { method: "GET" | "POST"; path: string; body?: string; expectation: RouteExpectation };
type JsonBody = {
  [key: string]: unknown;
  error?: { code?: unknown; type?: unknown; message?: unknown };
};

/**
 * | route | linked-key oracle |
 * |---|---|
 * | /readyz | 200/503 readiness JSON |
 * | /v1/catalog | 200 catalog object with models[] |
 * | /v1/models | 200 OpenAI list with data[] |
 * | /v1/hub-state | 200 hub-state object |
 * | /v1/usage | 200 usage object, or its handler's 503/507 error |
 * | /v1/opencodex/artifacts/missing | 404 artifact-not-found handler error |
 * | every POST route | handler validation error with a non-auth, non-unknown-endpoint code/message |
 */
const ROUTES: readonly Route[] = [
  { method: "GET", path: "/readyz", expectation: "ready" },
  { method: "GET", path: "/v1/catalog", expectation: "catalog" },
  { method: "GET", path: "/v1/hub-state", expectation: "hub-state" },
  { method: "GET", path: "/v1/usage", expectation: "usage" },
  { method: "GET", path: "/v1/models", expectation: "models" },
  { method: "POST", path: "/v1/responses", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/responses/compact", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/chat/completions", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/messages", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/messages/count_tokens", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/images/generations", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/images/edits", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/audio/transcriptions", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/realtime/calls", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/live", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/search", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/history/v2/list_windows", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/history/v2/list_items", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/history/v2/read_item", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/history/v2/search_contents", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/notes/v2/thread_hint", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/notes/v2/list_files_by_prefix", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/notes/v2/read_file", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/notes/v2/search_contents", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/notes/v2/append_to_file", body: "{}", expectation: "handler-error" },
  { method: "POST", path: "/v1/alpha/notes/v2/write_file", body: "{}", expectation: "handler-error" },
  { method: "GET", path: "/v1/opencodex/artifacts/missing", expectation: "artifact-missing" },
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
  writeFileSync(join(codexHome.path, "config.toml"), "[features]\ncontext_management.experimental_mode = true\n");
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
  test("context revalidation refreshes the link policy after asynchronous request work", () => {
    const source = readFileSync(repoPath("src/server/index/serve-options.ts"), "utf8");
    expect(source).toContain('() => resolveApiAuth(req, ingress === "hub-link" ? linkPolicy() : policy)');

    const liveConfig = config();
    const req = new Request("http://opencodex-link.invalid/v1/alpha/notes/v2/read_file", { headers: headers(LINKED_KEY) });
    const initialPolicy = requestPolicyView(liveConfig, "opencodex-link.invalid", { allowedKeyIds: new Set([LINKED_ID]) });
    expect(resolveApiAuth(req, initialPolicy)?.kind).toBe("configured");
    liveConfig.apiKeys = liveConfig.apiKeys?.filter(key => key.id !== LINKED_ID);
    const refreshedPolicy = requestPolicyView(liveConfig, "opencodex-link.invalid", { allowedKeyIds: new Set([LINKED_ID]) });
    expect(resolveApiAuth(req, refreshedPolicy)).toBeNull();
  });

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
      const body = await admitted.json() as JsonBody;
      if (route.expectation === "ready") {
        expect([200, 503]).toContain(admitted.status);
        expect(body.service).toBe("opencodex");
        expect(["ready", "pending", "failed"]).toContain(body.status);
      } else if (route.expectation === "catalog") {
        expect(admitted.status).toBe(200);
        expect(Array.isArray(body.models)).toBe(true);
      } else if (route.expectation === "models") {
        expect(admitted.status).toBe(200);
        expect(body.object).toBe("list");
        expect(Array.isArray(body.data)).toBe(true);
      } else if (route.expectation === "hub-state") {
        expect(admitted.status).toBe(200);
        expect(body.runtimeRole).toBe("hub");
        expect(Array.isArray(body.providers)).toBe(true);
      } else if (route.expectation === "usage") {
        expect([200, 503, 507]).toContain(admitted.status);
        if (admitted.status === 200) {
          expect(body.schemaVersion).toBe(1);
          expect(body.source).toBe("hub");
          expect(body.scope).toBe("client");
        } else {
          expect(String(body.error?.code)).toMatch(/^hub_usage_/);
          expect(typeof body.error?.message).toBe("string");
        }
      } else if (route.expectation === "artifact-missing") {
        expect(admitted.status).toBe(404);
        expect(body.error?.code).toBe("not_found");
        expect(body.error?.message).toContain("artifact");
      } else {
        const errorCode = typeof body.error?.code === "string" ? body.error.code : body.error?.type;
        expect(admitted.status).toBeGreaterThanOrEqual(400);
        expect(admitted.status).toBeLessThan(600);
        expect(admitted.status).not.toBe(401);
        expect(admitted.status).not.toBe(404);
        expect(typeof errorCode).toBe("string");
        expect(errorCode).not.toBe("authentication_error");
        expect(errorCode).not.toBe("not_found");
        expect(typeof body.error?.message).toBe("string");
        expect(body.error.message).not.toContain("opencodex API key required");
        expect(body.error.message).not.toContain("Unknown endpoint");
      }
    }
  });

  test("does not bind a hub-link listener when the store has no links", async () => {
    await server!.stop(true);
    server = null;
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
    const unusedLinkPort = probe.port;
    await probe.stop(true);
    writeLinkStore(linkStorePath(), { ...emptyLinkStore(), listenerPort: unusedLinkPort });
    const { startServer } = await import("../../src/server");
    server = startServer(0);
    const linkPortProbe = Bun.serve({ hostname: "127.0.0.1", port: unusedLinkPort, fetch: () => new Response("free") });
    expect(linkPortProbe.port).toBe(unusedLinkPort);
    await linkPortProbe.stop(true);
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
