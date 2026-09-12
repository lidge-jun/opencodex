import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearComboTargetCooldowns } from "../../src/combos/failover";
import { startServer } from "../../src/server";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests } from "../../src/codex/subagent-model-fallback";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import {
  acquireNativeMainProfileDrain,
  getNativeMainProfileRequestCount,
} from "../../src/server/lifecycle";
import { waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { handleNativeProfileAPI } from "../../src/codex/native-profile-api";
import type { NativeProfileManager } from "../../src/codex/native-profile-manager";
import type { OcxConfig } from "../../src/types";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { resetVisionDescriptionCache } from "../../src/vision";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { saveCodexAccountCredential } from "../../src/codex/account-store";

/**
 * Issue #2132: bearer admission must not require a stored ChatGPT credential.
 *
 * #1686 made a caller that proves admission with one of OUR secrets substitute the stored
 * main credential, so the admission secret never leaves the process. That is right for a
 * route that actually reaches the ChatGPT backend. It was applied by asking HOW the caller
 * authenticated and never WHERE the request routes, so a request bound for a
 * key-authenticated provider — which carries its own credential and never touches ChatGPT —
 * was gated on a credential it has no use for. An install that deliberately never logged
 * into ChatGPT got 401 "No usable Codex main credential" on every request.
 *
 * The substitution itself is unchanged and still fails closed for native routes; only the
 * question it is asked changes.
 */

const originalFetch = globalThis.fetch;
const previousOcxHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousCursorTestToken = process.env.OPENCODEX_CURSOR_TEST_TOKEN;

let ocxHome = "";
let codexHome = "";
let routedAuth: Array<string | null> = [];
let nativeAuth: Array<string | null> = [];
let nativeAccountIds: Array<string | null> = [];

const ADMISSION_SECRET = "ocx_data_2132secret";
const ROUTED_KEY = "sk-routed-provider-key";
const inspectNativeCodexOwnership = ownedServiceHomeInspection("bearer admission routed provider test");

/** A JWT whose `exp` is far in the future, so a stored main token reads as live. */
function liveJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
  return `header.${payload}.signature`;
}

/**
 * A remote bind (so admission is required rather than loopback-waived) with BOTH a native
 * openai row and a key-authenticated routed provider. The routed provider is the one under
 * test; the native row has to exist for the negative case to be reachable.
 */
function mixedConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
        defaultModel: "gpt-5.5",
      },
      gateway: {
        adapter: "openai-chat",
        baseUrl: "https://gateway.example.com/v1",
        authMode: "key",
        apiKey: ROUTED_KEY,
        models: ["gateway-model"],
      },
    },
    apiKeys: [
      { id: "env-key", name: "env_key", key: ADMISSION_SECRET, createdAt: "2026-08-20T00:00:00.000Z" },
    ],
  } as OcxConfig;
}

function cursorForwardConfig(baseUrl: string, apiKey?: string): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "cursorcustom",
    providers: {
      cursorcustom: {
        adapter: "cursor",
        baseUrl,
        allowPrivateNetwork: true,
        authMode: "forward",
        ...(apiKey ? { apiKey } : {}),
        liveModels: false,
        models: ["auto"],
        defaultModel: "auto",
      },
    },
    apiKeys: [
      { id: "env-key", name: "env_key", key: ADMISSION_SECRET, createdAt: "2026-08-20T00:00:00.000Z" },
    ],
  } as OcxConfig;
}

