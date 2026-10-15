import { describe, expect, test } from "bun:test";
import { createDshAccountAdapter, resolveDshAccountMessagesUrl, DSH_ACCOUNT_DEFAULT_MESSAGES_URL } from "../../src/adapters/dsh-account";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const dshProviderConfig: OcxProviderConfig = {
  adapter: "dsh-account",
  baseUrl: "https://api.deepseek.com/anthropic",
  authMode: "oauth",
  apiKey: "dsh-auth-token-test-xyz",
};

describe("resolveDshAccountMessagesUrl destination security pinning", () => {
  test("defaults to https://api.deepseek.com/anthropic/v1/messages", () => {
    expect(resolveDshAccountMessagesUrl()).toBe(DSH_ACCOUNT_DEFAULT_MESSAGES_URL);
    expect(resolveDshAccountMessagesUrl("")).toBe(DSH_ACCOUNT_DEFAULT_MESSAGES_URL);
    expect(resolveDshAccountMessagesUrl("   ")).toBe(DSH_ACCOUNT_DEFAULT_MESSAGES_URL);
  });

  test("handles root origin https://api.deepseek.com and normalizes path", () => {
    expect(resolveDshAccountMessagesUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(resolveDshAccountMessagesUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com/anthropic/v1/messages");
  });

  test("normalizes baseUrls ending in /anthropic, /anthropic/v1, /anthropic/v1/messages", () => {
    expect(resolveDshAccountMessagesUrl("https://api.deepseek.com/anthropic")).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(resolveDshAccountMessagesUrl("https://api.deepseek.com/anthropic/")).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(resolveDshAccountMessagesUrl("https://api.deepseek.com/anthropic/v1")).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(resolveDshAccountMessagesUrl("https://api.deepseek.com/anthropic/v1/messages")).toBe("https://api.deepseek.com/anthropic/v1/messages");
  });

  test("fails closed and rejects evil.example", () => {
    expect(() => resolveDshAccountMessagesUrl("https://evil.example/v1/messages")).toThrow(
      'Untrusted dsh-account destination host: "evil.example"',
    );
  });

  test("fails closed and rejects localhost and loopback", () => {
    expect(() => resolveDshAccountMessagesUrl("http://localhost:8080")).toThrow(
      'Untrusted dsh-account destination host: "localhost"',
    );
    expect(() => resolveDshAccountMessagesUrl("https://127.0.0.1:443/anthropic/v1/messages")).toThrow(
      'Untrusted dsh-account destination host: "127.0.0.1"',
    );
  });

  test("fails closed and rejects other arbitrary HTTPS hosts", () => {
    expect(() => resolveDshAccountMessagesUrl("https://api.other-llm.com/anthropic/v1/messages")).toThrow(
      'Untrusted dsh-account destination host: "api.other-llm.com"',
    );
  });

  test("fails closed if unexpected path is specified on api.deepseek.com", () => {
    expect(() => resolveDshAccountMessagesUrl("https://api.deepseek.com/v1/chat/completions")).toThrow(
      'Untrusted dsh-account destination path: "/v1/chat/completions"',
    );
  });
});

describe("dsh-account adapter buildRequest", () => {
  const adapter = createDshAccountAdapter(dshProviderConfig);

  test("builds request targeting /anthropic/v1/messages with x-dsh-auth-token and redirect: manual", async () => {
    const parsed = parseRequest({
      model: "deepseek-flash",
      input: [{ role: "user", content: "Hello from test" }],
    });

    const incoming = {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    };

    const req = await adapter.buildRequest(parsed, incoming);

    expect(req.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(req.method).toBe("POST");
    expect(req.headers["x-dsh-auth-token"]).toBe("dsh-auth-token-test-xyz");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.redirect).toBe("manual");

    // Must NOT have Authorization or x-api-key or Claude headers
    expect(req.headers["Authorization"]).toBeUndefined();
    expect(req.headers["authorization"]).toBeUndefined();
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers["anthropic-beta"]).toBeUndefined();
    expect(req.headers["X-Claude-Code-Session-Id"]).toBeUndefined();

    const body = JSON.parse(req.body as string);
    expect(body.model).toBe("deepseek-flash");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe("Hello from test");
  });

  test("fails closed when provider.headers contains Authorization", async () => {
    const maliciousAdapter = createDshAccountAdapter({
      ...dshProviderConfig,
      headers: { Authorization: "Bearer evil-token" },
    });
    const parsed = parseRequest({ model: "deepseek-flash", input: [{ role: "user", content: "hi" }] });
    const incoming = { headers: new Headers(), translatorBudget: createTestTranslatorBudget() };

    await expect(maliciousAdapter.buildRequest(parsed, incoming)).rejects.toThrow(
      'Reserved header "Authorization" cannot be overridden',
    );
  });

  test("fails closed when provider.headers contains x-api-key", async () => {
    const maliciousAdapter = createDshAccountAdapter({
      ...dshProviderConfig,
      headers: { "x-api-key": "evil-key" },
    });
    const parsed = parseRequest({ model: "deepseek-flash", input: [{ role: "user", content: "hi" }] });
    const incoming = { headers: new Headers(), translatorBudget: createTestTranslatorBudget() };

    await expect(maliciousAdapter.buildRequest(parsed, incoming)).rejects.toThrow(
      'Reserved header "x-api-key" cannot be overridden',
    );
  });

  test("fails closed when provider.headers contains x-dsh-auth-token", async () => {
    const maliciousAdapter = createDshAccountAdapter({
      ...dshProviderConfig,
      headers: { "x-dsh-auth-token": "attacker-token" },
    });
    const parsed = parseRequest({ model: "deepseek-flash", input: [{ role: "user", content: "hi" }] });
    const incoming = { headers: new Headers(), translatorBudget: createTestTranslatorBudget() };

    await expect(maliciousAdapter.buildRequest(parsed, incoming)).rejects.toThrow(
      'Reserved header "x-dsh-auth-token" cannot be overridden',
    );
  });

  test("fails closed when provider.headers contains anthropic-version", async () => {
    const maliciousAdapter = createDshAccountAdapter({
      ...dshProviderConfig,
      headers: { "anthropic-version": "1999-01-01" },
    });
    const parsed = parseRequest({ model: "deepseek-flash", input: [{ role: "user", content: "hi" }] });
    const incoming = { headers: new Headers(), translatorBudget: createTestTranslatorBudget() };

    await expect(maliciousAdapter.buildRequest(parsed, incoming)).rejects.toThrow(
      'Reserved header "anthropic-version" cannot be overridden',
    );
  });

  test("allows safe custom provider headers while keeping authoritative auth headers", async () => {
    const customAdapter = createDshAccountAdapter({
      ...dshProviderConfig,
      headers: { "x-custom-trace-id": "trace-12345" },
    });
    const parsed = parseRequest({ model: "deepseek-flash", input: [{ role: "user", content: "hi" }] });
    const incoming = { headers: new Headers(), translatorBudget: createTestTranslatorBudget() };

    const req = await customAdapter.buildRequest(parsed, incoming);
    expect(req.headers["x-custom-trace-id"]).toBe("trace-12345");
    expect(req.headers["x-dsh-auth-token"]).toBe("dsh-auth-token-test-xyz");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("throws if apiKey/token is missing", async () => {
    const invalidAdapter = createDshAccountAdapter({
      ...dshProviderConfig,
      apiKey: "",
    });

    const parsed = parseRequest({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "Hello" }],
    });

    const incoming = {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    };

    await expect(invalidAdapter.buildRequest(parsed, incoming)).rejects.toThrow(
      "DeepSeek Harness account token missing — import your account in Providers > DeepSeek Account (DSH)",
    );
  });
});

describe("dsh-account formatErrorBody", () => {
  const adapter = createDshAccountAdapter(dshProviderConfig);
  const headers = new Headers();

  test("formats 401 with explicit ACCOUNT_TOKEN_INVALID explanation", () => {
    const formatted = adapter.formatErrorBody?.(401, headers, "Unauthorized");
    expect(formatted).toContain("ACCOUNT_TOKEN_INVALID");
    expect(formatted).toContain("DeepSeek Harness Desktop");
  });

  test("forwards other statuses to base error formatting", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "model deepseek-unknown not supported" },
    });
    const formatted = adapter.formatErrorBody?.(400, headers, body);
    expect(formatted).toBe("invalid_request_error: model deepseek-unknown not supported");
  });
});

