import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleResponses } from "../../src/server/responses";
import { normalizeLogConversationId } from "../../src/server/request-log-conversation";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #3433 transport contract only: these client-assigned fixture IDs are not a capture of Hermes.
const originalFetch = globalThis.fetch;
const identityHeaders = ["session_id", "session-id", "thread-id", "x-codex-parent-thread-id"];
let isolated: IsolatedCodexHome;
let home: string;
let previousHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  isolated = installIsolatedCodexHome("ocx-chat-identity-");
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-chat-identity-config-"));
  process.env.OPENCODEX_HOME = home;
  // Taken after this case installs its home so direct Chat dispatch owns that journal.
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(() => {
  // Released before this case restores and removes its home so no live database is unlinked.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  isolated.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

interface Capture { headers: Headers; body: Record<string, unknown> }
function mockNativeWire(): Capture[] {
  const seen: Capture[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/responses");
    seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "resp_chat_identity", object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } } });
  }) as typeof fetch;
  return seen;
}

async function chat(headers: Record<string, string>, cacheKey: string | undefined, continued: boolean) {
  const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-chat-caller", exp: Math.floor(Date.now() / 1000) + 86400 });
  const config = { defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {
    openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
      baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
  } } as OcxConfig;
  const messages = [{ role: "system", content: "A shared prefix is not a conversation identity." },
    { role: "user", content: "first turn" },
    ...(continued ? [{ role: "assistant", content: "first answer" }, { role: "user", content: "next turn" }] : [])];
  const req = new Request("http://localhost/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
      "chatgpt-account-id": "fixture-chat-caller", ...headers },
    body: JSON.stringify({ model: "openai/gpt-5.6-luna", messages, stream: false, reasoning_effort: "medium",
      ...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }) }),
  });
  const response = await handleChatCompletions(req, config, { model: "", provider: "" });
  await response.text();
  expect(response.status).toBe(200);
}

