/**
 * `GET|HEAD /v1/hub-state` — the hub's answer to "what can you actually serve?" (#4236).
 *
 * Two things are being pinned, and they pull in opposite directions. The route must be
 * REACHABLE with nothing but a per-client data key, because the client holds nothing else and
 * the alternative an operator reaches for is handing out an admin token. And it must carry no
 * credential, no email and no account id, because a data key is the weakest thing that opens
 * it. The serialized-body scan below is the half that cannot be satisfied by reading the
 * projection: it configures real-looking provider keys and a real-looking OAuth credential
 * (access token, refresh token, email) and asserts none of those bytes appear in the response.
 *
 * The role gate gets its own cases because it is the reason a standalone install gains no new
 * surface at all, and because it runs AFTER admission on purpose — answering an anonymous
 * caller would turn the route into a free "is that host a hub?" probe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { MAX_HUB_STATE_BYTES, parseHubStateBody } from "../../src/remote/hub-state";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const DATA_KEY = "ocx_data_hubstatereader";
// Deliberately NOT an `sk-…` shape: the privacy scan refuses one in a tracked file, and the
// assertion below only needs a distinctive string to hunt for in the response bytes.
const PROVIDER_KEY = "provider-credential-hub-state-9e1f";
const OAUTH_ACCESS = "oauth-access-hub-state-7c2a";
const OAUTH_REFRESH = "oauth-refresh-hub-state-4b8d";
const OAUTH_EMAIL = "hub-operator@example.test";

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let testHome = "";

function hubConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    // Non-loopback so admission is required and the origin check is live.
    hostname: "0.0.0.0",
    defaultProvider: "xai",
    runtimeRole: "hub",
    hub: { dataPublicOrigin: "https://hub.example.test:8443" },
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        apiKey: PROVIDER_KEY,
        authMode: "oauth",
        models: ["grok-4.6"],
      },
      quiet: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true, models: ["m"] },
    },
    subagentModels: ["xai/grok-4.6", "gpt-5.6-sol"],
    // Pinned so the one-time roster migration does not prepend the native default and make the
    // roster assertion below about migration rather than about what the hub reports.
    subagentModelsVersion: 1,
    apiKeys: [{ id: "client-one", name: "laptop", key: DATA_KEY, createdAt: "2026-09-01T00:00:00.000Z" }],
    ...overrides,
  } as OcxConfig;
}

/** The legacy single-credential shape normalizes on load, which is all this needs. */
function writeLoggedInXai(): void {
  writeFileSync(join(testHome, "auth.json"), JSON.stringify({
    xai: {
      access: OAUTH_ACCESS,
      refresh: OAUTH_REFRESH,
      expires: Date.now() + 3_600_000,
      email: OAUTH_EMAIL,
    },
  }));
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-hub-state-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "hub-admission-secret";
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("GET /v1/hub-state", () => {
  test("refuses an unauthenticated read before it reveals whether this host is a hub", async () => {
    saveConfig(hubConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/hub-state", server.url));
      expect(res.status).toBe(401);
      // The role is not disclosed on the 401 path: the gate runs after admission.
      const body = await res.text();
      expect(body).not.toContain("hub_state_not_a_hub");
    } finally {
      await server.stop(true);
    }
  });

  test("a per-client data key reads the hub's providers, logins and roster", async () => {
    saveConfig(hubConfig());
    writeLoggedInXai();
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/hub-state", server.url), {
        headers: { "x-opencodex-api-key": DATA_KEY },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      // No validator to revalidate with, for the same reason /v1/catalog emits none.
      expect(res.headers.get("etag")).toBeNull();
      const text = await res.text();
      const state = parseHubStateBody(JSON.parse(text));
      expect(state).not.toBeNull();
      expect(state!.runtimeRole).toBe("hub");
      expect(state!.origin).toBe("https://hub.example.test:8443");
      expect(typeof state!.hubVersion).toBe("string");
      // The exact defect: the hub HAS xai and IS logged in, and a client must be able to see it.
      expect(state!.providers.find(p => p.name === "xai")).toEqual({
        name: "xai",
        adapter: "openai-chat",
        authMode: "oauth",
        hasCredential: true,
        disabled: false,
      });
      // A disabled provider is not exported at all: `/v1/catalog` and `/v1/models` filter it
      // out, so naming it here would be the only place a data key learns it exists.
      expect(state!.providers.map(p => p.name)).not.toContain("quiet");
      expect(text).not.toContain("quiet");
      expect(state!.truncated).toBe(false);
      expect(state!.oauth.find(entry => entry.provider === "xai")?.loggedIn).toBe(true);
      expect(state!.subagentModels).toEqual(["xai/grok-4.6", "gpt-5.6-sol"]);
      expect(state!.claudeCode.enabled).toBe(true);
      expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(text));
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_HUB_STATE_BYTES);
    } finally {
      await server.stop(true);
    }
  });

  test("the serialized body carries no key, token, email or account id", async () => {
    saveConfig(hubConfig());
    writeLoggedInXai();
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/hub-state", server.url), {
        headers: { "x-opencodex-api-key": DATA_KEY },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of [PROVIDER_KEY, OAUTH_ACCESS, OAUTH_REFRESH, OAUTH_EMAIL, DATA_KEY, "hub-admission-secret"]) {
        expect(text).not.toContain(secret);
      }
      // Field names too: an accidental spread would bring the key along with its value.
      for (const field of ["apiKey", "accessToken", "refreshToken", "\"access\"", "\"refresh\"", "email", "accountId", "activeAccountId"]) {
        expect(text).not.toContain(field);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("HEAD answers with the same status and headers and no body", async () => {
    saveConfig(hubConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/hub-state", server.url), {
        method: "HEAD",
        headers: { "x-opencodex-api-key": DATA_KEY },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
      expect(await res.text()).toBe("");
    } finally {
      await server.stop(true);
    }
  });

  test("a cross-origin browser read is refused even with a valid key", async () => {
    saveConfig(hubConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/hub-state", server.url), {
        headers: { "x-opencodex-api-key": DATA_KEY, origin: "https://attacker.test" },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "origin_rejected" } });
    } finally {
      await server.stop(true);
    }
  });

  test.each(["standalone", undefined] as const)("runtimeRole %s serves no hub state", async role => {
    saveConfig(hubConfig(role === undefined ? { runtimeRole: undefined } : { runtimeRole: role }));
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/hub-state", server.url), {
        headers: { "x-opencodex-api-key": DATA_KEY },
      });
      expect(res.status).toBe(404);
      // A distinct code, not the generic not_found: it is what tells "this host is not a hub"
      // apart from "this build has no such route", and the latter would pass vacuously.
      expect(await res.json()).toMatchObject({ error: { code: "hub_state_not_a_hub" } });
    } finally {
      await server.stop(true);
    }
  });

  test("hitting a cap is reported as truncated rather than silently clipped", async () => {
    // 201 providers against a 200 cap. A body that simply stopped at 200 would tell a client the
    // other provider does not exist, which is the same confident-and-wrong report #4236 is about.
    const providers: Record<string, unknown> = {};
    for (let i = 0; i < 201; i += 1) {
      providers[`p${i}`] = { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: ["m"] };
    }
    saveConfig(hubConfig({ providers: providers as OcxConfig["providers"], defaultProvider: "p0" }));
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/hub-state", server.url), {
        headers: { "x-opencodex-api-key": DATA_KEY },
      });
      expect(res.status).toBe(200);
      const state = parseHubStateBody(await res.json());
      expect(state).not.toBeNull();
      expect(state!.providers).toHaveLength(200);
      expect(state!.truncated).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("POST is not a hub-state verb", async () => {
    saveConfig(hubConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/hub-state", server.url), {
        method: "POST",
        headers: { "x-opencodex-api-key": DATA_KEY, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).not.toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});
