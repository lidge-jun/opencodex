import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleProviderCommand } from "../../src/cli/provider";
import { fetchProviderModels } from "../../src/codex/catalog/provider-models";
import { isComboTargetInCooldown } from "../../src/combos/failover";
import { fetchProviderQuotaReports } from "../../src/providers/quota";
import { saveConfig } from "../../src/config";
import { isNonReplayableResponse, REPLAY_REFUSAL_MESSAGE } from "../../src/lib/upstream-retry";
import { XAI_OAUTH_DISCOVERY_URL } from "../../src/oauth/xai";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { clearModelCache, getProviderDiscoveryStatus, isModelsFetchCoolingDown, markModelsFetchFailure, MODELS_FETCH_FAILURE_COOLDOWN_MS } from "../../src/codex/model-cache";
import { XAI_GROK_CLI_BASE_URL } from "../../src/providers/xai-transport";
import { readUsageEntries, usageLogPath } from "../../src/usage/log";
import { startServer } from "../../src/server";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TOKEN_ENDPOINT = "https://auth.x.ai/oauth/token";
const OAUTH_RESPONSES_ENDPOINT = `${XAI_GROK_CLI_BASE_URL}/responses`;
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
  if (testDir) removeTreeWithRetry(testDir);
});

async function seedOAuth(expires = Date.now() + 3_600_000): Promise<void> {
  await saveCredential("xai", {
    access: "rejected-access",
    refresh: "initial-refresh",
    expires,
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
        ...(authMode === "oauth" ? { modelAdapters: { "grok-4.5": "openai-responses" } } : {}),
        models: ["grok-4.5"],
      },
    },
  } as OcxConfig;
}

function successBody(text: string): string {
  return JSON.stringify({
    id: "resp-xai-401",
    object: "response",
    status: "completed",
    model: "grok-4.5",
    output: [{
      id: "msg-xai-401",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
}

async function post(server: ReturnType<typeof startServer>): Promise<Response> {
  return originalFetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "xai/grok-4.5", input: "hello", stream: false }),
  });
}

