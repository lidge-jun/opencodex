import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, createHash, createPublicKey, publicEncrypt } from "node:crypto";
import { createZedAdapter, zedEventStream, type ZedProvider } from "../../src/adapters/zed";
import { translateZedOpenAiStream } from "../../src/adapters/zed-openai-stream";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { releaseCompactionCiphertextLease } from "../../src/responses/compaction";
import { setIcaclsRunnerForTests, resetHardenedStateForTests } from "../../src/lib/windows-secret-acl";
import { getValidAccessTokenSnapshot } from "../../src/oauth";
import { saveCredential } from "../../src/oauth/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import {
  buildZedUserAuthHeader,
  clearZedCaches,
  createZedNativeAuthData,
  decryptZedAccessToken,
  normalizeZedProvider,
  parseZedCallbackPayload,
  resolveZedOrganizationId,
  scrubZedCredentials,
  zedLlmFetch,
} from "../../src/providers/zed";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig } from "../../src/types";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } from "../../src/lib/spend-reservation-ledger";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearZedCaches();
});

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("Zed Hosted AI provider", () => {
  test("builds and decrypts the native RSA callback credential", () => {
    const auth = createZedNativeAuthData(43_123, "system-test");
    const publicKey = createPublicKey({
      key: Buffer.from(auth.publicKey, "base64url"),
      format: "der",
      type: "pkcs1",
    });
    const encrypted = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from("zed-access-token", "utf8"),
    ).toString("base64url");

    expect(parseZedCallbackPayload(`http://127.0.0.1/?user_id=user-1&access_token=${encrypted}`)).toEqual({
      userId: "user-1",
      encryptedAccessToken: encrypted,
    });
    expect(decryptZedAccessToken(encrypted, auth.privateKeyVerifier)).toBe("zed-access-token");
    expect(buildZedUserAuthHeader({ userId: "user-1", accessToken: "zed-access-token" }))
      .toBe("user-1 zed-access-token");
    expect(resolveZedOrganizationId({ organizations: [{ id: "personal", is_personal: true }] }))
      .toBe("personal");
  });

  test("normalizes Zed provider families without restricting arbitrary model ids", () => {
    expect(normalizeZedProvider("Anthropic", "any-model-id")).toBe("anthropic");
    expect(normalizeZedProvider(undefined, "claude-custom")).toBe("anthropic");
    expect(normalizeZedProvider("gemini", "any-model-id")).toBe("google");
    expect(normalizeZedProvider("x-ai", "any-model-id")).toBe("x_ai");
    expect(normalizeZedProvider(undefined, "vendor-router-model")).toBe("open_ai");
  });

  test("keeps the account token and user id out of upstream error messages", async () => {
    globalThis.fetch = (async () => jsonResponse(
      { message: "invalid credential user-secret-42 zed-account-token-xyz" },
      401,
    )) as typeof globalThis.fetch;

    let message = "";
    try {
      await zedLlmFetch({ userId: "user-secret-42", accessToken: "zed-account-token-xyz" }, "/completions");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Zed account lookup");
    expect(message).not.toContain("user-secret-42");
    expect(message).not.toContain("zed-account-token-xyz");
  });
  describe("credential-bearing rejections", () => {
    const credentials = { userId: "user-secret-42", accessToken: "zed-account-token-xyz" };
    const leaked = "connect failed for user-secret-42 with zed-account-token-xyz";

    async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
      try {
        await promise;
      } catch (error) {
        return error;
      }
      throw new Error("expected the Zed call to reject");
    }

    function expectScrubbed(error: unknown): void {
      const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
      expect(text).not.toContain("user-secret-42");
      expect(text).not.toContain("zed-account-token-xyz");
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }

    test("scrubs a fetch rejection that echoes the account credential", async () => {
      globalThis.fetch = (async () => { throw new Error(leaked); }) as unknown as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expect(error).toBeInstanceOf(Error);
      expectScrubbed(error);
    });

    test("scrubs a body-read rejection that echoes the account credential", async () => {
      globalThis.fetch = (async () => new Response(new ReadableStream({
        pull(controller) { controller.error(new Error(leaked)); },
      }), { status: 200 })) as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expectScrubbed(error);
    });

    test("keeps a numeric status on the scrubbed replacement", async () => {
      globalThis.fetch = (async () => { throw Object.assign(new Error(leaked), { status: 503 }); }) as unknown as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expectScrubbed(error);
      expect((error as { status?: unknown }).status).toBe(503);
    });

    test("keeps a credential-bearing abort an AbortError without the credential", async () => {
      globalThis.fetch = (async () => { throw new DOMException(leaked, "AbortError"); }) as unknown as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
      expectScrubbed(error);
    });

    test("rethrows a clean abort by identity", async () => {
      const abort = new DOMException("The operation was aborted.", "AbortError");
      globalThis.fetch = (async () => { throw abort; }) as unknown as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expect(error).toBe(abort);
    });
  });

  test("refreshes the short-lived LLM token on Zed expiry signals", async () => {
    const calls: Array<{ request: Request; body: string }> = [];
    const responses = [
      jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }),
      new Response(JSON.stringify({ error: "expired" }), {
        status: 401,
        headers: { "x-zed-expired-token": "true" },
      }),
      jsonResponse({ token: "llm-token-2" }),
      new Response("ok", { status: 200 }),
    ];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      calls.push({ request, body: await request.clone().text() });
      const response = responses.shift();
      if (!response) throw new Error("unexpected Zed fetch");
      return response;
    }) as typeof globalThis.fetch;

    const response = await zedLlmFetch(
      { userId: "user-1", accessToken: "access-token" },
      "/completions",
      { fetchInit: { method: "POST", body: "{}" } },
    );

    expect(await response.text()).toBe("ok");
    expect(calls.map(call => new URL(call.request.url).pathname)).toEqual([
      "/client/users/me",
      "/client/llm_tokens",
      "/completions",
      "/client/llm_tokens",
      "/completions",
    ]);
    expect(calls[0]?.request.headers.get("authorization")).toBe("user-1 access-token");
    expect(calls[2]?.request.headers.get("authorization")).toBe("Bearer llm-token-1");
    expect(calls[4]?.request.headers.get("authorization")).toBe("Bearer llm-token-2");
  });

  test("wraps the existing provider builders in Zed's completions envelope", async () => {
    const responses = [
      jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }),
      jsonResponse({ models: [{ id: "gpt-5.6", provider: "open_ai", supports_tools: true }] }),
    ];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected Zed catalog fetch");
      return response;
    }) as typeof globalThis.fetch;

    const provider: OcxProviderConfig = {
      adapter: "zed",
      baseUrl: "https://cloud.zed.dev",
      authMode: "oauth",
      apiKey: "access-token",
    };
    const parsed = parseRequest({ model: "gpt-5.6", input: "hello", stream: true });
    parsed._zedAuthContext = { userId: "user-1" };
    const adapter = withTestTranslatorBudget(createZedAdapter(provider));
    const request = await adapter.buildRequest(parsed);
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(request.url).toBe("https://cloud.zed.dev/completions");
    expect(body).toMatchObject({
      provider: "open_ai",
      model: "gpt-5.6",
      thread_id: expect.any(String),
      prompt_id: expect.any(String),
    });
    expect(body.provider_request).toMatchObject({ model: "gpt-5.6", stream: true });

    let completionRequest: Request | undefined;
    const response = await adapter.fetchResponse!(request, {
      executor: (async (input, init) => {
        completionRequest = new Request(input, init);
        return new Response([
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}`,
          "data: [DONE]",
          "",
        ].join("\n"), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof globalThis.fetch,
    });
    expect(response.ok).toBe(true);
    expect(completionRequest?.url).toBe("https://cloud.zed.dev/completions");
    expect(completionRequest?.headers.get("authorization")).toBe("Bearer llm-token-1");
    expect(await completionRequest?.clone().text()).toBe(request.body);
  });

  test("normalizes Anthropic string message content to sequence blocks for Zed backend", async () => {
    const responses = [
      jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }),
      jsonResponse({ models: [{ id: "claude-haiku-4-5", provider: "anthropic" }] }),
    ];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected Zed catalog fetch");
      return response;
    }) as typeof globalThis.fetch;

    const provider: OcxProviderConfig = {
      adapter: "zed",
      baseUrl: "https://cloud.zed.dev",
      authMode: "oauth",
      apiKey: "access-token",
    };
    const parsed = parseRequest({ model: "claude-haiku-4-5", input: "hello zed", stream: true });
    parsed._zedAuthContext = { userId: "user-1" };
    const adapter = withTestTranslatorBudget(createZedAdapter(provider));
    const request = await adapter.buildRequest(parsed);
    const body = JSON.parse(request.body) as { provider: string; provider_request: { messages: Array<{ role: string; content: unknown }> } };

    expect(body.provider).toBe("anthropic");
    expect(body.provider_request.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello zed" }],
    });
    // Zed's gateway does not document the 1h TTL: the borrowed api.anthropic.com builder
    // must not apply the first-party 1h default to it.
    expect(request.body).toContain("cache_control");
    expect(request.body).not.toContain("\"ttl\"");
  });
  test("normalizes OpenAI input and removes Codex-only fields for Zed backend", async () => {
    const responses = [
      jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }),
      jsonResponse({ models: [{ id: "gpt-6.1-sol", provider: "open_ai" }] }),
    ];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected Zed catalog fetch");
      return response;
    }) as typeof globalThis.fetch;

    const provider: OcxProviderConfig = {
      adapter: "zed",
      baseUrl: "https://cloud.zed.dev",
      authMode: "oauth",
      apiKey: "access-token",
    };
    const parsed = parseRequest({
      model: "gpt-6.1-sol",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Follow the user request." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello zed openai" }] },
      ],
      stream: true,
      access_programs: { cyber: ["standard"] },
      tools: [
        { type: "web_search", search_context_size: "medium" },
        { type: "function", name: "synthetic_tool", parameters: { type: "object", properties: {} } },
      ],
    });
    parsed._zedAuthContext = { userId: "user-1" };
    const adapter = withTestTranslatorBudget(createZedAdapter(provider));
    const request = await adapter.buildRequest(parsed);
    const body = JSON.parse(request.body) as {
      provider: string;
      provider_request: {
        input: Array<{ type: string; role: string; content: unknown }>;
        tools: Array<{ type: string }>;
      };
    };

    expect(body.provider).toBe("open_ai");
    expect(body.provider_request.input[0]).toEqual({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "Follow the user request." }],
    });
    expect(body.provider_request.input[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello zed openai" }],
    });
    expect(body.provider_request).not.toHaveProperty("access_programs");
    expect(body.provider_request.tools).toEqual([{ type: "function", name: "synthetic_tool", parameters: { type: "object", properties: {} } }]);
  });
});

describe("Zed OpenAI tool selection after filtering", () => {
  const custom = { type: "custom", name: "apply_patch", format: { type: "text" } };
  const web = { type: "web_search" };
  for (const [name, tools, choice, expectedTools, expectedChoice] of [
    ["custom is preserved", [custom, web], "required", [custom], "required"],
    ["all removed with auto", [web], "auto", [], "auto"],
    ["all removed with required", [web], "required", [], "none"],
    ["removed named built-in", [web], { type: "web_search" }, [], "none"],
    ["mixed allowed tools", [custom, web], { type: "allowed_tools", mode: "auto", tools: [web, { type: "custom", name: "apply_patch" }] },
      [custom], { type: "allowed_tools", mode: "auto", tools: [{ type: "custom", name: "apply_patch" }] }],
    ["all allowed tools removed", [web], { type: "allowed_tools", mode: "auto", tools: [web] }, [], "none"],
  ] as const) test(name, async () => {
    const catalog = [jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }), jsonResponse({ models: [{ id: "gpt-6.1-sol", provider: "open_ai" }] })];
    globalThis.fetch = (async () => {
      const next = catalog.shift();
      if (!next) throw new Error("unexpected Zed catalog fetch");
      return next;
    }) as typeof fetch;
    const parsed = parseRequest({ model: "gpt-6.1-sol", input: "hello", tools, tool_choice: choice });
    parsed._zedAuthContext = { userId: "user-1" };
    const adapter = withTestTranslatorBudget(createZedAdapter({ adapter: "zed", baseUrl: "https://cloud.zed.dev",
      authMode: "oauth", apiKey: "access-token" }));
    const request = await adapter.buildRequest(parsed);
    const body = JSON.parse(request.body).provider_request;
    expect(body.input[0]).toMatchObject({ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] });
    expect(body.tools).toEqual(expectedTools);
    expect(body.tool_choice).toEqual(expectedChoice);
  });
});

describe("Zed OpenAI tool relay", () => {
  const provider: OcxProviderConfig = {
    adapter: "zed",
    baseUrl: "https://cloud.zed.dev",
    authMode: "oauth",
    apiKey: "access-token",
  };

  function catalogFetch(): void {
    const responses = [
      jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }),
      jsonResponse({ models: [{ id: "gpt-6.1-sol", provider: "open_ai" }] }),
    ];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected Zed catalog fetch");
      return response;
    }) as typeof globalThis.fetch;
  }

  test("promotes the current turn's additional_tools and drops replayed wrappers", async () => {
    catalogFetch();
    const already = { type: "function", name: "already", parameters: { type: "object", properties: {} } };
    const parsed = parseRequest({
      model: "gpt-6.1-sol",
      input: [
        { type: "additional_tools", tools: [{ type: "function", name: "old_tool", parameters: { type: "object", properties: {} } }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
        { type: "additional_tools", tools: [
          { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
          { type: "web_search" },
          already,
        ] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "now" }] },
      ],
      tools: [already],
      stream: true,
    });
    parsed._zedAuthContext = { userId: "user-1" };
    parsed._replayPrefixLen = 2;
    const adapter = withTestTranslatorBudget(createZedAdapter(provider));
    const request = await adapter.buildRequest(parsed);
    const body = JSON.parse(request.body).provider_request;
    expect(body.input.map((item: { type: string }) => item.type)).toEqual(["message", "message"]);
    expect(JSON.stringify(body.input)).not.toContain("old_tool");
    expect(JSON.stringify(body.input)).not.toContain("additional_tools");
    expect(body.tools).toEqual([
      already,
      { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
    ]);
  });

  test("promotes the current turn when replay repair drops a reasoning item", async () => {
    catalogFetch();
    const shell = { type: "function", name: "shell", parameters: { type: "object", properties: {} } };
    const parsed = parseRequest({
      model: "gpt-6.1-sol",
      previous_response_id: "resp_replay",
      input: [
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
        { type: "additional_tools", tools: [shell] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "now" }] },
      ],
      stream: true,
    });
    parsed._zedAuthContext = { userId: "user-1" };
    parsed._replayPrefixLen = 2;
    const rawBefore = JSON.stringify(parsed._rawBody);
    const adapter = withTestTranslatorBudget(createZedAdapter({ ...provider, statelessResponses: true }));
    const request = await adapter.buildRequest(parsed);
    const body = JSON.parse(request.body).provider_request;
    expect(body.tools).toEqual([shell]);
    expect(JSON.stringify(body.input)).not.toContain("additional_tools");
    expect(JSON.stringify(body.input)).not.toContain("reasoning");
    expect(JSON.stringify(parsed._rawBody)).toBe(rawBefore);
    expect(rawBefore).toContain("additional_tools");
    expect(rawBefore).toContain("reasoning");
  });

  async function relay(frames: unknown[]): Promise<unknown[]> {
    catalogFetch();
    const parsed = parseRequest({ model: "gpt-6.1-sol", input: "hello", stream: true });
    parsed._zedAuthContext = { userId: "user-1" };
    const adapter = withTestTranslatorBudget(createZedAdapter(provider));
    await adapter.buildRequest(parsed);
    const ndjson = frames.map(frame => JSON.stringify(frame)).join("\n") + "\n";
    const events = [];
    for await (const event of adapter.parseStream(new Response(ndjson))) events.push(event);
    return events;
  }

  test("relays commentary text, function-call deltas, and usage across the synthetic completion", async () => {
    const events = await relay([
      { event: { type: "response.output_item.added", item: { id: "msg_1", type: "message", role: "assistant", phase: "commentary", content: [] } } },
      { event: { type: "response.output_text.delta", item_id: "msg_1", delta: "Looking." } },
      { event: { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "shell", arguments: "" } } },
      { event: { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"cmd\":" } },
      { event: { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "\"ls\"}" } },
      { event: { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{\"cmd\":\"ls\"}" } },
      { event: { type: "response.completed", response: {
        output: [
          { type: "message", id: "msg_1", phase: "commentary", content: [{ type: "output_text", text: "Looking." }] },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
        ],
        usage: { input_tokens: 11, output_tokens: 6 },
      } } },
      { status: "stream_ended" },
    ]);
    expect(events).toEqual([
      { type: "text_delta", text: "Looking.", phase: "commentary" },
      { type: "tool_call_start", id: "call_1", name: "shell" },
      { type: "tool_call_delta", arguments: "{\"cmd\":" },
      { type: "tool_call_delta", arguments: "\"ls\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 11, outputTokens: 6 } },
    ]);
  });

  test("relays a custom tool that arrives only in the completed output without repeating text", async () => {
    const events = await relay([
      { event: { type: "response.output_text.delta", delta: "hi" } },
      { event: { type: "response.completed", response: {
        output: [
          { type: "message", id: "msg_1", phase: "commentary", content: [{ type: "output_text", text: "hi" }] },
          { type: "custom_tool_call", id: "ctc_1", call_id: "call_c", name: "apply_patch", input: "patch body" },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      } } },
      { status: "stream_ended" },
    ]);
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "tool_call_start", id: "call_c", name: "apply_patch" },
      { type: "tool_call_delta", arguments: "patch body" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
  });

  test("does not repeat an earlier message when completed replays every output item", async () => {
    const events = await relay([
      { event: { type: "response.output_text.delta", item_id: "msg_1", delta: "A" } },
      { event: { type: "response.output_text.delta", item_id: "msg_2", delta: "B" } },
      { event: { type: "response.completed", response: {
        output: [
          { type: "message", id: "msg_1", content: [{ type: "output_text", text: "A" }] },
          { type: "message", id: "msg_2", content: [{ type: "output_text", text: "B" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      } } },
      { status: "stream_ended" },
    ]);
    expect(events).toEqual([
      { type: "text_delta", text: "A" },
      { type: "text_delta", text: "B" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
  });

  test("still emits each completed message when nothing was streamed", async () => {
    const events = await relay([
      { event: { type: "response.completed", response: {
        output: [
          { type: "message", id: "msg_1", content: [{ type: "output_text", text: "A" }] },
          { type: "message", id: "msg_2", content: [{ type: "output_text", text: "B" }] },
        ],
      } } },
      { status: "stream_ended" },
    ]);
    expect(events).toEqual([
      { type: "text_delta", text: "A" },
      { type: "text_delta", text: "B" },
      { type: "done" },
    ]);
  });

  test("keeps usage on an incomplete Zed OpenAI response", async () => {
    const events = await relay([
      { event: { type: "response.output_text.delta", item_id: "msg_1", delta: "partial" } },
      { event: { type: "response.incomplete", response: {
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 4, output_tokens: 9 },
      } } },
      { status: "stream_ended" },
    ]);
    expect(events).toEqual([
      { type: "text_delta", text: "partial" },
      { type: "incomplete", reason: "max_output_tokens", usage: { inputTokens: 4, outputTokens: 9 } },
    ]);
  });

  test("keeps interleaved function-call deltas until each call closes", async () => {
    const events = await relay([
      { event: { type: "response.output_item.added", item: { id: "call_a", type: "function_call", call_id: "call_a", name: "a", arguments: "" } } },
      { event: { type: "response.function_call_arguments.delta", item_id: "call_a", delta: "{\"x\":" } },
      { event: { type: "response.output_item.added", item: { id: "call_b", type: "function_call", call_id: "call_b", name: "b", arguments: "" } } },
      { event: { type: "response.function_call_arguments.delta", item_id: "call_b", delta: "{\"y\":2}" } },
      { event: { type: "response.function_call_arguments.done", item_id: "call_b", arguments: "{\"y\":2}" } },
      { event: { type: "response.function_call_arguments.delta", item_id: "call_a", delta: "1}" } },
      { event: { type: "response.function_call_arguments.done", item_id: "call_a", arguments: "{\"x\":1}" } },
      { event: { type: "response.completed", response: { output: [
        { type: "function_call", id: "call_a", call_id: "call_a", name: "a", arguments: "{\"x\":1}" },
        { type: "function_call", id: "call_b", call_id: "call_b", name: "b", arguments: "{\"y\":2}" },
      ] } } },
    ]);
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_a", name: "a" },
      { type: "tool_call_delta", arguments: "{\"x\":" },
      { type: "heartbeat" },
      { type: "tool_call_delta", arguments: "1}" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "call_b", name: "b" },
      { type: "tool_call_delta", arguments: "{\"y\":2}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]);
  });

  test("keeps interleaved custom-tool input until each call closes", async () => {
    const events = await relay([
      { event: { type: "response.output_item.added", item: { id: "ctc_a", type: "custom_tool_call", call_id: "call_a", name: "apply_patch", input: "" } } },
      { event: { type: "response.custom_tool_call_input.delta", item_id: "ctc_a", delta: "left" } },
      { event: { type: "response.output_item.added", item: { id: "ctc_b", type: "custom_tool_call", call_id: "call_b", name: "apply_patch", input: "" } } },
      { event: { type: "response.custom_tool_call_input.delta", item_id: "ctc_b", delta: "right" } },
      { event: { type: "response.custom_tool_call_input.done", item_id: "ctc_b", input: "right" } },
      { event: { type: "response.custom_tool_call_input.delta", item_id: "ctc_a", delta: " side" } },
      { event: { type: "response.custom_tool_call_input.done", item_id: "ctc_a", input: "left side" } },
      { event: { type: "response.completed", response: { output: [] } } },
    ]);
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_a", name: "apply_patch" },
      { type: "tool_call_delta", arguments: "left" },
      { type: "heartbeat" },
      { type: "tool_call_delta", arguments: " side" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "call_b", name: "apply_patch" },
      { type: "tool_call_delta", arguments: "right" },
      { type: "tool_call_end" },
      { type: "done" },
    ]);
  });

  test("an incomplete response does not invent tool arguments from a later full item", async () => {
    const events = await relay([
      { event: { type: "response.output_item.added", item: { id: "call_a", type: "function_call", call_id: "call_a", name: "a", arguments: "{\"x\":1}" } } },
      { event: { type: "response.function_call_arguments.delta", item_id: "call_a", delta: "{\"x\":" } },
      { event: { type: "response.output_item.added", item: { id: "call_b", type: "function_call", call_id: "call_b", name: "b", arguments: "" } } },
      { event: { type: "response.function_call_arguments.delta", item_id: "call_b", delta: "{\"y\":" } },
      { event: { type: "response.function_call_arguments.done", item_id: "call_b", arguments: "{\"y\":2}" } },
      { event: { type: "response.incomplete", response: {
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          { type: "function_call", id: "call_a", call_id: "call_a", name: "a", arguments: "{\"x\":1}" },
          { type: "function_call", id: "call_b", call_id: "call_b", name: "b", arguments: "{\"y\":2}" },
        ],
      } } },
    ]);
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_a", name: "a" },
      { type: "tool_call_delta", arguments: "{\"x\":" },
      { type: "heartbeat" },
      { type: "tool_call_end", incomplete: true },
      { type: "tool_call_start", id: "call_b", name: "b" },
      { type: "tool_call_delta", arguments: "{\"y\":2}" },
      { type: "tool_call_end", incomplete: true },
      { type: "incomplete", reason: "max_output_tokens" },
    ]);
  });

  test("EOF flushes received arguments and ignores a full arguments field that never completed", async () => {
    const budget = createTranslatorBudget();
    const frames = [
      { type: "response.output_item.added", item: { id: "fc_a", type: "function_call", call_id: "call_a", name: "a", arguments: "{\"x\":1}" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "{\"x\":" },
    ];
    const sse = frames.map(event => "data: " + JSON.stringify(event) + "\n\n").join("");
    const events = [];
    try {
      for await (const event of translateZedOpenAiStream(new Response(sse).body, budget)) events.push(event);
    } finally {
      budget.dispose();
    }
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_a", name: "a" },
      { type: "tool_call_delta", arguments: "{\"x\":" },
      { type: "tool_call_end", incomplete: true },
      { type: "incomplete", reason: "adapter_eof" },
    ]);
  });

  function sse(frames: unknown[]): string {
    return frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join("");
  }

  const compactionFrame = { type: "response.completed", response: {
    output: [{ type: "compaction", encrypted_content: "fixture-ciphertext" }],
  } };

  test("carries a completed compaction ciphertext on done and transfers its lease", async () => {
    const budget = createTranslatorBudget();
    const events: { type: string; compactionEncryptedContent?: string }[] = [];
    try {
      for await (const event of translateZedOpenAiStream(new Response(sse([compactionFrame])).body, budget)) {
        events.push(event as { type: string; compactionEncryptedContent?: string });
      }
      const done = events.at(-1)!;
      expect(done.type).toBe("done");
      expect(done.compactionEncryptedContent).toBe("fixture-ciphertext");
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength("fixture-ciphertext"));
      releaseCompactionCiphertextLease(done, budget);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("a failure after retention releases the ciphertext without a done owner", async () => {
    const budget = createTranslatorBudget();
    try {
      const events = [];
      for await (const event of translateZedOpenAiStream(
        new Response(sse([compactionFrame, { type: "response.failed", response: { error: { message: "boom" } } }])).body,
        budget,
      )) events.push(event);
      expect(events).toEqual([{ type: "error", message: "boom" }]);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("an incomplete response after retention releases the ciphertext", async () => {
    const budget = createTranslatorBudget();
    try {
      const events = [];
      for await (const event of translateZedOpenAiStream(
        new Response(sse([compactionFrame, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }])).body,
        budget,
      )) events.push(event);
      expect(events).toEqual([{ type: "incomplete", reason: "max_output_tokens" }]);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("a consumer that stops before done releases the retained ciphertext", async () => {
    const budget = createTranslatorBudget();
    try {
      const iterator = translateZedOpenAiStream(
        new Response(sse([compactionFrame, { type: "response.output_text.delta", delta: "x" }])).body,
        budget,
      );
      expect(await iterator.next()).toEqual({ done: false, value: { type: "text_delta", text: "x" } });
      // The decoder also holds the chunk it is suspended in, so only the lower bound is stable.
      expect(budget.snapshot().currentBytes).toBeGreaterThanOrEqual(Buffer.byteLength("fixture-ciphertext"));
      await iterator.return(undefined);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("charged stream buffers are released when the turn ends", async () => {
    const budget = createTranslatorBudget();
    try {
      const events = [];
      for await (const event of translateZedOpenAiStream(new Response(sse([
        { type: "response.output_text.delta", item_id: "msg_1", delta: "hello" },
        { type: "response.output_item.added", item: { id: "fc_a", type: "function_call", call_id: "call_a", name: "a", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "{\"x\":1}" },
        { type: "response.function_call_arguments.done", item_id: "fc_a", arguments: "{\"x\":1}" },
        { type: "response.completed", response: { output: [] } },
      ])).body, budget)) events.push(event);
      expect(events).toHaveLength(5);
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(budget.snapshot().activeCalls).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("accumulated streamed text counts against the turn ceiling", async () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 600 });
    const frames = Array.from({ length: 14 }, () => ({ type: "response.output_text.delta", item_id: "msg_1", delta: "x".repeat(50) }));
    const encoder = new TextEncoder();
    let index = 0;
    // One frame per chunk keeps each transient chunk charge small, so only the accumulated
    // text can exceed the ceiling.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= frames.length) { controller.close(); return; }
        controller.enqueue(encoder.encode("data: " + JSON.stringify(frames[index++]) + "\n\n"));
      },
    });
    try {
      const iterator = translateZedOpenAiStream(body, budget);
      const seen = [];
      await expect((async () => {
        for await (const event of iterator) seen.push(event);
      })()).rejects.toMatchObject({ code: "translation_buffer_limit" });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.length).toBeLessThan(frames.length);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("a completed item replay does not re-charge a closed call's arguments", async () => {
    const budget = createTranslatorBudget();
    try {
      const events = [];
      for await (const event of translateZedOpenAiStream(new Response(sse([
        { type: "response.output_item.added", item: { id: "fc_a", type: "function_call", call_id: "call_a", name: "a", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "{\"x\":1}" },
        { type: "response.function_call_arguments.done", item_id: "fc_a", arguments: "{\"x\":1}" },
        { type: "response.completed", response: { output: [
          { type: "function_call", id: "fc_a", call_id: "call_a", name: "a", arguments: "{\"x\":1}" },
        ] } },
      ])).body, budget)) events.push(event);
      expect(events).toEqual([
        { type: "tool_call_start", id: "call_a", name: "a" },
        { type: "tool_call_delta", arguments: "{\"x\":1}" },
        { type: "tool_call_end" },
        { type: "done" },
      ]);
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
    } finally {
      budget.dispose();
    }
  });

  test("a consumer that stops while calls are open releases their buffered arguments", async () => {
    const budget = createTranslatorBudget();
    try {
      const iterator = translateZedOpenAiStream(new Response(sse([
        { type: "response.output_item.added", item: { id: "fc_a", type: "function_call", call_id: "call_a", name: "a", arguments: "" } },
        { type: "response.output_item.added", item: { id: "fc_b", type: "function_call", call_id: "call_b", name: "b", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_b", delta: "{\"y\":2}" },
        { type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "{\"x\":1}" },
        { type: "response.function_call_arguments.done", item_id: "fc_a", arguments: "{\"x\":1}" },
      ])).body, budget);
      let step = await iterator.next();
      while (!step.done && step.value.type !== "tool_call_delta") step = await iterator.next();
      expect(step.done).toBe(false);
      // Both calls are still open: a is mid-stream and b's arguments are buffered behind it.
      expect(budget.snapshot().activeCalls).toBeGreaterThan(0);
      await iterator.return(undefined);
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
    } finally {
      budget.dispose();
    }
  });
});

describe("Zed inference send accounting", () => {
  async function fixture(limit: number, full = false) {
    const catalog = [jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }), jsonResponse({ models: [{ id: "gpt-5.6", provider: "open_ai" }] })];
    globalThis.fetch = (async () => {
      const response = catalog.shift();
      if (!response) throw new Error("unexpected Zed catalog fetch");
      return response;
    }) as typeof globalThis.fetch;
    const adapter = withTestTranslatorBudget(createZedAdapter({ adapter: "zed", authMode: "oauth",
      baseUrl: "https://zed-proxy.example.test/v1/", apiKey: "access-token" }));
    const parsed = parseRequest({ model: "gpt-5.6", input: "hello", stream: true });
    parsed._zedAuthContext = { userId: "user-1" };
    const request = await adapter.buildRequest(parsed);
    const salt = "5".repeat(64);
    const poolAlias = createHash("sha256").update(`${salt}\0pool\0zed-canonical`).digest("hex").slice(0, 32);
    const ledger = createSpendReservationLedger({ salt, policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 100 }, maxTrackedSends: full ? 1 : 10,
      canonicalProviderIds: ["zed-canonical"], poolAliases: { [poolAlias]: "zed-canonical" },
    } });
    if (full) expect(ledger.reserveSeed({ sendId: "occupied", scopes: { poolId: "zed-canonical" },
      inputTokens: 1, outputCeilingTokens: 0 }).reserved).toBe(true);
    const tracker = createRequestSpendTracker({ provider: "Zed display label", spendPoolId: "zed-canonical",
      spendInputEstimateTokens: 10 }, undefined, ledger);
    const budget = createRequestExecutionBudget({ maxTotalModelSends: limit, baseSendAllowance: limit,
      finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, undefined, tracker);
    return { adapter, request, ledger, tracker, budget };
  }

  test("NORMAL seed refusal makes zero completion executor calls", async () => {
    const { adapter, request, budget } = await fixture(2, true);
    let calls = 0;
    await expect(adapter.fetchResponse!(request, { sendBudget: budget,
      executor: (async () => { calls++; return new Response("unexpected"); }) as typeof globalThis.fetch,
    })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(calls).toBe(0);
    expect(budget.physicalStarted).toBe(0);
  });

  for (const limit of [1, 2]) test(`401 replay respects physical L=${limit} and canonical pool accounting`, async () => {
    const { adapter, request, ledger, tracker, budget } = await fixture(limit);
    const calls: string[] = [];
    const physical: Array<{ ordinal: number; recovery?: string }> = [];
    let completions = 0;
    const result = adapter.fetchResponse!(request, { sendBudget: budget, onPhysicalSend: send => physical.push(send),
      executor: (async (input) => {
        const url = String(input);
        calls.push(url);
        if (new URL(url).pathname === "/client/llm_tokens") return jsonResponse({ token: "llm-token-2" });
        expect(url).toBe("https://zed-proxy.example.test/v1/completions");
        return ++completions === 1 ? new Response("expired", { status: 401 }) : new Response("ok");
      }) as typeof globalThis.fetch,
    });
    if (limit === 1) await expect(result).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    else expect(await (await result).text()).toBe("ok");
    expect(completions).toBe(limit);
    expect(calls.filter(url => new URL(url).pathname === "/client/llm_tokens")).toHaveLength(1);
    expect(physical).toEqual(limit === 1 ? [{ ordinal: 1 }] : [{ ordinal: 1 }, { ordinal: 2, recovery: "oauth-401" }]);
    expect(budget.used).toBe(limit);
    expect(budget.physicalStarted).toBe(limit);
    tracker.requestFinalSettlement(limit === 2 ? { inputTokens: 7, outputTokens: 0 } : undefined);
    expect(ledger.snapshot("pool", "zed-canonical")).toMatchObject({ settled: limit === 2 ? 7 : 0, unresolved: 10 });
    expect(ledger.snapshot("pool", "Zed display label")?.settled ?? 0).toBe(0);
  });
});

describe("Zed stream framing", () => {
  async function translate(chunks: string[], provider: ZedProvider = "anthropic"): Promise<Array<Record<string, unknown>>> {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const text = await new Response(zedEventStream(body, provider)).text();
    return text.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, "")) as Record<string, unknown>);
  }

  test("forwards events and stops at the explicit stream-ended status", async () => {
    const frames = await translate([
      `${JSON.stringify({ event: { type: "content_block_delta", delta: { text: "hi" } } })}\n`,
      `${JSON.stringify({ status: "stream_ended" })}\n${JSON.stringify({ event: { type: "content_block_delta", delta: { text: "late" } } })}\n`,
    ]);
    expect(frames).toEqual([
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_stop" },
    ]);
  });

  test("a malformed frame fails the stream instead of being skipped", async () => {
    const frames = await translate([`${JSON.stringify({ event: { type: "ping" } })}\n{not json\n${JSON.stringify({ status: "stream_ended" })}\n`]);
    expect(frames).toEqual([
      { type: "ping" },
      { type: "error", error: { type: "api_error", message: "Zed stream sent a malformed frame" } },
    ]);
  });

  test("an EOF without a terminal or inside a partial frame is an error, not a success", async () => {
    expect((await translate([`${JSON.stringify({ event: { type: "ping" } })}\n`])).at(-1))
      .toEqual({ type: "error", error: { type: "api_error", message: "Zed stream ended before completion" } });
    expect((await translate([`${JSON.stringify({ event: { type: "ping" } })}\n{"event":{"type":`])).at(-1))
      .toEqual({ type: "error", error: { type: "api_error", message: "Zed stream ended inside a partial frame" } });
  });

  test("a failed status never echoes the account token or user id", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ status: { type: "failed", message: "quota for zed-user-9 with tok-abc exhausted" } })}\n`));
        controller.close();
      },
    });
    const credentials = { userId: "zed-user-9", accessToken: "tok-abc" };
    const text = await new Response(zedEventStream(body, "anthropic", value => scrubZedCredentials(value, credentials))).text();
    expect(text).not.toContain("zed-user-9");
    expect(text).not.toContain("tok-abc");
    expect(text).toContain("[redacted]");
  });

  test("a native terminal event still completes at a clean EOF", async () => {
    const frames = await translate([`${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n`], "open_ai");
    expect(frames.at(-1)).toEqual({ type: "response.completed", response: { output: [] } });
    expect(frames.some(frame => "error" in frame)).toBe(false);
  });

  test("an unterminated frame over the size limit fails instead of growing the buffer", async () => {
    const frames = await translate(["x".repeat(1024 * 1024 + 1)]);
    expect(frames).toEqual([{ type: "error", error: { type: "api_error", message: "Zed stream frame exceeded the size limit" } }]);
  });
});

describe("Zed OAuth identity", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-zed-identity-"));
  let previousHome: string | undefined;
  beforeAll(() => {
    previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  });
  afterAll(() => {
    setIcaclsRunnerForTests(null);
    resetHardenedStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  test("the access snapshot carries Zed's user id apart from the hashed account slot", async () => {
    await saveCredential("zed", {
      access: "zed-access-token",
      refresh: "zed-access-token",
      expires: Number.MAX_SAFE_INTEGER,
      accountId: "zed-user-7",
      source: "oauth",
    });
    const snapshot = await getValidAccessTokenSnapshot("zed");
    expect(snapshot.providerUserId).toBe("zed-user-7");
    expect(snapshot.accountId).not.toBe("zed-user-7");
    expect(buildZedUserAuthHeader({ userId: snapshot.providerUserId!, accessToken: snapshot.accessToken }))
      .toBe("zed-user-7 zed-access-token");
  });
});
