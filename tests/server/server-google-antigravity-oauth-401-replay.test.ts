import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { forceRefreshOAuthAccessSnapshot, getValidAccessTokenSnapshot } from "../../src/oauth";
import { credentialGeneration, getAccountSet, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { startServer } from "../../src/server";
import { ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX } from "../../src/adapters/google-errors";
import { readUsageEntries } from "../../src/usage/log";
import { clearGenericFailoverHealth, rotateAntigravityAccountOnAuthRefusal } from "../../src/oauth/generic-account-failover";
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
  clearGenericFailoverHealth();
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-google-401-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-google-401-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  clearGenericFailoverHealth();
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

async function seedSibling(): Promise<string> {
  const initial = getAccountSet("google-antigravity")!.activeAccountId;
  await saveCredential("google-antigravity", {
    access: "access-b", refresh: "refresh-b", expires: Date.now() + 3_600_000,
    accountId: "account-b", projectId: "project-b", source: "oauth",
  }, { addAccount: true });
  await setActiveAccount("google-antigravity", initial);
  return getAccountSet("google-antigravity")!.accounts.find(row => row.credential.access === "access-b")!.id;
}

async function seedThirdSibling(): Promise<void> {
  const initial = getAccountSet("google-antigravity")!.activeAccountId;
  await saveCredential("google-antigravity", {
    access: "access-c", refresh: "refresh-c", expires: Date.now() + 3_600_000,
    accountId: "account-c", projectId: "project-c", source: "oauth",
  }, { addAccount: true });
  await setActiveAccount("google-antigravity", initial);
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
  apiStatuses: Array<number | { status: number; reason?: string; oversized?: boolean; message?: string }>,
  options: {
    tokenErrorDescription?: string;
    tokenHttpStatus?: number;
    tokenThrow?: string;
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
      if (options.tokenThrow) throw new Error(options.tokenThrow);
      if (options.tokenHttpStatus !== undefined) {
        return Response.json({ error: "temporarily_unavailable" }, { status: options.tokenHttpStatus });
      }
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
      const statusCode = typeof status === "number" ? status : status.status;
      if (statusCode === 401 && !unauthorizedObserved) {
        unauthorizedObserved = true;
        await options.beforeFirstUnauthorized?.();
      }
      if (statusCode >= 400) {
        return new Response(JSON.stringify({
          error: {
            code: statusCode,
            message: "Request had invalid authentication credentials.",
            status: statusCode === 401 ? "UNAUTHENTICATED" : "PERMISSION_DENIED",
          },
        }), {
          status: statusCode,
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
      const statusCode = typeof status === "number" ? status : status.status;
      if (statusCode === 401 && !unauthorizedObserved) {
        unauthorizedObserved = true;
        await options.beforeFirstUnauthorized?.();
      }
      if (statusCode >= 400) {
        return new Response(JSON.stringify({
          error: {
            code: statusCode,
            message: typeof status !== "number" && status.message
              ? status.message : "Request had invalid authentication credentials.",
            status: statusCode === 401 ? "UNAUTHENTICATED" : "PERMISSION_DENIED",
            ...(typeof status !== "number" ? {
              ...(status.oversized ? { filler: "x".repeat(4200) } : {}),
              ...(status.reason ? { details: [{ reason: status.reason }] } : {}),
            } : {}),
          },
        }), {
          status: statusCode,
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
  test("structured validation 403 rotates once with the sibling's own project and recovery kind", async () => {
    await seedOAuth();
    await seedSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([{ status: 403, reason: "VALIDATION_REQUIRED" }, 200]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(200);
      await response.text();
      expect(observed.requestPaths).toEqual(["/v1internal:generateContent", "/v1internal:generateContent"]);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer access-b"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "project-b"]);
      expect(observed.counts.refresh).toBe(0);
      expect(readUsageEntries().at(-1)?.attempts?.some(attempt => attempt.recoveryKinds.includes("oauth-account-403"))).toBe(true);
    } finally { await server.stop(true); }
  });

  test.each([403, { status: 403, reason: "VALIDATION_REQUIRED", oversized: true },
    { status: 403, message: ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX }])(
    "unclassified 403 %p retains the refusal without a sibling send", async refusal => {
      await seedOAuth();
      await seedSibling();
      saveConfig(antigravityConfig());
      const observed = installOAuthFetch([refusal, 200]);
      const server = startServer(0);
      try {
        const response = await postResponses(server);
        const body = await response.text();
        expect(response.status).toBe(403);
        expect(body).toContain("Antigravity");
        expect(observed.chatAuth).toEqual(["Bearer rejected-access"]);
      } finally { await server.stop(true); }
    });

  test.each([false, true])("paused sibling %p keeps the validated 403", async pausedSibling => {
      await seedOAuth();
      if (pausedSibling) await setAccountPaused("google-antigravity", await seedSibling(), true);
      saveConfig(antigravityConfig());
      const observed = installOAuthFetch([{ status: 403, reason: "VALIDATION_REQUIRED" }, 200]);
      const server = startServer(0);
      try {
        const response = await postResponses(server);
        expect(response.status).toBe(403);
        expect((await response.text())).toContain("Antigravity account validation required");
        expect(observed.chatAuth).toEqual(["Bearer rejected-access"]);
      } finally { await server.stop(true); }
  });

  test("a cooling sibling keeps the validated 403", async () => {
    await seedOAuth();
    const siblingId = await seedSibling();
    const sibling = getAccountSet("google-antigravity")!.accounts.find(row => row.id === siblingId)!;
    rotateAntigravityAccountOnAuthRefusal(true, siblingId,
      credentialGeneration(sibling.credential), "gemini-3.8-flash");
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([{ status: 403, reason: "VALIDATION_REQUIRED" }, 200]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(403);
      await response.text();
      expect(observed.chatAuth).toEqual(["Bearer rejected-access"]);
    } finally { await server.stop(true); }
  });

  test("three validation refusals stop after one sibling", async () => {
    await seedOAuth();
    await seedSibling();
    await seedThirdSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([
      { status: 403, reason: "VALIDATION_REQUIRED" },
      { status: 403, reason: "VALIDATION_REQUIRED" }, 200,
    ]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(403);
      await response.text();
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer access-b"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "project-b"]);
    } finally { await server.stop(true); }
  });

  test("401 sibling rotation followed by validation 403 does not reach a third account", async () => {
    await seedOAuth();
    await seedSibling();
    await seedThirdSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 401, { status: 403, reason: "VALIDATION_REQUIRED" }, 200]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(403);
      await response.text();
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access", "Bearer access-b"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "refreshed-project-id", "project-b"]);
    } finally { await server.stop(true); }
  });
  test("validation 403 followed by a sibling terminal refresh failure does not reach a third account", async () => {
    await seedOAuth();
    await seedSibling();
    await seedThirdSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([{ status: 403, reason: "VALIDATION_REQUIRED" }, 401, 200], {
      tokenThrow: "invalid_grant",
    });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(401);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer access-b"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "project-b"]);
      expect(observed.counts.refresh).toBe(1);
    } finally { await server.stop(true); }
  });
  test("same-account refresh succeeds without pool rotation", async () => {
    await seedOAuth();
    await seedSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 200]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(200);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "refreshed-project-id"]);
      expect(observed.counts.refresh).toBe(1);
    } finally { await server.stop(true); }
  });

  test("replayed 401 sends once on the sibling with its paired project", async () => {
    await seedOAuth();
    await seedSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 401, 200]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(200);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access", "Bearer access-b"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "refreshed-project-id", "project-b"]);
      expect(observed.counts.refresh).toBe(1);
    } finally { await server.stop(true); }
  });

  test("terminal refresh failure uses the sibling while the failed row needs reauth", async () => {
    await seedOAuth();
    const failedId = getAccountSet("google-antigravity")!.activeAccountId;
    await seedSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 200], { tokenThrow: "invalid_grant" });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(200);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer access-b"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "project-b"]);
      expect(getAccountSet("google-antigravity")!.accounts.find(row => row.id === failedId)?.needsReauth).toBe(true);
      expect(observed.counts.refresh).toBe(1);
    } finally { await server.stop(true); }
  });

  test("a transient refresh failure does not send on a sibling", async () => {
    await seedOAuth();
    const failedId = getAccountSet("google-antigravity")!.activeAccountId;
    await seedSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 200], { tokenHttpStatus: 503 });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      const body = await response.text();
      expect(response.status).toBe(401);
      expect(body).toContain(PUBLIC_OAUTH_AUTHENTICATION_ERROR);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access"]);
      expect(observed.chatProjects).toEqual(["initial-project-id"]);
      expect(observed.counts.refresh).toBe(1);
      expect(getAccountSet("google-antigravity")!.accounts.find(row => row.id === failedId)?.needsReauth).not.toBe(true);
    } finally { await server.stop(true); }
  });

  test("a sibling's 401 does not trigger another account hop", async () => {
    await seedOAuth();
    await seedSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 401, 401, 200]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(401);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access", "Bearer access-b"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "refreshed-project-id", "project-b"]);
      expect(observed.counts.refresh).toBe(1);
    } finally { await server.stop(true); }
  });

  test("a sibling paused after the first send is never used", async () => {
    await seedOAuth();
    const sibling = await seedSibling();
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401, 401], {
      beforeFirstUnauthorized: async () => { await setAccountPaused("google-antigravity", sibling, true); },
    });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(response.status).toBe(401);
      expect(observed.chatAuth).toHaveLength(2);
      expect(observed.chatAuth).not.toContain("Bearer access-b");
    } finally { await server.stop(true); }
  });
  test("paused OAuth account returns a non-retryable permission error for CCA image generation", async () => {
    await seedOAuth();
    const accountId = getAccountSet("google-antigravity")!.accounts[0]!.id;
    await setAccountPaused("google-antigravity", accountId, true);
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([]);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/images/generations", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
      });
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(JSON.parse(body)).toMatchObject({ error: {
        type: "permission_error",
        message: "OAuth account is paused. Resume it in account settings and retry.",
      } });
      expect(body).toContain("OAuth account is paused");
      expect(body).not.toContain("login required");
      expect(observed.counts.refresh).toBe(0);
      expect(observed.requestPaths).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("paused OAuth account returns a non-retryable permission error without refresh or upstream dispatch", async () => {
    await seedOAuth();
    const accountId = getAccountSet("google-antigravity")!.accounts[0]!.id;
    await setAccountPaused("google-antigravity", accountId, true);
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([]);
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(JSON.parse(body)).toMatchObject({ error: {
        type: "permission_error",
        message: "OAuth account is paused. Resume it in account settings and retry.",
      } });
      expect(body).toContain("OAuth account is paused");
      expect(body).not.toContain("login google-antigravity");
      expect(observed.counts.refresh).toBe(0);
      expect(observed.requestPaths).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("an account paused before OAuth 401 replay returns a non-retryable permission error and does not refresh", async () => {
    await seedOAuth();
    const accountId = getAccountSet("google-antigravity")!.accounts[0]!.id;
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401], {
      beforeFirstUnauthorized: async () => {
        await setAccountPaused("google-antigravity", accountId, true);
      },
    });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(JSON.parse(body)).toMatchObject({ error: {
        type: "permission_error",
        message: "OAuth account is paused. Resume it in account settings and retry.",
      } });
      expect(body).toContain("OAuth account is paused");
      expect(observed.counts.refresh).toBe(0);
      expect(observed.requestPaths).toEqual(["/v1internal:generateContent"]);
    } finally {
      await server.stop(true);
    }
  });

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

  test.each([false, true])("401 recovery follows the newly selected account and its project (newer A generation=%s)", async newerGeneration => {
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
      expect(observed.counts.refresh).toBe(0);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer access-b"]);
      expect(observed.chatProjects).toEqual(["initial-project-id", "project-b"]);
      const accounts = getAccountSet("google-antigravity")!;
      expect(accounts.activeAccountId).not.toBe(accountA);
      expect(accounts.accounts.find(account => account.id === accounts.activeAccountId)?.credential).toMatchObject({
        access: "access-b", projectId: "project-b",
      });
      expect(accounts.accounts.find(account => account.id === accountA)?.credential).toMatchObject({
        access: newerGeneration ? "newer-access-a" : "rejected-access",
        projectId: newerGeneration ? "newer-project-a" : "initial-project-id",
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

  test("project-less account is refused before dispatch in native Responses passthrough", async () => {
    await seedOAuth(undefined, null);
    saveConfig(antigravityPassthroughConfig());
    const observed = installOAuthFetch([401], { refreshedProjectId: null });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(observed.requestPaths).toEqual([]);
      const json = await response.json() as { error?: { code?: string; message?: string; type?: string } };
      expect(response.status).toBe(401);
      expect(json.error?.type).toBe("authentication_error");
      expect(json.error?.message).toBe(PUBLIC_OAUTH_AUTHENTICATION_ERROR);
      expect(observed.counts.refresh).toBe(0);
      expect(observed.chatAuth).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("project-less account is refused before dispatch in generic adapter", async () => {
    await seedOAuth(undefined, null);
    saveConfig(antigravityConfig());
    const observed = installOAuthFetch([401], { refreshedProjectId: null });
    const server = startServer(0);
    try {
      const response = await postResponses(server);
      expect(observed.requestPaths).toEqual([]);
      const json = await response.json() as { error?: { code?: string; message?: string; type?: string } };
      expect(response.status).toBe(401);
      expect(json.error?.type).toBe("authentication_error");
      expect(json.error?.message).toBe(PUBLIC_OAUTH_AUTHENTICATION_ERROR);
      expect(observed.counts.refresh).toBe(0);
      expect(observed.chatAuth).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("project-less account is refused before dispatch in chat completions", async () => {
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
      expect(observed.counts.refresh).toBe(0);
      expect(observed.chatAuth).toEqual([]);
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
