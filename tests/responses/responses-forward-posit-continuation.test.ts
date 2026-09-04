import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createProductionAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
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
  const request = createAdapter(provider).buildRequest(
    parseRequest(structuredClone(rawBody)),
    { headers: new Headers({ authorization: "Bearer test-token" }) },
  );
  try {
    return JSON.parse(request.body) as Record<string, unknown>;
  } finally {
    request.releaseBodyObservation?.();
  }
}

function positContinuation(store: boolean): Record<string, unknown> {
  return {
    model: "gpt-5.6-luna",
    store,
    stream: true,
    reasoning: { effort: "high" },
    input: [
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "continue",
          prompt_cache_breakpoint: { type: "ephemeral" },
        }],
      },
      {
        type: "item_reference",
        id: "rs_unpersisted",
      },
      {
        type: "function_call",
        id: "fc_pair",
        call_id: "call_pair",
        name: "list_files",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_pair",
        output: [{
          type: "input_text",
          text: "file.R",
          metadata: {
            nested: {
              prompt_cache_breakpoint: true,
              keep: "visible",
            },
          },
        }],
      },
    ],
  };
}

describe("canonical ChatGPT forward Posit continuation normalization", () => {
  test("removes cache markers and unstored references without changing call_id or reasoning", () => {
    const body = outboundBody(canonicalForward, positContinuation(false));
    const input = body.input as Array<Record<string, unknown>>;

    expect(JSON.stringify(input)).not.toContain("prompt_cache_breakpoint");
    expect(input.some(item => item.type === "item_reference")).toBe(false);
    expect(input.find(item => item.type === "function_call")?.call_id).toBe("call_pair");
    expect(input.find(item => item.type === "function_call_output")?.call_id).toBe("call_pair");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(JSON.stringify(input)).toContain('"keep":"visible"');
  });

  test("keeps item_reference when storage is enabled but still removes client-only markers", () => {
    const body = outboundBody(canonicalForward, positContinuation(true));
    const input = body.input as Array<Record<string, unknown>>;

    expect(input.find(item => item.type === "item_reference")).toEqual({
      type: "item_reference",
      id: "rs_unpersisted",
    });
    expect(JSON.stringify(input)).not.toContain("prompt_cache_breakpoint");
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
  ])("preserves the continuation extensions for $name", ({ provider }) => {
    const body = outboundBody(provider, positContinuation(false));
    const serialized = JSON.stringify(body.input);

    expect(serialized).toContain("prompt_cache_breakpoint");
    expect((body.input as Array<Record<string, unknown>>).some(item => item.type === "item_reference")).toBe(true);
  });

  test("an over-depth marker subtree is kept atomically instead of partially rewritten", () => {
    let nested: Record<string, unknown> = { prompt_cache_breakpoint: true, keep: "deep" };
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    const body = outboundBody(canonicalForward, {
      model: "gpt-5.6-luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi", nested }] }],
    });

    expect(JSON.stringify(body.input)).toContain("prompt_cache_breakpoint");
    expect(JSON.stringify(body.input)).toContain('"keep":"deep"');
  });
});
