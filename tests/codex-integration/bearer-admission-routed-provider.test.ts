import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
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
    stream.respond({
      ":status": typeof auth === "string" ? 200 : 401,
      "content-type": "application/connect+proto",
    });
    stream.end();
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
  resetSubagentModelFallbackStateForTests();
  delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
  ocxHome = mkdtempSync(join(tmpdir(), "ocx-2132-home-"));
  codexHome = mkdtempSync(join(tmpdir(), "ocx-2132-codex-"));
  process.env.OPENCODEX_HOME = ocxHome;
  process.env.CODEX_HOME = codexHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  routedAuth = [];
  nativeAuth = [];
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
      return Response.json({ id: "resp_2132", object: "response", status: "completed", output: [] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  closeRequestHistoryIndex();
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
        await response.text();
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
          await response.text();
          expect(capturedAuth).toEqual([]);
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
