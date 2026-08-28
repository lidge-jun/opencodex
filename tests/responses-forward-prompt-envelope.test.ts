import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createProductionAdapter } from "../src/adapters/openai-responses";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

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