async function withCursorCaptureServer<T>(
  run: (baseUrl: string, capturedAuth: Array<string | null>) => Promise<T>,
  beforeResponse?: () => Promise<void>,
): Promise<T> {
  const capturedAuth: Array<string | null> = [];
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer();
  server.on("session", session => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    const auth = headers.authorization;
    capturedAuth.push(typeof auth === "string" ? auth : null);
    const respond = () => {
      if (stream.destroyed || stream.closed) return;
      stream.respond({
        ":status": typeof auth === "string" ? 200 : 401,
        "content-type": "application/connect+proto",
      });
      stream.end();
    };
    if (beforeResponse) void beforeResponse().then(respond).catch(error => stream.destroy(error));
    else respond();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cursor capture fixture did not bind");
  try {
    return await run(`http://127.0.0.1:${address.port}`, capturedAuth);
  } finally {
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

beforeEach(() => {
  resetVisionDescriptionCache();
  clearComboTargetCooldowns();
  resetSubagentModelFallbackStateForTests();
  delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
  ocxHome = mkdtempSync(join(tmpdir(), "ocx-2132-home-"));
  codexHome = mkdtempSync(join(tmpdir(), "ocx-2132-codex-"));
  process.env.OPENCODEX_HOME = ocxHome;
  process.env.CODEX_HOME = codexHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  routedAuth = [];
  nativeAuth = [];
  nativeAccountIds = [];
  globalThis.fetch = (async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (url.hostname === "gateway.example.com") {
      routedAuth.push(headers.get("authorization"));
      return Response.json({
        id: "chatcmpl_2132",
        object: "chat.completion",
        created: 0,
        model: "gateway-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    }
    if (url.hostname === "chatgpt.com" || url.hostname === "api.openai.com") {
      nativeAuth.push(headers.get("authorization"));
      nativeAccountIds.push(headers.get("chatgpt-account-id"));
      return Response.json({ id: "resp_2132", object: "response", status: "completed", output: [] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  resetVisionDescriptionCache();
  closeRequestHistoryIndex();
  clearComboTargetCooldowns();
  resetSubagentModelFallbackStateForTests();
  if (previousCursorTestToken === undefined) delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
  else process.env.OPENCODEX_CURSOR_TEST_TOKEN = previousCursorTestToken;
  globalThis.fetch = originalFetch;
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (ocxHome) removeTreeWithRetry(ocxHome);
  if (codexHome) removeTreeWithRetry(codexHome);
  ocxHome = "";
  codexHome = "";
});

async function postResponses(
  url: string | URL,
  model: string,
  authHeaders: HeadersInit = { authorization: `Bearer ${ADMISSION_SECRET}` },
): Promise<Response> {
  const headers = new Headers(authHeaders);
  headers.set("content-type", "application/json");
  return originalFetch(new URL("/v1/responses", url), {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: "hi", stream: false }),
  });
}

async function postChatCompletions(
  url: string | URL,
  model: string,
  authHeaders: HeadersInit,
): Promise<Response> {
  const headers = new Headers(authHeaders);
  headers.set("content-type", "application/json");
  return originalFetch(new URL("/v1/chat/completions", url), {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false }),
  });
}

async function postClaudeMessages(
  url: string | URL,
  model: string,
): Promise<Response> {
  return originalFetch(new URL("/v1/messages", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ADMISSION_SECRET,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }),
  });
}

async function startOwnedServer(): Promise<ReturnType<typeof startServer>> {
  const server = startServer(0, { inspectNativeCodexOwnership });
  await waitForNativeMainStartupGate();
  return server;
}

describe("#2132 bearer admission does not require a ChatGPT credential for routed providers", () => {
  test("a key-authenticated route is served with no stored main credential", async () => {
    saveConfig(mixedConfig());
    // The reported install: no ChatGPT login was ever performed.
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      const response = await postResponses(server.url, "gateway/gateway-model");

      // Before this change the same request answered 401 "No usable Codex main credential",
      // because admission-by-bearer alone decided a ChatGPT token had to be substituted.
      expect(response.status).toBe(200);
      // The provider's own key is what authenticates it, and our admission secret stays home.
      expect(routedAuth).toEqual([`Bearer ${ROUTED_KEY}`]);
      expect(routedAuth.join("|")).not.toContain(ADMISSION_SECRET);
      expect(nativeAuth).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a native route with no stored main credential still fails closed", async () => {
    saveConfig(mixedConfig());
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      await waitForNativeMainStartupGate();
      const response = await postResponses(server.url, "gpt-5.5");

      // This is the #1686 guarantee and it must survive: a native route genuinely needs the
      // stored credential, so it fails BEFORE any upstream I/O rather than forwarding ours.
      expect(response.status).toBe(401);
      expect(nativeAuth).toHaveLength(0);
      expect(routedAuth).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a native route still substitutes the stored main credential when one exists", async () => {
    saveConfig(mixedConfig());
    const stored = liveJwt();
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      await waitForNativeMainStartupGate();
      const response = await postResponses(server.url, "gpt-5.5");

      expect(response.status).toBe(200);
      expect(nativeAuth).toEqual([`Bearer ${stored}`]);
      expect(nativeAuth.join("|")).not.toContain(ADMISSION_SECRET);
    } finally {
      await server.stop(true);
    }
  });
});

describe("bearer admission is not reused as a Cursor upstream credential", () => {
  test("a bearer admission secret is stripped before Cursor token fallback", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

      const server = startServer(0, { inspectNativeCodexOwnership });
      try {
        const response = await postResponses(server.url, "cursorcustom/auto");
        // The runTurn adapter reports its pre-dispatch failure in a Responses terminal.
        expect(await response.json()).toMatchObject({ status: "failed" });
        expect(capturedAuth).toEqual([]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test("dedicated admission preserves a separate Cursor bearer", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

      const server = startServer(0, { inspectNativeCodexOwnership });
      try {
        await postResponses(server.url, "cursorcustom/auto", {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: "Bearer cursor-upstream-token",
        });
        expect(capturedAuth).toEqual(["Bearer cursor-upstream-token"]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test("bearer admission still uses a configured Cursor credential", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl, "cursor-configured-token"));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

      const server = startServer(0, { inspectNativeCodexOwnership });
      try {
        await postResponses(server.url, "cursorcustom/auto");
        expect(capturedAuth).toEqual(["Bearer cursor-configured-token"]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test("dedicated admission refuses another proxy secret as Cursor auth", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

      const server = startServer(0, { inspectNativeCodexOwnership });
      try {
        const response = await postResponses(server.url, "cursorcustom/auto", {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: `Bearer ${ADMISSION_SECRET}`,
        });
        expect(response.status).toBe(401);
        expect(capturedAuth).toEqual([]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test("configured Cursor auth still wins when dedicated admission carries a proxy bearer", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl, "cursor-configured-token"));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

      const server = startServer(0, { inspectNativeCodexOwnership });
      try {
        await postResponses(server.url, "cursorcustom/auto", {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: `Bearer ${ADMISSION_SECRET}`,
        });
        expect(capturedAuth).toEqual(["Bearer cursor-configured-token"]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test("Chat dedicated admission preserves its separate Cursor bearer over stored main auth", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: liveJwt(), account_id: "stored_main_acc" },
      }));

      const server = await startOwnedServer();
      try {
        await postChatCompletions(server.url, "cursorcustom/auto", {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: "Bearer cursor-upstream-token",
        });
        expect(capturedAuth).toEqual(["Bearer cursor-upstream-token"]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test.each([
    "configured-vision-text", "default-sidecars", "no-stored-main", "disabled-vision",
    "terminal-vision", "routed-vision", "anthropic-vision", "missing-openai",
    "noncanonical-openai", "search-runTurn", "search-tool-choice-none",
  ])("Chat Cursor leaves native main switchable without a planned OpenAI helper (%s)", async scenario => {
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>(resolve => { releaseUpstream = resolve; });
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      const config = cursorForwardConfig(baseUrl);
      config.openaiProviderTierVersion = 2;
      config.providers.cursorcustom!.noVisionModels = ["auto"];
      config.providers.openai = {
        adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward", codexAccountMode: "direct",
      };
      config.visionSidecar = { enabled: true, backend: "openai", model: "gpt-5.6-luna" };
      if (scenario === "default-sidecars") delete config.visionSidecar;
      if (scenario === "disabled-vision") config.visionSidecar.enabled = false;
      if (scenario === "routed-vision") {
        config.providers.gateway = { ...mixedConfig().providers.gateway!, models: ["vision-model"] };
        config.visionSidecar = { enabled: true, backend: "routed", model: "gateway/vision-model" };
      }
      if (scenario === "anthropic-vision") config.visionSidecar.backend = "anthropic";
      if (scenario === "missing-openai") delete config.providers.openai;
      if (scenario === "noncanonical-openai") {
        // Keep the reserved OpenAI row absent; a custom forward provider is valid config
        // but is not authority to inject stored ChatGPT credentials into a sidecar.
        config.providers.mirror = { adapter: "openai-responses", authMode: "forward", baseUrl: "https://mirror.example.com/v1" };
        delete config.providers.openai;
      }
      const search = scenario.startsWith("search-");
      if (search) config.webSearchSidecar = { enabled: true, backend: "openai", model: "gpt-5.6-luna" };
      const withImage = ["disabled-vision", "terminal-vision", "routed-vision", "anthropic-vision", "missing-openai", "noncanonical-openai"].includes(scenario);
      saveConfig(config);
      const stored = fakeChatGptJwt({ chatgpt_account_id: "stored_main_acc", exp: Math.floor(Date.now() / 1000) + 3600 });
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
        tokens: scenario === "no-stored-main" ? {} : { access_token: stored, account_id: "stored_main_acc" },
      }));
      const server = await startOwnedServer();
      let settled = false;
      const pending = originalFetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: "Bearer cursor-upstream-token",
          ...(scenario === "terminal-vision" ? { "x-opencodex-vision-describe": "1" } : {}),
        },
        body: JSON.stringify({ model: "cursorcustom/auto", stream: false, messages: [{ role: "user",
          content: withImage ? [{ type: "text", text: "Describe this image" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=" } }] : "hi",
        }], ...(search ? { tools: [{ type: "web_search" }] } : {}),
        ...(scenario === "search-tool-choice-none" ? { tool_choice: "none" } : {}),
        }),
      }).then(response => { settled = true; return response; });
      try {
        await Promise.race([started, pending.then(async response => {
          const result = await response.clone().json().catch(() => ({})) as { error?: { code?: string; message?: string } };
          throw new Error(`Cursor response settled before its held upstream: HTTP ${response.status}, ${result.error?.code ?? ""}: ${result.error?.message ?? ""}`);
        })]);
        expect(settled).toBe(false);
        expect(capturedAuth).toEqual(["Bearer cursor-upstream-token"]);
        expect(getNativeMainProfileRequestCount()).toBe(0);
        let switches = 0;
        const manager = { switch: async () => { switches += 1; return { ok: true }; } } as unknown as NativeProfileManager;
        const switchUrl = new URL("http://localhost/api/native-main-profiles/switch");
        const switched = await handleNativeProfileAPI(new Request(switchUrl, {
          method: "POST", body: JSON.stringify({ target: "target", confirmedStopped: true }),
        }), switchUrl, config, { manager, drainTimeoutMs: 0 });
        expect(switched?.status).toBe(200);
        expect(switches).toBe(1);
        expect(settled).toBe(false);
        expect(nativeAuth).toEqual([]);
      } finally {
        releaseUpstream();
        try { await (await pending).text(); } finally { await server.stop(true); }
      }
      expect(getNativeMainProfileRequestCount()).toBe(0);
    }, async () => { signalStarted(); await upstreamGate; });
  }, SERVER_BUDGET_MS);

  test.each(["owned", "fenced", "pool", "pool-fenced"])("Chat Cursor keeps stored vision auth off its primary wire (%s)", async ownership => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      const config = cursorForwardConfig(baseUrl);
      const pool = ownership.startsWith("pool");
      config.providers.cursorcustom!.noVisionModels = ["auto"];
      config.providers.openai = {
        adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward", codexAccountMode: pool ? "pool" : "direct",
      };
      // Keep this auth fixture independent of the legacy sidecar model migration.
      config.visionSidecar = { enabled: true, backend: "openai", model: "gpt-5.6-luna" };
      if (pool) {
        config.codexAccounts = [{ id: "sidecar-pool", label: "sidecar pool", isMain: false, chatgptAccountId: "sidecar_pool_acc" }];
        config.activeCodexAccountId = "sidecar-pool";
        config.autoSwitchThreshold = 0;
        saveCodexAccountCredential("sidecar-pool", {
          accessToken: "sidecar-pool-token", refreshToken: "sidecar-pool-refresh",
          expiresAt: Date.now() + 3_600_000, chatgptAccountId: "sidecar_pool_acc",
        });
      }
      saveConfig(config);
      const stored = fakeChatGptJwt({ chatgpt_account_id: "stored_main_acc", exp: Math.floor(Date.now() / 1000) + 3600 });
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: stored, account_id: "stored_main_acc" },
      }));
      const sidecar: Array<{ authorization: string | null; account: string | null; claimed: boolean }> = [];
      globalThis.fetch = (async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === "chatgpt.com") {
          // Pool admission can probe quota independently of the vision helper.
          if (url.pathname === "/backend-api/wham/usage") return Response.json({
            rate_limit: { allowed: true, limit_reached: false,
              primary_window: { used_percent: 0, reset_at: Math.floor(Date.now() / 1000) + 3600, limit_window_seconds: 18000 },
              secondary_window: { used_percent: 0, reset_at: Math.floor(Date.now() / 1000) + 86400, limit_window_seconds: 604800 },
            },
          });
          const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
          sidecar.push({ authorization: headers.get("authorization"), account: headers.get("chatgpt-account-id"),
            claimed: getNativeMainProfileRequestCount() > 0 });
          return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "A red square." })}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      const fenced = ownership.endsWith("fenced");
      const server = !fenced ? await startOwnedServer() : startServer(0, {
        inspectNativeCodexOwnership: () => ({ ownership: "foreign", reason: "fixture owned by another service" }),
      });
      try {
        if (fenced) expect(await waitForNativeMainStartupGate()).toMatchObject({ status: "blocked" });
        const response = await originalFetch(new URL("/v1/chat/completions", server.url), {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencodex-api-key": ADMISSION_SECRET,
            authorization: "Bearer cursor-upstream-token" },
          body: JSON.stringify({ model: "cursorcustom/auto", stream: false, messages: [{ role: "user", content: [
            { type: "text", text: "Describe this image" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=" } },
          ] }] }),
        });
        await response.text();
        // The capture-only Cursor fixture ends without a completion frame.
        expect(response.status).toBe(502);
        expect(sidecar).toEqual(ownership === "fenced" ? []
          : [{ authorization: pool ? "Bearer sidecar-pool-token" : `Bearer ${stored}`,
            account: pool ? "sidecar_pool_acc" : "stored_main_acc", claimed: !pool }]);
        expect(capturedAuth).toEqual(["Bearer cursor-upstream-token"]);
      } finally {
        await server.stop(true);
      }
      expect(getNativeMainProfileRequestCount()).toBe(0);
    });
  });

  test("Chat never falls back from missing Cursor auth to stored main auth", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: liveJwt(), account_id: "stored_main_acc" },
      }));

      const server = await startOwnedServer();
      try {
        const response = await postChatCompletions(server.url, "cursorcustom/auto", {
          "x-opencodex-api-key": ADMISSION_SECRET,
        });
        expect(response.status).not.toBe(200);
        expect(capturedAuth).toEqual([]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test("Chat bearer admission is stripped before Cursor token fallback", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: liveJwt(), account_id: "stored_main_acc" },
      }));

      const server = await startOwnedServer();
      try {
        const response = await postChatCompletions(server.url, "cursorcustom/auto", {
          authorization: `Bearer ${ADMISSION_SECRET}`,
        });
        expect(response.status).not.toBe(200);
        expect(capturedAuth).toEqual([]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test.each(["Responses", "Chat"])("%s keeps an explicit OpenAI pair off an unchanged Cursor route", async surface => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));
      const server = await startOwnedServer();
      try {
        const headers = {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "caller-openai" })}`,
          "chatgpt-account-id": "caller-openai",
        };
        const response = surface === "Chat"
          ? await postChatCompletions(server.url, "cursorcustom/auto", headers)
          : await postResponses(server.url, "cursorcustom/auto", headers);
        if (surface === "Responses") {
          expect(await response.json()).toMatchObject({ status: "failed" });
        } else {
          expect(response.status).not.toBe(200);
          await response.text();
        }
        expect(capturedAuth).toEqual([]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test.each(["Responses", "Chat"])("%s never treats a ChatGPT-claimed or combined bearer as a Cursor token", async surface => {
    const chatGptJwt = fakeChatGptJwt({ chatgpt_account_id: "caller-openai" });
    const cases: Array<Record<string, string>> = [
      // A ChatGPT JWT without the matching account header is still the ChatGPT domain.
      { authorization: `Bearer ${chatGptJwt}` },
      // A mismatched explicit account does not reclassify the token.
      { authorization: `Bearer ${chatGptJwt}`, "chatgpt-account-id": "other-account" },
      // A combined value is not a single Cursor token.
      { authorization: `Bearer ${chatGptJwt}, Bearer other` },
      // Conflicting ChatGPT markers are ChatGPT-marked but untrustworthy, not foreign-allowed.
      { authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "caller-openai", "https://api.openai.com/auth": { chatgpt_account_id: "other-claim" } })}` },
      // A malformed ChatGPT marker is still ChatGPT-marked.
      { authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: 123 })}` },
      // A blank account id is not a usable id.
      { authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "   " })}` },
      // The reserved namespace is a marker by its presence, whatever shape it carries:
      // a primitive, null, an array, or an object without the claim all stay ChatGPT-marked.
      { authorization: `Bearer ${fakeChatGptJwt({ "https://api.openai.com/auth": "not-an-object" })}` },
      { authorization: `Bearer ${fakeChatGptJwt({ "https://api.openai.com/auth": null })}` },
      { authorization: `Bearer ${fakeChatGptJwt({ "https://api.openai.com/auth": [] })}` },
      { authorization: `Bearer ${fakeChatGptJwt({ "https://api.openai.com/auth": {} })}` },
      { authorization: `Bearer ${fakeChatGptJwt({ "https://api.openai.com/auth": { user_id: "u_1" } })}` },
    ];
    for (const extra of cases) {
      await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
        saveConfig(cursorForwardConfig(baseUrl));
        writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));
        const server = await startOwnedServer();
        try {
          const headers = { "x-opencodex-api-key": ADMISSION_SECRET, ...extra };
          const response = surface === "Chat"
            ? await postChatCompletions(server.url, "cursorcustom/auto", headers)
            : await postResponses(server.url, "cursorcustom/auto", headers);
          if (surface === "Responses") {
            expect(await response.json()).toMatchObject({ status: "failed" });
          } else {
            expect(response.status).not.toBe(200);
            await response.text();
          }
          expect(capturedAuth).toEqual([]);
        } finally {
          await server.stop(true);
        }
      });
    }
  });

  test.each(["Responses", "Chat"])("%s keeps an unmarked JWT as the Cursor credential", async surface => {
    // Neither a generic organizations claim nor a payload that is not a JSON object is
    // ChatGPT-domain evidence: the legacy keyless Cursor contract keeps forwarding such a
    // bearer (the account header, a ChatGPT-only header, is still dropped). The primitive
    // payload also proves the domain inspector stays total instead of throwing.
    const orgJwt = fakeChatGptJwt({ organizations: [{ id: "org-foreign" }] });
    const primitivePayloadJwt = `eyJhbGciOiJub25lIn0.${Buffer.from("true").toString("base64url")}.fakesig`;
    for (const [bearer, extra] of [
      [orgJwt, {}],
      [orgJwt, { "chatgpt-account-id": "org-foreign" }],
      [primitivePayloadJwt, {}],
    ] as Array<[string, Record<string, string>]>) {
      await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
        saveConfig(cursorForwardConfig(baseUrl));
        writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));
        const server = await startOwnedServer();
        try {
          const headers = { "x-opencodex-api-key": ADMISSION_SECRET, authorization: `Bearer ${bearer}`, ...extra };
          const response = surface === "Chat"
            ? await postChatCompletions(server.url, "cursorcustom/auto", headers)
            : await postResponses(server.url, "cursorcustom/auto", headers);
          await response.text();
          expect(capturedAuth).toEqual([`Bearer ${bearer}`]);
        } finally {
          await server.stop(true);
        }
      });
    }
  });

  test.each([false, true])("Chat combos never assign caller auth to a Cursor target (OpenAI pair: %s)", async openAiPair => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      const config = cursorForwardConfig(baseUrl);
      config.combos = {
        free: { strategy: "failover", targets: [{ provider: "cursorcustom", model: "auto" }] },
      };
      saveConfig(config);
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: liveJwt(), account_id: "stored_main_acc" },
      }));

      const server = await startOwnedServer();
      try {
        const response = await postChatCompletions(server.url, "combo/free", {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: `Bearer ${openAiPair ? fakeChatGptJwt({ chatgpt_account_id: "caller-openai" }) : "cursor-upstream-token"}`,
          ...(openAiPair ? { "chatgpt-account-id": "caller-openai" } : {}),
        });
        expect(response.status).not.toBe(200);
        expect(capturedAuth).toEqual([]);
      } finally {
        await server.stop(true);
      }
    });
  });

  test.each([false, true])("Responses combos never assign caller auth to a Cursor target (OpenAI pair: %s)", async openAiPair => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      const config = cursorForwardConfig(baseUrl);
      config.combos = {
        free: { strategy: "failover", targets: [{ provider: "cursorcustom", model: "auto" }] },
      };
      saveConfig(config);
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

      const server = startServer(0, { inspectNativeCodexOwnership });
      try {
        const response = await postResponses(server.url, "combo/free", {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: `Bearer ${openAiPair ? fakeChatGptJwt({ chatgpt_account_id: "caller-openai" }) : "cursor-upstream-token"}`,
          ...(openAiPair ? { "chatgpt-account-id": "caller-openai" } : {}),
        });
        expect(response.status).not.toBe(200);
        expect(capturedAuth).toEqual([]);
      } finally {
        await server.stop(true);
      }
    });
  });

  // A present reserved namespace carries the marker whatever its shape, so every broken
  // shape is untrustworthy rather than foreign, and is denied restore.
  const brokenNamespaces: Record<string, unknown> = {
    "namespace-empty-object": {},
    "namespace-primitive": "not-an-object",
    "namespace-null": null,
    "namespace-array": [],
    "namespace-without-claim": { user_id: "u_1" },
  };

  const callerBearers: Record<string, string> = {
    "opaque-with-account": "opaque-caller-direct-token",
    // The namespaced marker alone is a valid ChatGPT-domain claim.
    "ns-claim-only": fakeChatGptJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "caller-openai" } }),
    // A generic organizations claim is not ChatGPT-domain evidence.
    "org-only-jwt": fakeChatGptJwt({ organizations: [{ id: "org-foreign" }] }),
    "conflicting-claims": fakeChatGptJwt({ chatgpt_account_id: "caller-openai", "https://api.openai.com/auth": { chatgpt_account_id: "other-claim" } }),
    "blank-account-id": fakeChatGptJwt({ chatgpt_account_id: "   " }),
    "numeric-account-id": fakeChatGptJwt({ chatgpt_account_id: 123 }),
    ...Object.fromEntries(Object.entries(brokenNamespaces)
      .map(([name, shape]) => [name, fakeChatGptJwt({ "https://api.openai.com/auth": shape })])),
  };

  test("a bearer-admitted Responses combo still substitutes stored main on its final Direct target", async () => {
    const config = mixedConfig();
    config.combos = {
      native: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-5.6-luna" }] },
    };
    const stored = liveJwt();
    saveConfig(config);
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );

    const server = await startOwnedServer();
    try {
      const response = await postResponses(server.url, "combo/native");
      expect(response.status).toBe(200);
      expect(nativeAuth).toEqual([`Bearer ${stored}`]);
      expect(nativeAuth.join("|")).not.toContain(ADMISSION_SECRET);
    } finally {
      await server.stop(true);
    }
  });

  test.each(["jwt-only", "jwt-with-account", "ns-claim-only", "opaque-with-account", "jwt-mismatched-account", "org-only-jwt", "conflicting-claims", "namespace-empty-object", "namespace-primitive", "namespace-null", "namespace-array", "namespace-without-claim", "blank-account-id", "numeric-account-id"])(
    "a dedicated-admission Responses combo scopes caller auth (%s) to its final Direct target",
    async form => {
      const config = mixedConfig();
      config.combos = {
        native: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-5.6-luna" }] },
      };
      saveConfig(config);
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));
      const callerBearer = callerBearers[form] ?? fakeChatGptJwt({ chatgpt_account_id: "caller-openai" });
      const accountHeader = form === "jwt-only" || form === "ns-claim-only" ? undefined
        : form === "jwt-mismatched-account" ? "other-account"
        : form === "org-only-jwt" ? "org-foreign"
        : "caller-openai";

      const server = await startOwnedServer();
      try {
        const response = await postResponses(server.url, "combo/native", {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: `Bearer ${callerBearer}`,
          ...(accountHeader ? { "chatgpt-account-id": accountHeader } : {}),
        });
        const body = await response.json() as { status?: string };
        if (form === "jwt-only" || form === "jwt-with-account" || form === "ns-claim-only") {
          expect(response.status).toBe(200);
          expect(body).toMatchObject({ status: "completed" });
          expect(nativeAuth).toEqual([`Bearer ${callerBearer}`]);
          expect(nativeAccountIds).toEqual(["caller-openai"]);
        } else {
          expect(response.status >= 400 || body.status === "failed").toBe(true);
          expect(nativeAuth).toEqual([]);
          expect(nativeAccountIds).toEqual([]);
        }
      } finally {
        await server.stop(true);
      }
    },
  );

  test("Chat thread-spawn fallback never carries the provisional Cursor bearer into Direct", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      const config = cursorForwardConfig(baseUrl);
      config.providers.openai = {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
        defaultModel: "gpt-5.6-luna",
      };
      config.subagentModelFallback = ["gpt-5.6-luna"];
      const stored = liveJwt();
      saveConfig(config);
      noteSubagentModelFailure("cursorcustom/auto", "429", config);
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
      );

      const server = await startOwnedServer();
      try {
        const response = await postChatCompletions(server.url, "cursorcustom/auto", {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: "Bearer cursor-upstream-token",
          "x-openai-subagent": "collab_spawn",
        });
        expect(capturedAuth).toEqual([]);
        expect(nativeAuth).toEqual([]);
        expect(response.status).toBe(401);
      } finally {
        await server.stop(true);
      }
    });
  });

  test("Responses thread-spawn fallback never carries the provisional Cursor bearer into Direct", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      const config = cursorForwardConfig(baseUrl);
      config.providers.openai = {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
        defaultModel: "gpt-5.6-luna",
      };
      config.subagentModelFallback = ["gpt-5.6-luna"];
      const stored = liveJwt();
      saveConfig(config);
      noteSubagentModelFailure("cursorcustom/auto", "429", config);
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
      );

      const server = await startOwnedServer();
      try {
        const response = await postResponses(server.url, "cursorcustom/auto", {
          "x-opencodex-api-key": ADMISSION_SECRET,
          authorization: "Bearer cursor-upstream-token",
          "x-openai-subagent": "collab_spawn",
        });
        expect(capturedAuth).toEqual([]);
        expect(nativeAuth).toEqual([]);
        expect(response.status).toBe(401);
      } finally {
        await server.stop(true);
      }
    });
  });

  test("Chat thread marker without a route rewrite preserves the caller's native credential", async () => {
    saveConfig(mixedConfig());
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

    const server = await startOwnedServer();
    try {
      const response = await postChatCompletions(server.url, "gpt-5.6-luna", {
        "x-opencodex-api-key": ADMISSION_SECRET,
        authorization: "Bearer caller-native-token",
        "x-openai-subagent": "collab_spawn",
      });
      expect(response.status).toBe(200);
      expect(nativeAuth).toEqual(["Bearer caller-native-token"]);
      expect(routedAuth).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  for (const surface of ["Chat", "Responses"] as const) {
    test(`${surface} policy routes never assign one provisional bearer to a selected provider`, async () => {
      await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
        const config = cursorForwardConfig(baseUrl);
        config.routingProfiles = {
          cursor: { candidates: [{ provider: "cursorcustom", model: "auto" }] },
        };
        saveConfig(config);
        writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

        const server = startServer(0, { inspectNativeCodexOwnership });
        try {
          const authHeaders = {
            "x-opencodex-api-key": ADMISSION_SECRET,
            authorization: "Bearer cursor-upstream-token",
          };
          const response = surface === "Chat"
            ? await postChatCompletions(server.url, "policy/cursor", authHeaders)
            : await postResponses(server.url, "policy/cursor", authHeaders);
          const status = response.status;
          await response.arrayBuffer();
          expect(capturedAuth).toEqual([]);
          // Chat returns a pre-stream provider failure; Responses may encode the same terminal
          // failure inside its normal response envelope. The wire observation is authoritative.
          expect([200, 502]).toContain(status);
        } finally {
          await server.stop(true);
        }
      });
    });
  }

  test("Claude policy routing preserves trusted main auth only for its final Direct target", async () => {
    const config = mixedConfig();
    config.routingProfiles = {
      native: { candidates: [{ provider: "openai", model: "gpt-5.6-luna" }] },
    };
    const stored = liveJwt();
    saveConfig(config);
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );

    const server = await startOwnedServer();
    try {
      const response = await postClaudeMessages(server.url, "policy/native");
      expect(response.status).toBe(200);
      expect(nativeAuth).toEqual([`Bearer ${stored}`]);
    } finally {
      await server.stop(true);
    }
  });

  test("Claude Combo routing reconstructs trusted main auth for its final Direct target", async () => {
    const config = mixedConfig();
    config.combos = {
      native: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-5.6-luna" }] },
    };
    const stored = liveJwt();
    saveConfig(config);
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );

    const server = await startOwnedServer();
    try {
      const response = await postClaudeMessages(server.url, "combo/native");
      expect(response.status).toBe(200);
      expect(nativeAuth).toEqual([`Bearer ${stored}`]);
    } finally {
      await server.stop(true);
    }
  });

  test("Claude Combo routing cannot reconstruct main auth when the profile claim was fenced", async () => {
    const config = mixedConfig();
    config.combos = {
      native: { strategy: "failover", targets: [{ provider: "openai", model: "gpt-5.6-luna" }] },
    };
    saveConfig(config);
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: liveJwt(), account_id: "stored_main_acc" } }),
    );

    const server = startServer(0, {
      inspectNativeCodexOwnership: () => ({ ownership: "foreign", reason: "fixture-owned by another service" }),
    });
    try {
      expect(await waitForNativeMainStartupGate()).toMatchObject({
        status: "blocked",
        reason: "foreign-ownership",
      });
      const response = await postClaudeMessages(server.url, "combo/native");
      expect(response.status).toBe(401);
      expect(nativeAuth).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  for (const surface of ["Chat", "Responses"] as const) {
    test(`${surface} shadow-call rewrites never carry the source route bearer into Cursor`, async () => {
      await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
        const config = cursorForwardConfig(baseUrl);
        config.providers.openai = {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
          defaultModel: "gpt-5.6-luna",
        };
        config.shadowCallIntercept = {
          enabled: true,
          model: "cursorcustom/auto",
          sourceModels: ["gpt-5.6-luna"],
        };
        saveConfig(config);
        writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

        const server = startServer(0, { inspectNativeCodexOwnership });
        try {
          const authHeaders = {
            "x-opencodex-api-key": ADMISSION_SECRET,
            authorization: "Bearer source-route-token",
          };
          const response = surface === "Chat"
            ? await postChatCompletions(server.url, "gpt-5.6-luna", authHeaders)
            : await postResponses(server.url, "gpt-5.6-luna", authHeaders);
          const status = response.status;
          await response.arrayBuffer();
          expect(capturedAuth).toEqual([]);
          expect([200, 401, 502]).toContain(status);
        } finally {
          await server.stop(true);
        }
      });
    });
  }

  test("Claude replay never treats stored main auth as a Cursor credential", async () => {
    await withCursorCaptureServer(async (baseUrl, capturedAuth) => {
      saveConfig(cursorForwardConfig(baseUrl));
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
        tokens: { access_token: liveJwt(), account_id: "stored_main_acc" },
      }));

      const server = await startOwnedServer();
      try {
        const response = await postClaudeMessages(server.url, "cursorcustom/auto");
        expect(response.status).toBe(502);
        expect(capturedAuth).toEqual([]);
      } finally {
        await server.stop(true);
      }
    });
  });
});

