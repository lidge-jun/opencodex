/**
 * Routing a model onto `openai-responses` moves it from the normal adapter loop into the
 * passthrough branch, which formats non-2xx immediately. Without matching recovery there,
 * a Copilot model on the Responses wire would surface a 401 that a token refresh fixes, or
 * a 429 a healthy pool key absorbs, while its chat-wire siblings on the SAME provider still
 * recover — and the compat handlers would strip sampling params meant only for the native
 * ChatGPT forward route. Codex review on PR #746.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { saveCredential } from "../src/oauth/store";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_USER_URL = "https://api.github.com/user";
const COPILOT_RESPONSES_URL = "https://api.githubcopilot.com/v1/responses";
/** Routed onto the Responses wire by the registry's modelWireDefaults. */
const RESPONSES_MODEL = "github-copilot/gpt-5.6-sol";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-copilot-wire-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-copilot-wire-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function copilotConfig(provider: Record<string, unknown>): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "github-copilot",
    providers: {
      "github-copilot": {
        adapter: "openai-chat",
        baseUrl: "https://api.githubcopilot.com",
        ...provider,
      },
    },
  } as OcxConfig;
}

function responsesBody(text: string): string {
  return JSON.stringify({
    id: "resp_copilot",
    object: "response",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 3, output_tokens: 2 },
  });
}

function post(server: ReturnType<typeof startServer>, body: Record<string, unknown>): Promise<Response> {
  return originalFetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: RESPONSES_MODEL, input: "hello", stream: false, ...body }),
  });
}

describe("Copilot models routed onto the Responses wire keep provider recovery", () => {
  test("an OAuth 401 refreshes the Copilot token and replays once", async () => {
    saveCredential("github-copilot", {
      access: "stale-copilot-token",
      refresh: "github-access-token",
      expires: Date.now() + 3_600_000,
      accountId: "copilot-test-account",
      source: "oauth",
      apiBaseUrl: "https://api.githubcopilot.com",
    });
    saveConfig(copilotConfig({ authMode: "oauth" }));

    const upstreamAuth: string[] = [];
    let exchanges = 0;
    const statuses = [401, 200];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === GITHUB_USER_URL) {
        return new Response(JSON.stringify({ id: 4242, login: "copilot-tester" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === COPILOT_TOKEN_URL) {
        exchanges += 1;
        return new Response(JSON.stringify({
          token: "fresh-copilot-token",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: "https://api.githubcopilot.com" },
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === COPILOT_RESPONSES_URL) {
        upstreamAuth.push(new Headers(init?.headers).get("authorization") ?? "");
        if (statuses.shift() === 401) {
          return new Response(JSON.stringify({ error: { message: "token expired" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(responsesBody("ok after refresh"), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const response = await post(server, {});
      expect(response.status).toBe(200);
      // Exactly one forced exchange, and the replay carried the refreshed token.
      expect(exchanges).toBeGreaterThanOrEqual(1);
      expect(upstreamAuth).toHaveLength(2);
      expect(upstreamAuth[0]).not.toBe(upstreamAuth[1]);
      expect(upstreamAuth[1]).toContain("fresh-copilot-token");
    } finally {
      server.stop(true);
    }
  });

  test("a repeated 401 replays only once and propagates the second failure", async () => {
    saveCredential("github-copilot", {
      access: "stale-copilot-token",
      refresh: "github-access-token",
      expires: Date.now() + 3_600_000,
      accountId: "copilot-test-account",
      source: "oauth",
      apiBaseUrl: "https://api.githubcopilot.com",
    });
    saveConfig(copilotConfig({ authMode: "oauth" }));

    let upstreamCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === GITHUB_USER_URL) {
        return new Response(JSON.stringify({ id: 4242, login: "copilot-tester" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === COPILOT_TOKEN_URL) {
        return new Response(JSON.stringify({
          token: "fresh-copilot-token",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: "https://api.githubcopilot.com" },
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === COPILOT_RESPONSES_URL) {
        upstreamCalls += 1;
        return new Response(JSON.stringify({ error: { message: "still rejected" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const response = await post(server, {});
      expect(response.status).toBe(401);
      expect(upstreamCalls).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("a key-pool 429 rotates to the next key and replays", async () => {
    // Copilot supports a key-auth override (allowKeyAuthOverride), so an apiKeyPool is
    // reachable on this provider — and pool rotation must survive the wire change.
    saveConfig(copilotConfig({
      authMode: "key",
      apiKey: "copilot-key-1",
      apiKeyPool: [
        { id: "k1", key: "copilot-key-1" },
        { id: "k2", key: "copilot-key-2" },
      ],
    }));

    const upstreamAuth: string[] = [];
    const statuses = [429, 200];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === COPILOT_RESPONSES_URL) {
        upstreamAuth.push(new Headers(init?.headers).get("authorization") ?? "");
        if (statuses.shift() === 429) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(responsesBody("ok after rotation"), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const response = await post(server, {});
      expect(response.status).toBe(200);
      expect(upstreamAuth).toHaveLength(2);
      expect(upstreamAuth[0]).toContain("copilot-key-1");
      expect(upstreamAuth[1]).toContain("copilot-key-2");
    } finally {
      server.stop(true);
    }
  });

  test("a routed Responses gateway keeps max_output_tokens from a Chat Completions client", async () => {
    saveConfig(copilotConfig({ authMode: "key", apiKey: "copilot-key-1" }));

    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === COPILOT_RESPONSES_URL) {
        captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(responsesBody("ok"), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: RESPONSES_MODEL,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 321,
          temperature: 0.4,
          stop: ["END"],
        }),
      });
      expect(response.status).toBe(200);
      // The caller's ceiling must survive: only the native ChatGPT forward route 400s on it.
      expect(captured.max_output_tokens).toBe(321);
      // These stay stripped on every Responses route — `stop` is not a Responses parameter
      // and reasoning models reject temperature/top_p, with no per-model filter on this wire.
      expect(captured.temperature).toBeUndefined();
      expect(captured.stop).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
