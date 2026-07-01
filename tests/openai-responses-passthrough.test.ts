import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.example/backend-api/codex",
  authMode: "forward" as const,
};

describe("OpenAI Responses passthrough sanitization", () => {
  test("drops raw reasoning input content before native GPT passthrough", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            content: [{ type: "reasoning_text", text: "raw routed reasoning" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Record<string, unknown>[] };

    expect(body.input[0]).toMatchObject({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      content: [],
    });
    expect(body.input[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
  });

  test("strips image_generation hosted tool for codex-spark passthrough", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.3-codex-spark",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.3-codex-spark",
        input: [],
        tools: [
          { type: "function", name: "shell", parameters: {} },
          { type: "image_generation" },
        ],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { tools: { type: string }[] };

    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ type: "function", name: "shell" });
    expect(body.tools.some(t => t.type === "image_generation")).toBe(false);
  });

  test("keeps image_generation hosted tool for supported native slugs", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [],
        tools: [{ type: "image_generation" }],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { tools: { type: string }[] };

    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ type: "image_generation" });
  });

  test("preserves prompt_cache_key in the raw Responses passthrough body", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: { promptCacheKey: "project-cache-v1" },
      _rawBody: {
        model: "gpt-5.5",
        input: "hi",
        prompt_cache_key: "project-cache-v1",
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { prompt_cache_key?: string };

    expect(body.prompt_cache_key).toBe("project-cache-v1");
  });

  test("preserves prompt_cache_retention in the raw Responses passthrough body", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: "hi",
        prompt_cache_retention: "24h",
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { prompt_cache_retention?: string };

    expect(body.prompt_cache_retention).toBe("24h");
  });
});