describe("Chat conversation identity at canonical Responses outbound boundary", () => {
  for (const keyPresent of [false, true]) {
    for (const shape of ["underscore", "hyphen-pair"] as const) {
      test(`${shape}, key=${keyPresent}: A/A/B retains caller identity and independent request IDs`, async () => {
        const seen = mockNativeWire();
        const key = keyPresent ? "shared-cache-cohort" : undefined;
        for (const [index, conversation] of ["a", "a", "b"].entries()) {
          const identity: Record<string, string> = shape === "underscore"
            ? { session_id: `conversation-${conversation}` }
            : { "session-id": `session-${conversation}`, "thread-id": `thread-${conversation}` };
          const expected = shape === "hyphen-pair" ? { ...identity, session_id: identity["session-id"] } : identity;
          await chat({ ...identity, "x-client-request-id": `request-${index}` }, key, index === 1);
          expect(seen).toHaveLength(index + 1);
          const wire = seen[index]!;
          for (const name of identityHeaders) expect(wire.headers.get(name)).toBe(expected[name] ?? null);
          expect(wire.headers.get("x-client-request-id")).toBe(`request-${index}`);
          expect(wire.body.prompt_cache_key).toBe(key);
          expect(Object.hasOwn(wire.body, "prompt_cache_key")).toBe(keyPresent);
          expect(wire.body.reasoning).toMatchObject({ effort: "medium" });
        }
        expect(JSON.stringify(seen[1]!.body.input).length).toBeGreaterThan(JSON.stringify(seen[0]!.body.input).length);
        expect(seen[0]!.body.input).toEqual(seen[2]!.body.input);
      }, 20_000);
    }

    test(`identity absent, key=${keyPresent}: no session is synthesized`, async () => {
      const seen = mockNativeWire();
      for (const continued of [false, true]) await chat({}, keyPresent ? "shared-cache-cohort" : undefined, continued);
      expect(seen).toHaveLength(2);
      for (const wire of seen) {
        for (const name of identityHeaders) expect(wire.headers.has(name)).toBe(false);
        expect(wire.body.prompt_cache_key).toBe(keyPresent ? "shared-cache-cohort" : undefined);
      }
    }, 20_000);
  }
  test("Hermes x-hermes-conversation-id is captured into logCtx and stripped before Responses outbound wire", async () => {
    const seen = mockNativeWire();
    const rawHermesId = "hermes-fixture-wire";
    const logCtx = { model: "", provider: "" } as Parameters<typeof handleChatCompletions>[2];
    const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-chat-caller", exp: Math.floor(Date.now() / 1000) + 86400 });
    const config = { defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    } } as OcxConfig;
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
        "chatgpt-account-id": "fixture-chat-caller", "x-hermes-conversation-id": rawHermesId },
      body: JSON.stringify({ model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "ping" }], stream: false }),
    });
    const response = await handleChatCompletions(req, config, logCtx);
    await response.text();
    expect(response.status).toBe(200);
    expect(logCtx.conversationId).toBe(normalizeLogConversationId(rawHermesId));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.has("x-hermes-conversation-id")).toBe(false);
  });

  test("native session-id header strictly wins over x-hermes-conversation-id across the Chat bridge", async () => {
    const seen = mockNativeWire();
    const rawHermesId = "hermes-fixture-wire";
    const rawSessionId = "native-session-precedence-456";
    const logCtx = { model: "", provider: "" } as Parameters<typeof handleChatCompletions>[2];
    const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-chat-caller", exp: Math.floor(Date.now() / 1000) + 86400 });
    const config = { defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    } } as OcxConfig;
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
        "chatgpt-account-id": "fixture-chat-caller", "x-hermes-conversation-id": rawHermesId, "session_id": rawSessionId },
      body: JSON.stringify({ model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "ping" }], stream: false }),
    });
    const response = await handleChatCompletions(req, config, logCtx);
    await response.text();
    expect(response.status).toBe(200);
    expect(logCtx.conversationId).toBe(normalizeLogConversationId(rawSessionId));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("session_id")).toBe(rawSessionId);
    expect(seen[0]!.headers.has("x-hermes-conversation-id")).toBe(false);
  });
  test("empty or whitespace parent-thread header does not suppress valid native session_id over Hermes", async () => {
    const seen = mockNativeWire();
    const rawHermesId = "hermes-fixture-wire";
    const rawSessionId = "valid-native-session-id";
    const logCtx = { model: "", provider: "" } as Parameters<typeof handleChatCompletions>[2];
    const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-chat-caller", exp: Math.floor(Date.now() / 1000) + 86400 });
    const config = { defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    } } as OcxConfig;
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
        "chatgpt-account-id": "fixture-chat-caller",
        "x-codex-parent-thread-id": "   ",
        "session_id": rawSessionId,
        "x-hermes-conversation-id": rawHermesId },
      body: JSON.stringify({ model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "ping" }], stream: false }),
    });
    const response = await handleChatCompletions(req, config, logCtx);
    await response.text();
    expect(response.status).toBe(200);
    expect(logCtx.conversationId).toBe(normalizeLogConversationId(rawSessionId));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("session_id")).toBe(rawSessionId);
    expect(seen[0]!.headers.has("x-hermes-conversation-id")).toBe(false);
  });

  test("hyphenated session-id header strictly wins over x-hermes-conversation-id across the Chat bridge", async () => {
    const seen = mockNativeWire();
    const rawHermesId = "hermes-fixture-wire";
    const rawSessionId = "native-hyphenated-session-789";
    const logCtx = { model: "", provider: "" } as Parameters<typeof handleChatCompletions>[2];
    const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-chat-caller", exp: Math.floor(Date.now() / 1000) + 86400 });
    const config = { defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    } } as OcxConfig;
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
        "chatgpt-account-id": "fixture-chat-caller",
        "session-id": rawSessionId,
        "x-hermes-conversation-id": rawHermesId },
      body: JSON.stringify({ model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "ping" }], stream: false }),
    });
    const response = await handleChatCompletions(req, config, logCtx);
    await response.text();
    expect(response.status).toBe(200);
    expect(logCtx.conversationId).toBe(normalizeLogConversationId(rawSessionId));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("session_id")).toBe(rawSessionId);
    expect(seen[0]!.headers.has("x-hermes-conversation-id")).toBe(false);
  });

  test("preserves native precedence of session_id over thread-id across the Chat bridge", async () => {
    const seen = mockNativeWire();
    const rawHermesId = "hermes-fixture-wire";
    const rawSessionId = "native-session-preferred";
    const rawThreadId = "native-thread-secondary";
    const logCtx = { model: "", provider: "" } as Parameters<typeof handleChatCompletions>[2];
    const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-chat-caller", exp: Math.floor(Date.now() / 1000) + 86400 });
    const config = { defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    } } as OcxConfig;
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
        "chatgpt-account-id": "fixture-chat-caller",
        "session_id": rawSessionId,
        "thread-id": rawThreadId,
        "x-hermes-conversation-id": rawHermesId },
      body: JSON.stringify({ model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "ping" }], stream: false }),
    });
    const response = await handleChatCompletions(req, config, logCtx);
    await response.text();
    expect(response.status).toBe(200);
    expect(logCtx.conversationId).toBe(normalizeLogConversationId(rawSessionId));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("session_id")).toBe(rawSessionId);
    expect(seen[0]!.headers.has("x-hermes-conversation-id")).toBe(false);
  });

  test("empty session_id spelling does not mask valid hyphenated session-id over Hermes across Chat bridge", async () => {
    const seen = mockNativeWire();
    const rawHermesId = "hermes-fixture-wire";
    const rawSessionId = "native-valid-hyphen-session";
    const logCtx = { model: "", provider: "" } as Parameters<typeof handleChatCompletions>[2];
    const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-chat-caller", exp: Math.floor(Date.now() / 1000) + 86400 });
    const config = { defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    } } as OcxConfig;
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
        "chatgpt-account-id": "fixture-chat-caller",
        "session_id": "",
        "session-id": rawSessionId,
        "x-hermes-conversation-id": rawHermesId },
      body: JSON.stringify({ model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "ping" }], stream: false }),
    });
    const response = await handleChatCompletions(req, config, logCtx);
    await response.text();
    expect(response.status).toBe(200);
    expect(logCtx.conversationId).toBe(normalizeLogConversationId(rawSessionId));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("session_id")).toBe(rawSessionId);
    expect(seen[0]!.headers.has("x-hermes-conversation-id")).toBe(false);
  });
});

