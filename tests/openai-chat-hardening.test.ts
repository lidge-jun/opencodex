import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { routeModel } from "../src/router";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function parsed(): OcxParsedRequest {
  return {
    modelId: "test-model",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: {},
  };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    authMode: "key",
    ...overrides,
  };
}

async function collect(stream: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function routedProvider(name: "litellm" | "ollama", apiKey?: string): OcxProviderConfig {
  const config = {
    port: 10100,
    defaultProvider: name,
    providers: {
      [name]: {
        adapter: "openai-chat",
        baseUrl: name === "litellm" ? "http://localhost:4000/v1" : "http://localhost:11434/v1",
        ...(name === "litellm" ? { authMode: "key" as const } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
      },
    },
  } as OcxConfig;
  return routeModel(config, `${name}/test-model`).provider;
}

describe("openai-chat non-stream response hardening", () => {
  test("surfaces an upstream error envelope message", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      error: { message: "upstream quota exhausted", code: "quota_exceeded" },
    })));

    expect(events).toEqual([{ type: "error", message: "upstream quota exhausted" }]);
  });

  test("rejects an empty choices array", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({ choices: [] })));

    expect(events).toEqual([{ type: "error", message: "upstream response contained no choices" }]);
  });

  test("rejects a choice with no message", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({ choices: [{}] })));

    expect(events).toEqual([{ type: "error", message: "upstream response contained no choices" }]);
  });
});

describe("openai-chat stream response hardening", () => {
  test("malformed SSE data is terminal even when followed by [DONE]", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      "data: {not-json}\n\n",
      "data: [DONE]\n\n",
    ].join(""));

    const events = await collect(adapter.parseStream(response));

    expect(events.at(-1)).toEqual({ type: "error", message: "malformed upstream SSE data frame" });
    expect(events.some(event => event.type === "done")).toBe(false);
  });
});

describe("openai-chat credential hardening", () => {
  test("key mode rejects a blank credential", () => {
    const adapter = createOpenAIChatAdapter(provider({ apiKey: "   " }));

    expect(() => adapter.buildRequest(parsed())).toThrow(
      "openai-chat requires a non-empty credential (authMode: key)",
    );
  });

  test("OAuth mode rejects a blank credential", () => {
    const adapter = createOpenAIChatAdapter(provider({ authMode: "oauth", apiKey: "" }));

    expect(() => adapter.buildRequest(parsed())).toThrow(
      "openai-chat requires a non-empty credential (authMode: oauth)",
    );
  });

  test("undefined auth mode remains keyless", () => {
    const adapter = createOpenAIChatAdapter(provider({ authMode: undefined, apiKey: undefined }));

    expect(adapter.buildRequest(parsed()).headers).not.toHaveProperty("Authorization");
  });

  test("a routed local provider remains keyless", () => {
    const local = routedProvider("ollama");

    expect(local.authMode).toBeUndefined();
    expect(createOpenAIChatAdapter(local).buildRequest(parsed()).headers).not.toHaveProperty("Authorization");
  });

  test("LiteLLM's routed optional-key flag permits a keyless request", () => {
    const litellm = routedProvider("litellm");

    expect(litellm.keyOptional).toBe(true);
    expect(createOpenAIChatAdapter(litellm).buildRequest(parsed()).headers).not.toHaveProperty("Authorization");
  });

  test("LiteLLM still sends a configured bearer credential", () => {
    const litellm = routedProvider("litellm", "sk-litellm");

    expect(createOpenAIChatAdapter(litellm).buildRequest(parsed()).headers).toMatchObject({
      Authorization: "Bearer sk-litellm",
    });
  });

  test("forwards prompt_cache_key to the outbound chat body when the provider opts in", () => {
    const adapter = createOpenAIChatAdapter(provider({ promptCacheKey: true }));
    const req = parsed();
    req.options.promptCacheKey = "shared-prefix-v1";

    const body = JSON.parse(adapter.buildRequest(req).body);

    expect(body.prompt_cache_key).toBe("shared-prefix-v1");
  });

  test("does not forward prompt_cache_key when the provider has not opted in", () => {
    const adapter = createOpenAIChatAdapter(provider());
    const req = parsed();
    req.options.promptCacheKey = "shared-prefix-v1";

    const body = JSON.parse(adapter.buildRequest(req).body);

    expect(body).not.toHaveProperty("prompt_cache_key");
  });

  test("omits prompt_cache_key from the outbound chat body when unset", () => {
    const adapter = createOpenAIChatAdapter(provider({ promptCacheKey: true }));

    const body = JSON.parse(adapter.buildRequest(parsed()).body);

    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});

describe("openai-chat max output defaults", () => {
  test("omits max_tokens when neither request nor provider config sets a budget", () => {
    const body = JSON.parse(createOpenAIChatAdapter(provider()).buildRequest(parsed()).body);

    expect(body).not.toHaveProperty("max_tokens");
  });

  test("uses provider defaultMaxOutputTokens when Codex omits max_output_tokens", () => {
    const body = JSON.parse(createOpenAIChatAdapter(provider({ defaultMaxOutputTokens: 32_000 })).buildRequest(parsed()).body);

    expect(body.max_tokens).toBe(32_000);
  });

  test("modelMaxOutputTokens beats the provider default and supports model matching helpers", () => {
    const req = parsed();
    req.modelId = "gpt-oss:120b";
    const body = JSON.parse(createOpenAIChatAdapter(provider({
      defaultMaxOutputTokens: 16_000,
      modelMaxOutputTokens: { "gpt-oss": 64_000 },
    })).buildRequest(req).body);

    expect(body.max_tokens).toBe(64_000);
  });

  test("explicit request max_output_tokens beats configured defaults", () => {
    const req = parsed();
    req.options.maxOutputTokens = 8_000;
    const body = JSON.parse(createOpenAIChatAdapter(provider({
      defaultMaxOutputTokens: 32_000,
      modelMaxOutputTokens: { "test-model": 64_000 },
    })).buildRequest(req).body);

    expect(body.max_tokens).toBe(8_000);
  });

  test("thinking-budget models size thinking_budget from the effective default budget", () => {
    const body = JSON.parse(createOpenAIChatAdapter(provider({
      defaultMaxOutputTokens: 20_000,
      thinkingBudgetModels: ["test-model"],
      reasoningEffortMap: { high: "high" },
    })).buildRequest({
      ...parsed(),
      options: { reasoning: "high" },
    }).body);

    expect(body.max_tokens).toBe(20_000);
    expect(body.thinking_budget).toBe(15_000);
  });
});
