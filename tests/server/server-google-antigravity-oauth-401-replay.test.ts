import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { forceRefreshOAuthAccessSnapshot, getValidAccessTokenSnapshot } from "../../src/oauth";
import { saveCredential } from "../../src/oauth/store";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DAILY_API_BASE = "https://daily-cloudcode-pa.googleapis.com";
const PUBLIC_OAUTH_AUTHENTICATION_ERROR = "OAuth authentication failed. Check the OpenCodex account status and retry.";
const WINDOWS_PATH_CANARY = "C:\\Users\\Alice\\.opencodex\\auth.json.ocx-tmp";
const UNC_PATH_CANARY = "\\\\server\\share\\opencodex\\auth.json.ocx-tmp";
const POSIX_PATH_CANARY = "/home/alice/.opencodex/auth.json.ocx-tmp";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-google-401-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-google-401-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

async function seedOAuth(expires = Date.now() + 3_600_000): Promise<void> {
  await saveCredential("google-antigravity", {
    access: "rejected-access",
    refresh: "initial-refresh",
    expires,
    accountId: "antigravity-test-account",
    projectId: "initial-project-id",
    source: "oauth",
  });
}

function antigravityConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "google",
        baseUrl: DAILY_API_BASE,
        authMode: "oauth",
        googleMode: "cloud-code-assist",
        project: "initial-project-id",
        models: ["gemini-3.8-flash"],
      },
    },
  } as OcxConfig;
}

function jsonSuccessBody(text: string): Record<string, unknown> {
  return {
    response: {
      candidates: [{
        content: {
          role: "model",
          parts: [{ text }],
        },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8,
      },
    },
  };
}

function sseSuccessBody(text: string): string {
  return `data: ${JSON.stringify(jsonSuccessBody(text))}\n\n`;
}

async function postResponses(server: ReturnType<typeof startServer>): Promise<Response> {
  return originalFetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "google-antigravity/gemini-3.8-flash",
      input: "hello",
      stream: false,
    }),
  });
}

async function postChat(server: ReturnType<typeof startServer>): Promise<Response> {
  return originalFetch(new URL("/v1/chat/completions", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "google-antigravity/gemini-3.8-flash",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });
}