describe("Responses preparation keeps the Hermes log id a fallback", () => {
  const hermesLogId = normalizeLogConversationId("hermes-fixture-wire")!;
  async function responses(headers: Record<string, string>, logCtx: Parameters<typeof handleResponses>[2],
    options: Parameters<typeof handleResponses>[3] = {}) {
    const token = fakeChatGptJwt({ chatgpt_account_id: "fixture-chat-caller", exp: Math.floor(Date.now() / 1000) + 86400 });
    const config = { defaultProvider: "openai", openaiProviderTierVersion: 2, providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    } } as OcxConfig;
    const req = new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
        "chatgpt-account-id": "fixture-chat-caller", ...headers },
      body: JSON.stringify({ model: "openai/gpt-5.6-luna", input: "ping", stream: false }),
    });
    const response = await handleResponses(req, config, logCtx, options);
    await response.text();
    expect(response.status).toBe(200);
  }

  test("a native identity resolved in preparation replaces the Hermes fallback", async () => {
    const seen = mockNativeWire();
    const logCtx = { model: "", provider: "", conversationId: hermesLogId,
      conversationIdIsHermesFallback: true } as Parameters<typeof handleResponses>[2];
    await responses({ session_id: "native-bridge-session" }, logCtx);
    expect(seen).toHaveLength(1);
    expect(logCtx.conversationId).toBe(normalizeLogConversationId("native-bridge-session"));
    expect(logCtx.conversationIdIsHermesFallback).toBeUndefined();
  });

  test("the Hermes fallback survives when preparation resolves no native identity", async () => {
    const seen = mockNativeWire();
    const logCtx = { model: "", provider: "", conversationId: hermesLogId,
      conversationIdIsHermesFallback: true } as Parameters<typeof handleResponses>[2];
    await responses({}, logCtx);
    expect(seen).toHaveLength(1);
    expect(logCtx.conversationId).toBe(hermesLogId);
  });

  test("a caller-owned pre-populated id (routed Claude) is kept over native headers", async () => {
    const seen = mockNativeWire();
    const callerOwned = normalizeLogConversationId("routed-claude-metadata")!;
    const logCtx = { model: "", provider: "", conversationId: callerOwned } as Parameters<typeof handleResponses>[2];
    await responses({ session_id: "native-bridge-session" }, logCtx);
    expect(seen).toHaveLength(1);
    expect(logCtx.conversationId).toBe(callerOwned);
  });

  test("direct Responses correlates Hermes only without native identity and never forwards it", async () => {
    const seen = mockNativeWire();
    const bare = { model: "", provider: "" } as Parameters<typeof handleResponses>[2];
    await responses({ "x-hermes-conversation-id": "hermes-fixture-wire" }, bare);
    const native = { model: "", provider: "" } as Parameters<typeof handleResponses>[2];
    await responses({ "x-hermes-conversation-id": "hermes-fixture-wire", "thread-id": "native-thread" }, native);
    expect(seen).toHaveLength(2);
    expect(bare.conversationId).toBe(hermesLogId);
    expect(native.conversationId).toBe(normalizeLogConversationId("native-thread"));
    for (const wire of seen) expect(wire.headers.has("x-hermes-conversation-id")).toBe(false);
  });
});