/**
 * The predicate above must be keyed on TRANSPORT, not on the provider's name.
 *
 * `codexAccountMode` comes from `providerCodexAccountMode`, which special-cases the id
 * `openai`. The passthrough adapter decides whether it may forward caller credentials from
 * `isCanonicalOpenAiForwardProvider` — adapter, auth mode, and base URL. A row the operator
 * named anything else, pointed at the canonical ChatGPT backend, satisfies the adapter's test
 * and fails the name-based one. Substitution was therefore skipped and the adapter forwarded
 * our own admission secret to ChatGPT.
 *
 * These assert the invariant rather than the implementation: an admission bearer must never
 * reach the wire, whatever the row is called.
 */
describe("an admission bearer never reaches a canonical ChatGPT transport, whatever the row is named", () => {
  function customNamedCanonicalConfig(): OcxConfig {
    const base = mixedConfig();
    return {
      ...base,
      defaultProvider: "mirror",
      providers: {
        ...base.providers,
        // Same adapter, same authMode, same canonical base URL as the `openai` row above.
        // Only the name differs — and the name is not what carries the header upstream.
        mirror: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          defaultModel: "gpt-5.5",
        },
      },
    } as OcxConfig;
  }

  test("with no stored credential it fails closed instead of forwarding our secret", async () => {
    saveConfig(customNamedCanonicalConfig());
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      await waitForNativeMainStartupGate();
      const response = await postResponses(server.url, "mirror/gpt-5.5");

      // Fail-before-I/O is the contract (src/codex/auth-context.ts): the only two acceptable
      // outcomes for an admission bearer are replaced-with-stored-main, or refused. Reaching
      // upstream at all with our secret in hand is the failure this pins.
      expect(nativeAuth.join("|")).not.toContain(ADMISSION_SECRET);
      expect(response.status).not.toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("with a stored credential the stored one is what goes upstream", async () => {
    saveConfig(customNamedCanonicalConfig());
    const stored = liveJwt();
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      await waitForNativeMainStartupGate();
      await postResponses(server.url, "mirror/gpt-5.5");

      expect(nativeAuth.join("|")).not.toContain(ADMISSION_SECRET);
      for (const sent of nativeAuth) expect(sent).toBe(`Bearer ${stored}`);
    } finally {
      await server.stop(true);
    }
  });

  test("stored-main substitution respects a native-main drain", async () => {
    saveConfig(customNamedCanonicalConfig());
    const stored = liveJwt();
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );

    const server = startServer(0, { inspectNativeCodexOwnership });
    let drain: ReturnType<typeof acquireNativeMainProfileDrain> = null;
    try {
      await waitForNativeMainStartupGate();
      drain = acquireNativeMainProfileDrain("custom-forward-substitution");
      expect(drain).not.toBeNull();
      const response = await postResponses(server.url, "mirror/gpt-5.5");

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(nativeAuth).toHaveLength(0);
      expect(routedAuth).toHaveLength(0);
    } finally {
      drain?.release();
      await server.stop(true);
    }
  });

  test("stored-main substitution holds ownership until the upstream request settles", async () => {
    saveConfig(customNamedCanonicalConfig());
    const stored = liveJwt();
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );
    let signalUpstreamStarted!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => { signalUpstreamStarted = resolve; });
    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    globalThis.fetch = (async (input, init) => {
      const raw = input instanceof Request ? input.url : String(input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      if (new URL(raw).hostname === "chatgpt.com") {
        nativeAuth.push(headers.get("authorization"));
        signalUpstreamStarted();
        await upstreamGate;
        return Response.json({ id: "resp_2132_held", object: "response", status: "completed", output: [] });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0, { inspectNativeCodexOwnership });
    let pending: Promise<Response> | null = null;
    try {
      await waitForNativeMainStartupGate();
      pending = postResponses(server.url, "mirror/gpt-5.5");
      const switchUrl = new URL("http://localhost/api/native-main-profiles/switch");
      const switchRequest = () => new Request(switchUrl, {
        method: "POST",
        body: JSON.stringify({ target: "target", confirmedStopped: true }),
      });
      let switches = 0;
      const manager = {
        switch: async () => {
          switches += 1;
          return { ok: true };
        },
      } as unknown as NativeProfileManager;
      await upstreamStarted;
      expect(getNativeMainProfileRequestCount()).toBe(1);
      const blocked = await handleNativeProfileAPI(
        switchRequest(),
        switchUrl,
        {} as OcxConfig,
        { manager, drainTimeoutMs: 0 },
      );
      expect(blocked?.status).toBe(409);
      expect(switches).toBe(0);

      releaseUpstream();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(nativeAuth).toEqual([`Bearer ${stored}`]);
      expect(getNativeMainProfileRequestCount()).toBe(0);
      const switched = await handleNativeProfileAPI(
        switchRequest(),
        switchUrl,
        {} as OcxConfig,
        { manager, drainTimeoutMs: 0 },
      );
      expect(switched?.status).toBe(200);
      expect(switches).toBe(1);
    } finally {
      releaseUpstream();
      await pending?.catch(() => {});
      await server.stop(true);
    }
  });
});