function installOAuthFetch(
  apiStatuses: number[],
  options: {
    tokenErrorDescription?: string;
    refreshedProjectId?: string;
  } = {},
): { chatAuth: string[]; chatProjects: string[]; counts: { refresh: number } } {
  const chatAuth: string[] = [];
  const chatProjects: string[] = [];
  const counts = { refresh: 0 };
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    // Google OAuth refresh token endpoint
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      counts.refresh += 1;
      if (options.tokenErrorDescription !== undefined) {
        return new Response(JSON.stringify({
          error: "invalid_grant",
          error_description: options.tokenErrorDescription,
        }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      }), { headers: { "content-type": "application/json" } });
    }

    // Google Cloud Code Assist project discovery
    if (url.includes(":loadCodeAssist")) {
      return new Response(JSON.stringify({
        cloudaicompanionProject: options.refreshedProjectId ?? "refreshed-project-id",
      }), { headers: { "content-type": "application/json" } });
    }

    // Google Antigravity Generate Content endpoint
    if (url.includes("/v1internal:streamGenerateContent") || url.includes("/v1internal:generateContent")) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      chatAuth.push(auth);
      if (typeof init?.body === "string") {
        try {
          const parsedBody = JSON.parse(init.body) as { project?: string };
          if (parsedBody.project) chatProjects.push(parsedBody.project);
        } catch { /* ignore */ }
      }
      const status = apiStatuses.shift() ?? 200;
      if (status === 401) {
        return new Response(JSON.stringify({
          error: {
            code: 401,
            message: "Request had invalid authentication credentials.",
            status: "UNAUTHENTICATED",
          },
        }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("alt=sse")) {
        return new Response(sseSuccessBody("ok after google refresh"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify(jsonSuccessBody("ok after google refresh")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return originalFetch(input, init);
  }) as typeof fetch;
  return { chatAuth, chatProjects, counts };
}

describe("Google Antigravity OAuth upstream 401 replay", () => {
  test("forceRefreshOAuthAccessSnapshot supports google-antigravity", async () => {
    await seedOAuth();
    installOAuthFetch([], { refreshedProjectId: "rediscovered-project-xyz" });

    const snapshot = await getValidAccessTokenSnapshot("google-antigravity");
    expect(snapshot.provider).toBe("google-antigravity");
    expect(snapshot.accessToken).toBe("rejected-access");

    const refreshed = await forceRefreshOAuthAccessSnapshot(snapshot);
    expect(refreshed.provider).toBe("google-antigravity");
    expect(refreshed.accessToken).toBe("fresh-access");
    expect(refreshed.projectId).toBe("rediscovered-project-xyz");
  });

  test("initial OAuth refresh projects raw provider failures before responding", async () => {
    await seedOAuth(0);
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([], {
      tokenErrorDescription: `EACCES writing ${WINDOWS_PATH_CANARY}, ${UNC_PATH_CANARY}, or ${POSIX_PATH_CANARY}`,
    });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      const json = await response.json() as { error?: { code?: string; message?: string; type?: string } };
      const message = json.error?.message ?? "";
      expect(response.status).toBe(401);
      expect(json.error?.type).toBe("authentication_error");
      expect(message).toBe(PUBLIC_OAUTH_AUTHENTICATION_ERROR);
      expect(message).not.toContain(WINDOWS_PATH_CANARY);
      expect(message).not.toContain(UNC_PATH_CANARY);
      expect(message).not.toContain(POSIX_PATH_CANARY);
      expect(message).not.toContain("auth.json");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("OAuth 401 replay projects raw refresh failures before responding", async () => {
    await seedOAuth();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401], {
      tokenErrorDescription: `EACCES writing ${WINDOWS_PATH_CANARY}, ${UNC_PATH_CANARY}, or ${POSIX_PATH_CANARY}`,
    });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      const json = await response.json() as { error?: { code?: string; message?: string; type?: string } };
      const message = json.error?.message ?? "";
      expect(response.status).toBe(401);
      expect(json.error?.type).toBe("authentication_error");
      expect(message).toBe(PUBLIC_OAUTH_AUTHENTICATION_ERROR);
      expect(message).not.toContain(WINDOWS_PATH_CANARY);
      expect(message).not.toContain(UNC_PATH_CANARY);
      expect(message).not.toContain(POSIX_PATH_CANARY);
      expect(message).not.toContain("auth.json");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access"]);
    } finally {
      await server.stop(true);
    }
  });

  test("401 then 200 on /v1/responses performs one refresh and one replay with refreshed token and project", async () => {
    await seedOAuth();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 200], { refreshedProjectId: "new-project-456" });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(200);
      const json = await response.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      expect(json.output?.find(item => item.type === "message")?.content?.[0]?.text).toBe("ok after google refresh");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "new-project-456"]);
    } finally {
      await server.stop(true);
    }
  });

  test("401 then 200 on /v1/chat/completions performs one refresh and one replay seamlessly", async () => {
    await seedOAuth();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 200], { refreshedProjectId: "chat-project-789" });
    const server = startServer(0);
    try {
      const response = await postChat(server);
      expect(response.status).toBe(200);
      const json = await response.json() as { choices?: { message?: { content?: string } }[] };
      expect(json.choices?.[0]?.message?.content).toBe("ok after google refresh");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "chat-project-789"]);
    } finally {
      await server.stop(true);
    }
  });

  test("401 then 401 replays once and propagates the second error cleanly", async () => {
    await seedOAuth();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 401]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(401);
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
    } finally {
      await server.stop(true);
    }
  });

  test("concurrent 401 responses join one IdP refresh", async () => {
    await seedOAuth();
    saveConfig(antigravityConfig());
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
      if (url === GOOGLE_TOKEN_ENDPOINT) {
        refreshCalls += 1;
        signalRefreshStarted();
        await refreshGate;
        return new Response(JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.includes(":loadCodeAssist")) {
        return new Response(JSON.stringify({
          cloudaicompanionProject: "concurrent-project-id",
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("/v1internal:streamGenerateContent") || url.includes("/v1internal:generateContent")) {
        const bearer = new Headers(init?.headers).get("authorization") ?? "";
        attemptsByBearer.set(bearer, (attemptsByBearer.get(bearer) ?? 0) + 1);
        if (bearer === "Bearer rejected-access") {
          if (attemptsByBearer.get(bearer) === 2) releaseRejectedRequests();
          await rejectedRequestsReady;
          return new Response(JSON.stringify({
            error: {
              code: 401,
              message: "Request had invalid authentication credentials.",
              status: "UNAUTHENTICATED",
            },
          }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("alt=sse")) {
          return new Response(sseSuccessBody("concurrent ok"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(JSON.stringify(jsonSuccessBody("concurrent ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const first = postResponses(server);
      const second = postResponses(server);
      await refreshStarted;
      releaseRefresh();
      const [a, b] = await Promise.all([first, second]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(refreshCalls).toBe(1);
      expect(attemptsByBearer.get("Bearer rejected-access")).toBe(2);
      expect(attemptsByBearer.get("Bearer fresh-access")).toBe(2);
    } finally {
      await server.stop(true);
    }
  });
});
