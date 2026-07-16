import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { XAI_OAUTH_DISCOVERY_URL } from "../src/oauth/xai";
import { saveCredential } from "../src/oauth/store";
import { XAI_GROK_CLI_BASE_URL } from "../src/providers/xai-transport";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const TOKEN_ENDPOINT = "https://auth.x.ai/oauth/token";
const CHAT_ENDPOINT = `${XAI_GROK_CLI_BASE_URL}/chat/completions`;

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-xai-401-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-xai-401-"));
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

function seedOAuth(): void {
  saveCredential("xai", {
    access: "rejected-access",
    refresh: "initial-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "xai-test-account",
    source: "oauth",
  });
}

function xaiConfig(authMode: "oauth" | "key" = "oauth"): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode,
        ...(authMode === "key" ? { apiKey: "xai-api-key" } : {}),
        models: ["grok-4.5"],
      },
    },
  } as OcxConfig;
}

function successBody(text: string): string {
  return JSON.stringify({
    id: "chatcmpl-xai-401",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

async function post(server: ReturnType<typeof startServer>): Promise<Response> {
  return originalFetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "xai/grok-4.5", input: "hello", stream: false }),
  });
}

function installOAuthFetch(chatStatuses: number[]): { chatAuth: string[]; counts: { refresh: number } } {
  const chatAuth: string[] = [];
  const counts = { refresh: 0 };
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === XAI_OAUTH_DISCOVERY_URL) {
      return new Response(JSON.stringify({
        authorization_endpoint: "https://auth.x.ai/oauth/authorize",
        token_endpoint: TOKEN_ENDPOINT,
      }), { headers: { "content-type": "application/json" } });
    }
    if (url === TOKEN_ENDPOINT) {
      counts.refresh += 1;
      return new Response(JSON.stringify({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      }), { headers: { "content-type": "application/json" } });
    }
    if (url === CHAT_ENDPOINT) {
      chatAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      const status = chatStatuses.shift() ?? 200;
      if (status === 401) {
        return new Response(JSON.stringify({ error: { message: "rejected" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(successBody("ok after refresh"), { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return { chatAuth, counts };
}

describe("xAI OAuth upstream 401 replay", () => {
  test("401 then 200 performs one refresh and one replay", async () => {
    seedOAuth();
    saveConfig(xaiConfig());
    const observed = installOAuthFetch([401, 200]);
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(200);
      const json = await response.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      expect(json.output?.find(item => item.type === "message")?.content?.[0]?.text).toBe("ok after refresh");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
    } finally {
      server.stop(true);
    }
  });

  test("401 then 401 replays once and propagates the second error", async () => {
    seedOAuth();
    saveConfig(xaiConfig());
    const observed = installOAuthFetch([401, 401]);
    const server = startServer(0);
    try {
      const response = await post(server);
      const json = await response.json() as { error?: { message?: string } };
      expect(response.status).toBe(401);
      expect(json.error?.message).toContain("Provider error 401");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
    } finally {
      server.stop(true);
    }
  });

  test("API-key xAI path never attempts OAuth refresh", async () => {
    saveConfig(xaiConfig("key"));
    let refreshCalls = 0;
    let chatCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === XAI_OAUTH_DISCOVERY_URL || url === TOKEN_ENDPOINT) {
        refreshCalls += 1;
        return new Response("unexpected", { status: 500 });
      }
      if (url === "https://api.x.ai/v1/chat/completions") {
        chatCalls += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-api-key");
        return new Response(JSON.stringify({ error: { message: "key rejected" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(401);
      expect(chatCalls).toBe(1);
      expect(refreshCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("concurrent 401 responses join one IdP refresh", async () => {
    seedOAuth();
    saveConfig(xaiConfig());
    let refreshCalls = 0;
    let signalRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>(resolve => { signalRefreshStarted = resolve; });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    let releaseRejectedRequests!: () => void;
    const rejectedRequestsReady = new Promise<void>(resolve => { releaseRejectedRequests = resolve; });
    const attemptsByBearer = new Map<string, number>();
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === XAI_OAUTH_DISCOVERY_URL) {
        return new Response(JSON.stringify({
          authorization_endpoint: "https://auth.x.ai/oauth/authorize",
          token_endpoint: TOKEN_ENDPOINT,
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === TOKEN_ENDPOINT) {
        refreshCalls += 1;
        signalRefreshStarted();
        await refreshGate;
        return new Response(JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === CHAT_ENDPOINT) {
        const bearer = new Headers(init?.headers).get("authorization") ?? "";
        attemptsByBearer.set(bearer, (attemptsByBearer.get(bearer) ?? 0) + 1);
        if (bearer === "Bearer rejected-access") {
          if (attemptsByBearer.get(bearer) === 2) releaseRejectedRequests();
          await rejectedRequestsReady;
          return new Response(JSON.stringify({ error: { message: "rejected" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(successBody("concurrent ok"), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const first = post(server);
      const second = post(server);
      await refreshStarted;
      releaseRefresh();
      const [a, b] = await Promise.all([first, second]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(refreshCalls).toBe(1);
      expect(attemptsByBearer.get("Bearer rejected-access")).toBe(2);
      expect(attemptsByBearer.get("Bearer fresh-access")).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});
