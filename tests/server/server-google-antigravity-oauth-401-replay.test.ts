import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { forceRefreshOAuthAccessSnapshot, getValidAccessTokenSnapshot } from "../../src/oauth";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROD_API_BASE = "https://cloudcode-pa.googleapis.com";
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

async function seedOAuth(expires = Date.now() + 3_600_000, projectId?: string | null): Promise<void> {
  await saveCredential("google-antigravity", {
    access: "rejected-access",
    refresh: "initial-refresh",
    expires,
    accountId: "antigravity-test-account",
    ...(projectId !== undefined ? (projectId ? { projectId } : {}) : { projectId: "initial-project-id" }),
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

function antigravityPassthroughConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        // Canonical routing restores the Google adapter. The supported model-level
        // override is applied afterwards and again when the OAuth replay is rebuilt.
        // Synthetic native-branch coverage, not a claim about Google's supported API.
        adapter: "google",
        modelAdapters: { "gemini-3.8-flash": "openai-responses" },
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

async function postResponses(server: ReturnType<typeof startServer>, stream = false, providerName = "google-antigravity"): Promise<Response> {
  return originalFetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: `${providerName}/gemini-3.8-flash`,
      input: "hello",
      stream,
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
    refreshedProjectId?: string | null;
    beforeFirstUnauthorized?: () => Promise<void>;
  } = {},
): { chatAuth: string[]; chatProjects: string[]; requestPaths: string[]; counts: { refresh: number } } {
  const chatAuth: string[] = [];
  const chatProjects: string[] = [];
  const requestPaths: string[] = [];
  const counts = { refresh: 0 };
  let unauthorizedObserved = false;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    const parsedUrl = new URL(url);

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
    if (url === `${PROD_API_BASE}/v1internal:loadCodeAssist`) {
      if (options.refreshedProjectId === null) {
        return new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        cloudaicompanionProject: options.refreshedProjectId ?? "refreshed-project-id",
      }), { headers: { "content-type": "application/json" } });
    }

    if (url === `${DAILY_API_BASE}/v1internal:onboardUser`) {
      if (options.refreshedProjectId === null) {
        return new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } });
      }
    }

    // Responses passthrough endpoint
    if (url === `${DAILY_API_BASE}/v1/responses`) {
      requestPaths.push(parsedUrl.pathname);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      chatAuth.push(auth);
      const status = apiStatuses.shift() ?? 200;
      if (status === 401 && !unauthorizedObserved) {
        unauthorizedObserved = true;
        await options.beforeFirstUnauthorized?.();
      }
      if (status >= 400) {
        return new Response(JSON.stringify({
          error: {
            code: status,
            message: "Request had invalid authentication credentials.",
            status: status === 401 ? "UNAUTHENTICATED" : "PERMISSION_DENIED",
          },
        }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        id: "resp-passthrough",
        output: [{
          id: "msg-passthrough",
          type: "message",
          content: [{ type: "output_text", text: "ok after passthrough" }],
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Google Antigravity Generate Content endpoint
    if (parsedUrl.origin === DAILY_API_BASE
      && ["/v1internal:streamGenerateContent", "/v1internal:generateContent"].includes(parsedUrl.pathname)) {
      requestPaths.push(parsedUrl.pathname);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      chatAuth.push(auth);
      if (typeof init?.body === "string") {
        try {
          const parsedBody = JSON.parse(init.body) as { project?: string };
          if (parsedBody.project) chatProjects.push(parsedBody.project);
        } catch { /* ignore */ }
      }
      const status = apiStatuses.shift() ?? 200;
      if (status === 401 && !unauthorizedObserved) {
        unauthorizedObserved = true;
        await options.beforeFirstUnauthorized?.();
      }
      if (status >= 400) {
        return new Response(JSON.stringify({
          error: {
            code: status,
            message: "Request had invalid authentication credentials.",
            status: status === 401 ? "UNAUTHENTICATED" : "PERMISSION_DENIED",
          },
        }), {
          status,
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

    if (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost") return originalFetch(input, init);
    throw new Error("Unexpected external request in Antigravity replay fixture");
  }) as typeof fetch;
  return { chatAuth, chatProjects, requestPaths, counts };
}

describe("Google Antigravity OAuth upstream 401 replay", () => {
  test.each([200, 401])("native passthrough replays once and returns the second HTTP %i", async secondStatus => {
    await seedOAuth();
    saveConfig(antigravityPassthroughConfig());
    const observed = installOAuthFetch([401, secondStatus]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(observed.requestPaths).toEqual(["/v1/responses", "/v1/responses"]);
      expect(response.status).toBe(secondStatus);
      const text = await response.text();
      if (secondStatus === 200) expect(text).toContain("ok after passthrough");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
    } finally {
      await server.stop(true);
    }
  });

  test.each([false, true])("HTTP 403 never triggers OAuth refresh (native=%s)", async native => {
    await seedOAuth();
    saveConfig(native ? antigravityPassthroughConfig() : antigravityConfig());
    const observed = installOAuthFetch([403]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(observed.requestPaths).toEqual([native ? "/v1/responses" : "/v1internal:generateContent"]);
      expect(response.status).toBe(403);
      await response.text();
      expect(observed.counts.refresh).toBe(0);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access"]);
    } finally {
      await server.stop(true);
    }
  });

  test.each([false, true])("a custom key route does not consume Antigravity OAuth credentials (native=%s)", async native => {
    await seedOAuth();
    const config = native ? antigravityPassthroughConfig() : antigravityConfig();
    // The canonical Antigravity name is normalized to OAuth by the router. A separately
    // named key route is the supported non-OAuth boundary, not a fake canonical key mode.
    const name = "antigravity-key-test";
    const provider = config.providers["google-antigravity"]!;
    config.providers = { [name]: { ...provider, authMode: "key", apiKey: "static-key-sentinel" } };
    config.defaultProvider = name;
    saveConfig(config);
    const observed = installOAuthFetch([401]);
    const server = startServer(0);
    try {
      const response = await postResponses(server, false, name);
      expect(observed.requestPaths).toEqual([native ? "/v1/responses" : "/v1internal:generateContent"]);
      expect(response.status).toBe(401);
      await response.text();
      expect(observed.counts.refresh).toBe(0);
      expect(observed.chatAuth).toEqual(["Bearer static-key-sentinel"]);
    } finally {
      await server.stop(true);
    }
  });

  test("retains the same account's stored project when refresh discovery has no project", async () => {
    await seedOAuth();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 200], { refreshedProjectId: null });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("ok after google refresh");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "initial-project-id"]);
      const snapshot = await getValidAccessTokenSnapshot("google-antigravity");
      expect(snapshot.projectId).toBe("initial-project-id");
      expect(snapshot.accessToken).toBe("fresh-access");
    } finally {
      await server.stop(true);
    }
  });

  test.each([false, true])("401 stays pinned to rejected account A after active switches to B (newer A generation=%s)", async newerGeneration => {
    await seedOAuth();
    const accountA = getAccountSet("google-antigravity")!.activeAccountId;
    const config = antigravityConfig();
    config.oauthAccountFailover = { enabled: false };
    config.providers["google-antigravity"]!.oauthAccountFailover = { enabled: false };
    saveConfig(config);
    const observed = installOAuthFetch([401, 200], {
      refreshedProjectId: "refreshed-project-a",
      beforeFirstUnauthorized: async () => {
        // Deterministic race point: the original A request was built and observed, but
        // its HTTP 401 has not reached the recovery loop. No timing sleeps are needed.
        if (newerGeneration) {
          await saveCredential("google-antigravity", {
            access: "newer-access-a", refresh: "newer-refresh-a", expires: Date.now() + 3_600_000,
            accountId: "antigravity-test-account", projectId: "newer-project-a", source: "oauth",
          });
        }
        await saveCredential("google-antigravity", {
          access: "access-b", refresh: "refresh-b", expires: Date.now() + 3_600_000,
          accountId: "account-b", projectId: "project-b", source: "oauth",
        });
      },
    });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("ok after google refresh");
      expect(observed.counts.refresh).toBe(newerGeneration ? 0 : 1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", newerGeneration ? "Bearer newer-access-a" : "Bearer fresh-access"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", newerGeneration ? "newer-project-a" : "refreshed-project-a"]);
      const accounts = getAccountSet("google-antigravity")!;
      expect(accounts.activeAccountId).not.toBe(accountA);
      expect(accounts.accounts.find(account => account.id === accounts.activeAccountId)?.credential).toMatchObject({
        access: "access-b", projectId: "project-b",
      });
      expect(accounts.accounts.find(account => account.id === accountA)?.credential).toMatchObject({
        access: newerGeneration ? "newer-access-a" : "fresh-access",
        projectId: newerGeneration ? "newer-project-a" : "refreshed-project-a",
      });
    } finally {
      await server.stop(true);
    }
  });

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
      const parsedUrl = new URL(url);
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
      if (url === `${PROD_API_BASE}/v1internal:loadCodeAssist`) {
        return new Response(JSON.stringify({
          cloudaicompanionProject: "concurrent-project-id",
        }), { headers: { "content-type": "application/json" } });
      }
      if (parsedUrl.origin === DAILY_API_BASE
        && ["/v1internal:streamGenerateContent", "/v1internal:generateContent"].includes(parsedUrl.pathname)) {
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
      const hostname = parsedUrl.hostname;
      if (hostname === "127.0.0.1" || hostname === "localhost") return originalFetch(input, init);
      throw new Error("Unexpected external request in concurrent Antigravity replay fixture");
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

  test("negative project-less refresh rejects replay in native Responses passthrough", async () => {
    await seedOAuth(undefined, null);
    saveConfig(antigravityPassthroughConfig());
    const observed = installOAuthFetch([401], { refreshedProjectId: null });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(observed.requestPaths).toEqual(["/v1/responses"]);
      const json = await response.json() as { error?: { code?: string; message?: string; type?: string } };
      expect(response.status).toBe(401);
      expect(json.error?.type).toBe("authentication_error");
      expect(json.error?.message).toBe(PUBLIC_OAUTH_AUTHENTICATION_ERROR);
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access"]);
    } finally {
      await server.stop(true);
    }
  });

  test("negative project-less refresh rejects replay in generic adapter", async () => {
    await seedOAuth(undefined, null);
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401], { refreshedProjectId: null });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(observed.requestPaths).toEqual(["/v1internal:generateContent"]);
      const json = await response.json() as { error?: { code?: string; message?: string; type?: string } };
      expect(response.status).toBe(401);
      expect(json.error?.type).toBe("authentication_error");
      expect(json.error?.message).toBe(PUBLIC_OAUTH_AUTHENTICATION_ERROR);
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access"]);
    } finally {
      await server.stop(true);
    }
  });

  test("negative project-less refresh rejects replay in chat completions", async () => {
    await seedOAuth(undefined, null);
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401], { refreshedProjectId: null });
    const server = startServer(0);
    try {
      const response = await postChat(server);
      const json = await response.json() as { error?: { message?: string; type?: string } };
      expect(response.status).toBe(401);
      expect(json.error?.type).toBe("authentication_error");
      expect(json.error?.message).toBe(PUBLIC_OAUTH_AUTHENTICATION_ERROR);
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access"]);
    } finally {
      await server.stop(true);
    }
  });

  test("401 then 200 on /v1/responses with stream: true performs one refresh and one replay with refreshed token and project", async () => {
    await seedOAuth();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 200], { refreshedProjectId: "stream-project-999" });
    const server = startServer(0);
    try {
      const response = await postResponses(server, true);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let streamText = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamText += decoder.decode(chunk.value, { stream: true });
      }
      expect(streamText).toContain("ok after google refresh");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "stream-project-999"]);
    } finally {
      await server.stop(true);
    }
  });
});