function installOAuthFetch(
  chatStatuses: number[],
  options: { tokenErrorDescription?: string } = {},
): { chatAuth: string[]; counts: { refresh: number } } {
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
      if (options.tokenErrorDescription !== undefined) {
        return new Response(JSON.stringify({
          error: "temporarily_unavailable",
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
    if (url === OAUTH_RESPONSES_ENDPOINT) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("grok-4.5");
      expect(body.input).toBe("hello");
      expect(body.messages).toBeUndefined();
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

describe("xAI OAuth Responses opt-in upstream 401 replay", () => {
  test("initial OAuth refresh projects raw provider failures before responding", async () => {
    await seedOAuth(0);
    saveConfig(xaiConfig());
    const observed = installOAuthFetch([], {
      tokenErrorDescription: `EACCES writing ${WINDOWS_PATH_CANARY}, ${UNC_PATH_CANARY}, or ${POSIX_PATH_CANARY}`,
    });
    const server = startServer(0);
    try {
      const response = await post(server);
      const json = await response.json() as { error?: { code?: string; message?: string; type?: string } };
      const message = json.error?.message ?? "";
      expect(response.status).toBe(401);
      expect(json.error?.type).toBe("authentication_error");
      expect(json.error?.code).toBe("invalid_api_key");
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
    saveConfig(xaiConfig());
    const observed = installOAuthFetch([401], {
      tokenErrorDescription: `EACCES writing ${WINDOWS_PATH_CANARY}, ${UNC_PATH_CANARY}, or ${POSIX_PATH_CANARY}`,
    });
    const server = startServer(0);
    try {
      const response = await post(server);
      const json = await response.json() as { error?: { code?: string; message?: string; type?: string } };
      const message = json.error?.message ?? "";
      expect(response.status).toBe(401);
      expect(json.error?.type).toBe("authentication_error");
      expect(json.error?.code).toBe("invalid_api_key");
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

  test("401 then 200 performs one refresh and one replay", async () => {
    await seedOAuth();
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
      const attempt = readUsageEntries().at(-1)?.attempts?.[0];
      expect(attempt?.credentialSource).toBe("grok-oauth");
      expect(attempt?.sendCount).toBe(2);
      expect(attempt?.totalTokens).toBe(5);
      const persisted = readFileSync(usageLogPath(), "utf8");
      expect(persisted).not.toContain("rejected-access");
      expect(persisted).not.toContain("fresh-access");
      expect(persisted).not.toContain("xai-test-account");
    } finally {
      await server.stop(true);
    }
  });

  test("401 then 401 replays once and propagates the second error", async () => {
    await seedOAuth();
    saveConfig(xaiConfig());
    const observed = installOAuthFetch([401, 401]);
    const server = startServer(0);
    try {
      const response = await post(server);
      const json = await response.json() as { error?: { message?: string } };
      expect(response.status).toBe(401);
      expect(json.error?.message).toBe("rejected");
      expect(observed.counts.refresh).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
    } finally {
      await server.stop(true);
    }
  });

  test("native Chat records canonical API-key provenance", async () => {
    saveConfig(xaiConfig("key"));
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe("https://api.x.ai/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-api-key");
      return Response.json({
        id: "chat-native-xai", object: "chat.completion", model: "grok-4.5",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/chat/completions", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "xai/grok-4.5", messages: [{ role: "user", content: "hello" }], stream: false }),
      });
      expect(response.status).toBe(200);
      await response.json();
      const entry = readUsageEntries().at(-1);
      expect(entry?.inboundProtocol).toBe("chat");
      expect(entry?.attempts?.[0]?.credentialSource).toBe("xai-api-key");
      expect(entry?.attempts?.[0]?.totalTokens).toBe(5);
      expect(entry?.attempts?.[0]?.sendCount).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("native Chat 429 rotates configured apiKeyPool and keeps canonical xAI source", async () => {
    const firstKey = "xai-pool-key-alpha-000111222333";
    const secondKey = "xai-pool-key-beta-444555666777";
    saveConfig({
      ...xaiConfig("key"),
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: firstKey,
          apiKeyPool: [
            { id: "k1", key: firstKey, addedAt: 1 },
            { id: "k2", key: secondKey, addedAt: 2 },
          ],
          models: ["grok-4.5"],
        },
      },
    } as OcxConfig);
    const seenAuth: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe("https://api.x.ai/v1/chat/completions");
      seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      if (seenAuth.length === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "30", "content-type": "application/json" },
        });
      }
      return Response.json({
        id: "chat-native-xai-rotate", object: "chat.completion", model: "grok-4.5",
        choices: [{ index: 0, message: { role: "assistant", content: "ok after rotate" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/chat/completions", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "xai/grok-4.5", messages: [{ role: "user", content: "hello" }], stream: false }),
      });
      expect(response.status).toBe(200);
      await response.json();
      expect(seenAuth).toEqual([`Bearer ${firstKey}`, `Bearer ${secondKey}`]);
      const entries = readUsageEntries();
      expect(entries).toHaveLength(1);
      const attempts = entries[0]?.attempts;
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts ?? []) {
      expect(attempt?.credentialSource).toBe("xai-api-key");
      expect(attempt?.sendCount).toBe(1);
      expect(attempt?.adapter).toBe("openai-chat");
      }
      const persisted = readFileSync(usageLogPath(), "utf8");
      expect(persisted).not.toContain(firstKey);
      expect(persisted).not.toContain(secondKey);
    } finally {
      await server.stop(true);
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
      expect(readUsageEntries().at(-1)?.attempts?.[0]?.credentialSource).toBe("xai-api-key");
    } finally {
      await server.stop(true);
    }
  });

  test("concurrent 401 responses join one IdP refresh", async () => {
    await seedOAuth();
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
      if (url === OAUTH_RESPONSES_ENDPOINT) {
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
      await server.stop(true);
    }
  });
});

describe("xAI OAuth Legacy privacy settings refusal", () => {
  const guidance = "The xAI account uses Legacy (no storage), which blocks Grok Build. Switch the xAI account to Privacy Mode in the xAI/Grok privacy settings, then retry.";
  const marker = "[WKE=privacy-mode:legacy]";
  const privateDetail = "upstream-only fixture detail";

  const privacyError = `${privateDetail} ${marker}`;

  function refuseAt(upstreamPath: string, error: string | { message: string; code: string } = privacyError,
    fallback?: (init?: RequestInit) => Response, resetReplacement?: () => Response, headers?: HeadersInit): string[] {
    const sends: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === new URL(XAI_GROK_CLI_BASE_URL).origin) {
        const path = url.pathname + url.search;
        if (path === upstreamPath || path === "/v1/billing") {
          sends.push(path);
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rejected-access");
          if (resetReplacement) {
            if (sends.length === 1) {
              throw Object.assign(new Error("synthetic pre-header reset"), { code: "ECONNRESET" });
            }
            return resetReplacement();
          }
          return Response.json({ error }, { status: 403, headers });
        }
        if (path === "/v1/models") return Response.json({ data: [{ id: "grok-4.5" }] });
      }
      if (url.href === "https://fixture.invalid/v1/chat/completions" && fallback) {
        sends.push(url.href);
        return fallback(init);
      }
      if (url.protocol === "http:" && url.hostname === "127.0.0.1") return originalFetch(input, init);
      throw new Error("unexpected outbound request in xAI privacy settings fixture");
    }) as typeof fetch;
    return sends;
  }

  const inferenceRoutes = [
    ["native Chat Completions", "/v1/chat/completions", "/v1/chat/completions", false],
    ["translated Responses", "/v1/responses", "/v1/chat/completions", false],
    ["native Responses", "/v1/responses", "/v1/responses", true],
    ["translated Chat Completions", "/v1/chat/completions", "/v1/responses", true],
  ] as const;
  test.each(inferenceRoutes.flatMap(([name, ...route]) => (["ordinary", "no-retry", "coded replay refusal"] as const)
    .map(verdict => [name, verdict, ...route] as const)))("%s returns fixed text for %s", async (_, verdict, downstream, upstream, nativeResponses) => {
    await saveCredential("xai", {
      access: "spare-access",
      refresh: "spare-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "spare-account",
      source: "oauth",
    });
    await seedOAuth();
    const config = xaiConfig();
    const provider = config.providers.xai!;
    if (!nativeResponses) {
      provider.modelAdapters = { "grok-4.5": "openai-chat" };
      provider.xaiResponsesDefaultVersion = 1;
    }
    provider.accountAutoPause = { enabled: true, consecutiveFailures: 1 };
    provider.oauthAccountFailover = { enabled: true };
    saveConfig(config);
    const accountBefore = getAccountSet("xai");
    expect(accountBefore?.accounts).toHaveLength(2);
    const codedRefusal = verdict === "coded replay refusal";
    const headers = verdict === "ordinary" ? undefined : { "x-should-retry": "false", "Retry-After": "137" };
    const sends = refuseAt(upstream, codedRefusal ? { message: privacyError, code: "upstream_response_refused" } : privacyError,
      undefined, undefined, headers);
    const server = startServer(0);
    try {
      const result = downstream === "/v1/responses" ? await post(server) : await originalFetch(new URL(downstream, server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "xai/grok-4.5", messages: [{ role: "user", content: "hello" }], stream: false }),
      });
      expect(result.status).toBe(codedRefusal ? 429 : 403);
      expect(result.headers.get("x-should-retry")).toBe(headers ? "false" : null);
      expect(result.headers.get("retry-after")).toBeNull();
      const body = await result.text();
      expect(JSON.parse(body).error).toMatchObject(codedRefusal
        ? { message: REPLAY_REFUSAL_MESSAGE, code: "upstream_response_refused" }
        : { message: guidance, type: "permission_error", code: "permission_denied" });
      expect(body).not.toContain(privateDetail);
      expect(body).not.toContain(marker);
      expect(sends).toEqual([upstream]);
      expect(getAccountSet("xai")).toEqual(accountBefore);
      if (!codedRefusal) expect(readUsageEntries().at(-1)?.failureCause).toBe("policy-refusal");
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    ["translated Responses", "/v1/chat/completions", false, false, "false", "false", false],
    ["native Responses", "/v1/responses", true, false, "false", "false", false],
    ["translated Responses combo", "/v1/chat/completions", false, true, "false", "false", false],
    ["native Responses combo", "/v1/responses", true, true, "false", "false", false],
    ["native Responses combo with an unrecognized retry header", "/v1/responses", true, true, "False", null, false],
    ["translated Responses combo with a replay refusal code", "/v1/chat/completions", false, true, "false", "false", true],
    ["native Responses combo with a replay refusal code", "/v1/responses", true, true, "false", "false", true],
  ] as const)("%s preserves the terminal verdict on a privacy reset replacement", async (_, upstream, nativeResponses, combo, header, expectedHeader, codedRefusal) => {
    await seedOAuth();
    const config = xaiConfig();
    const provider = config.providers.xai!;
    if (!nativeResponses) {
      provider.modelAdapters = { "grok-4.5": "openai-chat" };
      provider.xaiResponsesDefaultVersion = 1;
    }
    provider.retryOnReset = { enabled: true };
    if (combo) {
      config.providers.fixture = {
        adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", models: ["fallback"],
      };
      config.combos = { "privacy-reset": { strategy: "failover", targets: [
        { provider: "xai", model: "grok-4.5" }, { provider: "fixture", model: "fallback" },
      ] } };
    }
    saveConfig(config);
    const error = codedRefusal ? { message: privacyError, code: "upstream_response_refused" } : privacyError;
    const sends = refuseAt(upstream, privacyError, () => Response.json({}, { status: 500 }), () =>
      Response.json({ error }, { status: 403, headers: { "x-should-retry": header } }));
    const release = acquireOwnedSpendHome();
    try {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const result = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: combo ? "combo/privacy-reset" : "xai/grok-4.5", input: "hello", store: false, stream: false }),
      }), config, logCtx);
      expect(sends).toEqual([upstream, upstream]);
      expect(result.status).toBe(codedRefusal ? 429 : 403);
      expect(isNonReplayableResponse(result)).toBe(true);
      expect(result.headers.get("x-should-retry")).toBe(expectedHeader);
      expect(await result.json()).toEqual({ error: codedRefusal
        ? { message: REPLAY_REFUSAL_MESSAGE, type: "upstream_error", code: "upstream_response_refused" }
        : { message: guidance, type: "permission_error", param: null, code: "permission_denied" } });
      if (!codedRefusal) expect(logCtx.causeHint).toBe("policy-refusal");
    } finally {
      release();
    }
  });

  test("cancellation during a privacy reset replacement body returns a non-replayable 499", async () => {
    await seedOAuth();
    const config = xaiConfig();
    config.providers.xai!.retryOnReset = { enabled: true };
    saveConfig(config);
    const reading = Promise.withResolvers<void>();
    const releaseBody = Promise.withResolvers<void>();
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: privacyError })));
        reading.resolve();
        // Hold EOF so the classifier is still reading when the caller cancels.
        return releaseBody.promise;
      },
    }, { highWaterMark: 0 });
    const sends = refuseAt("/v1/responses", privacyError, undefined, () => new Response(body, {
      status: 403, headers: { "content-type": "application/json", "x-should-retry": "false" },
    }));
    const release = acquireOwnedSpendHome();
    try {
      const pending = handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "xai/grok-4.5", input: "hello", store: false, stream: false }),
        signal: abort.signal,
      }), config, { model: "", provider: "" }, { abortSignal: abort.signal });
      await reading.promise;
      abort.abort();
      const result = await pending;
      expect(sends).toEqual(["/v1/responses", "/v1/responses"]);
      expect(result.status).toBe(499);
      expect(isNonReplayableResponse(result)).toBe(true);
    } finally {
      abort.abort();
      releaseBody.resolve();
      release();
    }
  });

  test.each([
    ["Legacy marker and x-should-retry", "present", undefined],
    ["Legacy marker without x-should-retry", "absent", undefined],
    ["Legacy marker and upstream_response_refused", "present", "upstream_response_refused"],
  ] as const)("a committed Responses stream delivers a terminal refusal for %s", async (_name, directive, code) => {
    await seedOAuth();
    const config = xaiConfig();
    config.providers.xai!.retryOnReset = { enabled: true };
    config.stallTimeoutSec = 10;
    saveConfig(config);
    const original = new TransformStream<Uint8Array, Uint8Array>();
    const writer = original.writable.getWriter();
    const detail = directive === "absent" ? `${" ".repeat(17 * 1024)}${privacyError}` : privacyError;
    const replacementError = code === undefined ? detail : { message: detail, code };
    const sends = refuseAt("/v1/responses", privacyError, undefined, () => Response.json({ error: replacementError }, {
      status: 403, headers: directive === "present" ? { "x-should-retry": "false" } : undefined,
    }));
    const fetchReplacement = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!sends.length && url.href === new URL("/v1/responses", XAI_GROK_CLI_BASE_URL).href) {
        sends.push(url.pathname);
        return new Response(original.readable, { headers: { "content-type": "text/event-stream" } });
      }
      return fetchReplacement(input, init);
    }) as typeof fetch;
    const release = acquireOwnedSpendHome();
    try {
      const result = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "xai/grok-4.5", input: "hello", store: false, stream: true }),
      }), config, { model: "", provider: "" });
      expect(result.status).toBe(200);
      expect(sends).toEqual(["/v1/responses"]);
      await writer.abort(Object.assign(new Error("synthetic post-header reset"), { code: "ECONNRESET" }));
      const body = await result.text();
      const frames = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      expect(sends).toEqual(["/v1/responses", "/v1/responses"]);
      expect(frames.filter(frame => frame.type === "response.failed")).toMatchObject([{
        response: {
          retryable: false,
          error: { message: code === undefined ? guidance : REPLAY_REFUSAL_MESSAGE, code: code ?? "permission_denied" },
        },
      }]);
      expect(body).not.toContain(privateDetail);
      expect(body).not.toContain(marker);
    } finally {
      await writer.abort().catch(() => undefined);
      release();
    }
  });

  test.each([
    [400, "context_length_exceeded", "Please reduce the length of the messages or completion.", null],
    [429, "rate_limit_exceeded", "weekly usage limit reached", "137"],
  ] as const)("combo preserves primary HTTP %i recovery after an xAI privacy refusal", async (status, code, message, retryAfter) => {
    await seedOAuth();
    const config = xaiConfig();
    config.providers.fixture = {
      adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", models: ["primary"],
    };
    const comboId = `privacy-after-${status}`;
    config.combos = { [comboId]: { strategy: "failover", targets: [
      { provider: "fixture", model: "primary" }, { provider: "xai", model: "grok-4.5" },
    ] } };
    saveConfig(config);
    const sends = refuseAt("/v1/responses", privacyError, () => Response.json(
      { error: { message, code, type: status === 400 ? "invalid_request_error" : "rate_limit_error" } },
      { status, ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}) },
    ));
    const release = acquireOwnedSpendHome();
    try {
      const result = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `combo/${comboId}`, input: "hello", stream: false }),
      }), config, { model: "", provider: "" });
      expect(sends).toEqual(["https://fixture.invalid/v1/chat/completions", "/v1/responses"]);
      expect(result.status).toBe(status);
      expect(result.headers.get("Retry-After")).toBe(retryAfter);
      const error = (await result.json()).error;
      expect(error.code).toBe(code);
      expect(error.message).toContain(message);
    } finally {
      release();
    }
  });

  test.each(["healthy", "disabled", "denied"])("Grok privacy refusal uses combo eligibility with a %s fallback", async fallback => {
    await seedOAuth();
    const config = xaiConfig();
    config.providers.fixture = {
      adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key",
      models: ["fallback"], disabled: fallback === "disabled",
    };
    const primary = { provider: "xai", model: "grok-4.5" };
    config.combos = { gated: { strategy: "failover", targets: [
      primary, { provider: "fixture", model: "fallback" },
    ] } };
    saveConfig(config);
    const sends = refuseAt("/v1/responses", privacyError, init => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "fallback",
        messages: [{ role: "user", content: "hello" }],
      });
      if (fallback === "denied") return Response.json({ error: { message: "permission denied" } }, { status: 403 });
      return Response.json({
        id: "chat-fallback", object: "chat.completion", model: "fallback",
        choices: [{ index: 0, message: { role: "assistant", content: "fallback answered" }, finish_reason: "stop" }],
      });
    });
    const server = startServer(0);
    try {
      const result = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/gated", input: "hello", stream: false }),
      });
      if (fallback === "healthy") {
        expect(result.status).toBe(200);
        expect(JSON.stringify(await result.json())).toContain("fallback answered");
      } else {
        expect(result.status).toBe(403);
        expect((await result.json()).error?.message).toBe(guidance);
        expect(readUsageEntries().at(-1)?.failureCause).toBe("policy-refusal");
      }
      expect(sends).toEqual(fallback === "disabled" ? ["/v1/responses"] : ["/v1/responses", "https://fixture.invalid/v1/chat/completions"]);
      expect(isComboTargetInCooldown("gated", primary)).toBe(false);
      expect(readUsageEntries().at(-1)?.attempts).toHaveLength(fallback === "disabled" ? 1 : 2);
    } finally {
      await server.stop(true);
    }
  });

  test("ocx provider test xai prints privacy guidance for the exact marker", async () => {
    await seedOAuth();
    const config = withStubbedProviderFetch(xaiConfig());
    saveConfig(config);
    const previousExit = process.exitCode ?? 0;
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    const stdout = spyOn(console, "log").mockImplementation(() => {});
    try {
      refuseAt("/v1/models");
      const run = () => handleProviderCommand(["test", "xai"], {
        baseUrl: "http://127.0.0.1",
        fetchImpl: (async (input, init) => {
          const url = new URL(String(input));
          const response = await handleManagementAPI(new ManagementRequest(url, init), url, config);
          if (!response) throw new Error("fixture management route not found");
          return response;
        }) as typeof fetch,
      });
      const printed = () => [...stdout.mock.calls, ...stderr.mock.calls].flat().join("\n");
      await run();
      expect(process.exitCode).toBe(1);
      expect(printed()).toContain(guidance);
      expect(printed()).not.toContain(privateDetail);
      stdout.mockClear();
      stderr.mockClear();
      refuseAt("/v1/models", "Legacy (no storage). Switch to Privacy Mode. [WKE=privacy-mode:legacy-other]");
      await run();
      expect(printed()).toContain("upstream model discovery returned 403");
      expect(printed()).not.toContain(guidance);
    } finally {
      process.exitCode = previousExit;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  test("catalog discovery logs a new privacy refusal after a generic 403 and deduplicates repeated guidance", async () => {
    await seedOAuth();
    const config = withStubbedProviderFetch(xaiConfig());
    saveConfig(config);
    clearModelCache("xai");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [error, expectedWarnings] of [
        ["generic permission refusal", 0], [privacyError, 1], [privacyError, 1],
      ] as const) {
        markModelsFetchFailure("xai", Date.now() - MODELS_FETCH_FAILURE_COOLDOWN_MS);
        const sends = refuseAt("/v1/models", error);
        const models = await fetchProviderModels("xai", config.providers.xai!, 0);
        expect(sends).toEqual(["/v1/models"]);
        expect(models.map(model => model.id)).toContain("grok-4.5");
        expect(getProviderDiscoveryStatus("xai")).toEqual({ status: "failed", reason: "http", httpStatus: 403 });
        const warnings = warn.mock.calls.flat();
        expect(warnings.join("\n")).toContain("failed with HTTP 403");
        expect(warnings.join("\n")).not.toContain(privateDetail);
        expect(warnings.filter(line => String(line).includes(guidance))).toHaveLength(expectedWarnings);
      }
    } finally {
      warn.mockRestore();
      clearModelCache("xai");
    }
  });

  test("a held xAI discovery 403 body cannot replace a newer discovery success", async () => {
    await seedOAuth();
    const config = withStubbedProviderFetch(xaiConfig());
    saveConfig(config);
    clearModelCache("xai");
    const reading = Promise.withResolvers<void>();
    const releaseBody = Promise.withResolvers<void>();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let sends = 0;
    globalThis.fetch = (async input => {
      expect(new URL(input instanceof Request ? input.url : String(input)).pathname).toBe("/v1/models");
      if (++sends !== 1) return Response.json({ data: [{ id: "grok-new-discovery" }] });
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          reading.resolve();
          await releaseBody.promise;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: privacyError })));
          controller.close();
        },
      }, { highWaterMark: 0 }), { status: 403, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const discover = () => fetchProviderModels("xai", config.providers.xai!, 0);
    const older = discover();
    try {
      await reading.promise;
      expect((await discover()).map(model => model.id)).toContain("grok-new-discovery");
      expect(getProviderDiscoveryStatus("xai")).toEqual({ status: "ok" });
      releaseBody.resolve();
      expect((await older).map(model => model.id)).toContain("grok-new-discovery");
      expect({
        status: getProviderDiscoveryStatus("xai"), cooling: isModelsFetchCoolingDown("xai"),
      }).toEqual({ status: { status: "ok" }, cooling: false });
      expect(warn.mock.calls.flat().join("\n")).not.toContain(guidance);
      await discover();
      expect(sends).toBe(3);
    } finally {
      releaseBody.resolve();
      await older;
      warn.mockRestore();
      clearModelCache("xai");
    }
  });

  test("the xAI quota probe reports the settings refusal and skips the monthly fallback", async () => {
    await seedOAuth();
    const config = xaiConfig();
    saveConfig(config);
    const sends = refuseAt("/v1/billing?format=credits");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = await fetchProviderQuotaReports(config, true);
      expect(snapshot.reports).toEqual([]);
      const printed = warn.mock.calls.flat().join("\n");
      expect(printed).toContain(guidance);
      expect(printed).not.toContain(privateDetail);
      expect(sends).toEqual(["/v1/billing?format=credits"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("native Responses replaces a 17 KiB Legacy privacy error with fixed guidance", async () => {
    await seedOAuth();
    saveConfig(xaiConfig());
    const sends = refuseAt("/v1/responses", `${privateDetail} ${"x".repeat(17 * 1024)} ${marker}`);
    const server = startServer(0);
    try {
      const result = await post(server);
      expect(result.status).toBe(403);
      const body = await result.text();
      expect(body.includes(privateDetail)).toBe(false);
      expect(body.includes(marker)).toBe(false);
      expect(JSON.parse(body).error).toMatchObject({ message: guidance, code: "permission_denied" });
      expect(sends).toEqual(["/v1/responses"]);
    } finally {
      await server.stop(true);
    }
  });
});