describe("dsh-account stream and non-stream parsing", () => {
  const adapter = createDshAccountAdapter(dshProviderConfig);

  test("parses non-streaming response with thinking block and text", async () => {
    const budget = createTestTranslatorBudget();
    const responsePayload = {
      id: "msg_test_123",
      type: "message",
      role: "assistant",
      model: "deepseek-flash",
      content: [
        { type: "thinking", thinking: "Thinking through the solution..." },
        { type: "text", text: "Here is the response." },
      ],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 25,
        output_tokens: 30,
      },
    };

    const res = new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const events = await adapter.parseResponse?.(res, budget);
    expect(events).toBeDefined();

    const thinkingDelta = events!.find(e => e.type === "thinking_delta");
    expect(thinkingDelta).toBeDefined();
    expect((thinkingDelta as { thinking: string }).thinking).toBe("Thinking through the solution...");

    const textDelta = events!.find(e => e.type === "text_delta");
    expect(textDelta).toBeDefined();
    expect((textDelta as { text: string }).text).toBe("Here is the response.");

    const doneEvent = events!.find(e => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent as { usage: { inputTokens: number; outputTokens: number } }).usage.inputTokens).toBe(25);
    expect((doneEvent as { usage: { inputTokens: number; outputTokens: number } }).usage.outputTokens).toBe(30);
  });

  test("parses SSE streaming response with thinking and text deltas", async () => {
    const budget = createTestTranslatorBudget();
    const sseBody = [
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"role\":\"assistant\",\"model\":\"deepseek-flash\",\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Reasoning about query...\"}}\n\n",
      "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello world\"}}\n\n",
      "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":15}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ].join("");

    const res = new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const events: unknown[] = [];
    for await (const event of adapter.parseStream(res, budget)) {
      events.push(event);
    }

    expect(events.some(e => (e as { type: string }).type === "thinking_delta")).toBe(true);
    expect(events.some(e => (e as { type: string }).type === "text_delta")).toBe(true);
    expect(events.some(e => (e as { type: string }).type === "done")).toBe(true);
  });
});
