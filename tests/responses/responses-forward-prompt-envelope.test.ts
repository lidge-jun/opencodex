import { describe, expect, test } from "bun:test";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
import { createResponsesPassthroughAdapter as createProductionAdapter } from "../../src/adapters/openai-responses";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createAdapter = (provider: OcxProviderConfig) =>
  withTestTranslatorBudget(createProductionAdapter(provider));

const canonicalForward: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};

function outboundBody(provider: OcxProviderConfig, rawBody: Record<string, unknown>): Record<string, unknown> {
  const adapter = createAdapter(provider);
  const request = adapter.buildRequest({
    modelId: String(rawBody.model ?? "gpt-5.6-luna"),
    context: { messages: [] },
    stream: rawBody.stream === true,
    options: {},
    _rawBody: rawBody,
  }, { headers: new Headers({ authorization: "Bearer test-token" }) });
  try {
    return JSON.parse(request.body) as Record<string, unknown>;
  } finally {
    request.releaseBodyObservation?.();
  }
}

describe("canonical ChatGPT forward prompt envelope", () => {
  test("folds textual system messages after existing instructions and strips truncation", () => {
    const functionCall = {
      type: "function_call",
      call_id: "call_keep",
      name: "shell",
      arguments: "{}",
    };
    const body = outboundBody(canonicalForward, {
      model: "gpt-5.6-luna",
      instructions: "Existing instructions",
      truncation: "disabled",
      input: [
        { type: "message", role: "system", content: "First system instruction" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        {
          type: "message",
          role: "system",
          content: [
            { type: "input_text", text: "Second" },
            { type: "text", text: " system instruction" },
          ],
        },
        functionCall,
      ],
    });

    expect(body.truncation).toBeUndefined();
    expect(body.instructions).toBe(
      "Existing instructions\n\nFirst system instruction\n\nSecond system instruction",
    );
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      functionCall,
    ]);
  });

  test("keeps every system message when any one contains non-text content", () => {
    const input = [
      { type: "message", role: "system", content: "text" },
      {
        type: "message",
        role: "system",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
      },
      { type: "message", role: "user", content: "hello" },
    ];
    const body = outboundBody(canonicalForward, {
      model: "gpt-5.6-luna",
      truncation: "disabled",
      input,
    });

    expect(body.truncation).toBeUndefined();
    expect(body.instructions).toBeUndefined();
    expect(body.input).toEqual(input);
  });

  test("folds only message-shaped system items", () => {
    const externalAgentMessage = {
      type: "agent_message",
      role: "system",
      content: [{ type: "input_text", text: "external agent content" }],
    };
    const body = outboundBody(canonicalForward, {
      model: "gpt-5.6-luna",
      instructions: "Existing instructions",
      input: [
        { type: "message", role: "system", content: "Typed system instruction" },
        { role: "system", content: "Easy input system instruction" },
        externalAgentMessage,
      ],
    });

    expect(body.instructions).toBe(
      "Existing instructions\n\nTyped system instruction\n\nEasy input system instruction",
    );
    expect(body.input).toEqual([externalAgentMessage]);
  });

  test.each([
    {
      name: "key-auth public Responses provider",
      provider: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key" as const,
        apiKey: "test-key",
      },
    },
    {
      name: "noncanonical forward gateway",
      provider: {
        adapter: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        authMode: "forward" as const,
      },
    },
  ])("preserves the public Responses envelope for $name", ({ provider }) => {
    const input = [{ type: "message", role: "system", content: "keep me" }];
    const body = outboundBody(provider, {
      model: "gpt-5.6-luna",
      instructions: "existing",
      truncation: "disabled",
      input,
    });

    expect(body.truncation).toBe("disabled");
    expect(body.instructions).toBe("existing");
    expect(body.input).toEqual(input);
  });
});


describe("canonical forward user metadata boundary", () => {
  test.each(["gpt-5.3-codex-spark", "gpt-5.6-luna"])("strips only top-level user for %s", model => {
    const raw = {
      model, user: "synthetic-client", prompt_cache_key: "synthetic-cache",
      safety_identifier: "synthetic-safety", stream: true,
      input: [{ type: "message", role: "user", content: "hello" }],
      tools: [{ type: "function", name: "lookup", parameters: {
        type: "object", properties: { user: { type: "string" } }, required: ["user"],
      } }],
    };
    const snapshot = structuredClone(raw);
    const body = outboundBody(canonicalForward, raw);
    expect(Object.hasOwn(body, "user")).toBe(false);
    expect(body.prompt_cache_key).toBe(raw.prompt_cache_key);
    expect(body.safety_identifier).toBe(raw.safety_identifier);
    expect(body.input).toEqual(raw.input);
    expect(body.tools).toEqual(raw.tools);
    expect(raw).toEqual(snapshot);
  });
  test("Claude translation retains session metadata locally but omits user on the native wire", () => {
    const raw = anthropicToResponsesBody({
      model: "gpt-5.3-codex-spark", max_tokens: 32,
      metadata: { user_id: "synthetic-claude-session" },
      messages: [{ role: "user", content: "hello" }],
    });
    expect(raw.user).toBe("synthetic-claude-session");
    const snapshot = structuredClone(raw);
    const body = outboundBody(canonicalForward, raw);
    expect(Object.hasOwn(body, "user")).toBe(false);
    expect(body.prompt_cache_key).toBe(raw.prompt_cache_key);
    expect(String(body.prompt_cache_key)).toMatch(/^[a-f0-9]{32}$/);
    expect(raw).toEqual(snapshot);
  });
  test.each([
    { ...canonicalForward, baseUrl: "https://api.openai.com/v1", authMode: "key" as const },
    { ...canonicalForward, baseUrl: "https://gateway.example/v1" },
    { ...canonicalForward, baseUrl: "https://chatgpt.com.example/backend-api/codex" },
    { ...canonicalForward, authMode: "key" as const },
  ])("does not strip user from a different destination: %j", provider => {
    const body = outboundBody(provider, { model: "model", user: "synthetic-client", input: "hello" });
    expect(body.user).toBe("synthetic-client");
  });
  test("normalizes the canonical trailing slash without changing field-absent requests", () => {
    const provider = { ...canonicalForward, baseUrl: canonicalForward.baseUrl + "/" };
    const raw = { model: "gpt-5.3-codex-spark", user: "synthetic-client", input: "hello" };
    expect(Object.hasOwn(outboundBody(provider, raw), "user")).toBe(false);
    const without = { model: raw.model, input: raw.input };
    expect(Object.hasOwn(outboundBody(provider, without), "user")).toBe(false);
    expect(without).toEqual({ model: raw.model, input: raw.input });
  });
});
