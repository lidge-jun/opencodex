import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests } from "../src/lib/debug-settings";
import { routeModel } from "../src/router";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

const previousDebug = process.env.OCX_DEBUG;

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  if (previousDebug === undefined) delete process.env.OCX_DEBUG;
  else process.env.OCX_DEBUG = previousDebug;
});

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

    expect(events).toEqual([{
      type: "error",
      message: "upstream quota exhausted",
      code: "quota_exceeded",
    }]);
  });

  test("treats falsey upstream error payloads as errors", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    for (const error of [0, ""]) {
      const events = await adapter.parseResponse!(new Response(JSON.stringify({ error })));
      expect(events).toEqual([{ type: "error", message: "upstream error" }]);
    }
  });

  test("rejects an empty choices array", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({ choices: [] })));

    expect(events).toEqual([{ type: "error", message: "upstream response contained no choices" }]);
  });

  test("preserves usage when an upstream response has no choices", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    })));

    expect(events).toEqual([{
      type: "error",
      message: "upstream response contained no choices",
      usage: { inputTokens: 7, outputTokens: 2 },
    }]);
  });

  test("keeps ordinary and data-wrapped responses compatible for non-Cline providers", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    for (const body of [
      { choices: [{ message: { content: "plain" } }] },
      { success: true, data: { choices: [{ message: { content: "wrapped" } }] } },
    ]) {
      const events = await adapter.parseResponse!(new Response(JSON.stringify(body)));
      expect(events.find(event => event.type === "error")).toBeUndefined();
      expect(events.at(-1)?.type).toBe("done");
    }
  });

  test("rejects a choice with no message", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({ choices: [{}] })));

    expect(events).toEqual([{ type: "error", message: "upstream response contained no choices" }]);
  });

  test("rejects a null choice without throwing", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({ choices: [null] })));

    expect(events).toEqual([{ type: "error", message: "upstream response contained invalid choices" }]);
  });

  test("treats null tool calls as absent", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok", tool_calls: null } }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    })));

    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "done", usage: { inputTokens: 7, outputTokens: 2 } },
    ]);
  });

  test("rejects malformed nested tool calls without throwing", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    for (const toolCalls of [
      { unexpected: true },
      [null],
      [{ id: "call_missing_function" }],
    ]) {
      const events = await adapter.parseResponse!(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", tool_calls: toolCalls } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      })));
      expect(events).toEqual([{
        type: "error",
        message: "upstream response contained invalid tool calls",
        usage: { inputTokens: 7, outputTokens: 2 },
      }]);
    }
  });

  test("debug mode records only the non-stream tool-call shape failure", async () => {
    process.env.OCX_DEBUG = "1";
    const secretArguments = "private-tool-arguments";
    const adapter = createOpenAIChatAdapter(provider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", tool_calls: [{
        id: "call_1",
        function: { name: "tool", arguments: { secretArguments } },
      }] } }],
    })));

    expect(events).toEqual([{ type: "error", message: "upstream response contained invalid tool calls" }]);
    const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
    expect(lines).toContain("[ocx:openai-chat:invalid-tool-calls]");
    expect(lines).toContain('"mode":"response"');
    expect(lines).toContain('"reason":"tool_call_function_arguments_invalid"');
    expect(lines).toContain('"valueType":"object"');
    expect(lines).not.toContain(secretArguments);
    expect(lines).not.toContain("call_1");
  });

  test("tool-call structural diagnostics stay disabled by default", async () => {
    delete process.env.OCX_DEBUG;
    const adapter = createOpenAIChatAdapter(provider());
    await adapter.parseResponse!(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", tool_calls: { privateArguments: "secret" } } }],
    })));

    expect(getDebugLogEntries()).toHaveLength(0);
  });

  // The diagnostic's job is to say WHICH check rejected the payload. If its precedence drifts
  // from the validator's, a payload with more than one problem is reported under the wrong
  // reason and sends provider-compatibility work after the wrong shape. These cases each carry
  // two defects at once, so only the matching order produces the expected reason.
  describe("diagnostic precedence matches the buffered validator", () => {
    async function reasonFor(toolCall: unknown): Promise<string> {
      process.env.OCX_DEBUG = "1";
      const adapter = createOpenAIChatAdapter(provider());
      await adapter.parseResponse!(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", tool_calls: [toolCall] } }],
      })));
      const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
      const match = /"reason":"([a-z_]+)"/.exec(lines);
      return match?.[1] ?? "";
    }

    test("a bad function container outranks a bad id", async () => {
      // Validator checks `!isRecord(rawToolCall.function)` before it reads `id`.
      expect(await reasonFor({ id: 7, function: "not-an-object" }))
        .toBe("tool_call_function_not_object");
    });

    test("a bad id outranks a bad name", async () => {
      expect(await reasonFor({ id: 7, function: { name: 9, arguments: "{}" } }))
        .toBe("tool_call_id_invalid");
    });

    test("a bad arguments type outranks a blank name", async () => {
      // Both are rejected by the same validator condition; arguments is checked first there,
      // so a blank name must not shadow it.
      expect(await reasonFor({ id: "call_1", function: { name: "   ", arguments: 5 } }))
        .toBe("tool_call_function_arguments_invalid");
    });

    test("a blank name is reported as blank, not as a type problem", async () => {
      expect(await reasonFor({ id: "call_1", function: { name: "   ", arguments: "{}" } }))
        .toBe("tool_call_function_name_blank");
    });
  });
});

describe("openai-chat stream response hardening", () => {
  test("treats falsey upstream error payloads as terminal errors", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    for (const error of [0, ""]) {
      const response = new Response([
        `data: ${JSON.stringify({ error })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));

      const events = await collect(adapter.parseStream(response));
      expect(events).toEqual([{ type: "error", message: "upstream error" }]);
    }
  });

  test("rejects a non-array choices payload without throwing", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const response = new Response([
      'data: {"choices":{},"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join(""));

    const events = await collect(adapter.parseStream(response));
    expect(events).toEqual([{
      type: "error",
      message: "upstream response contained invalid choices",
      usage: { inputTokens: 7, outputTokens: 2 },
    }]);
  });

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

  test("treats null streaming tool calls as padding", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const response = new Response([
      'data: {"choices":[{"delta":{"content":"ok","tool_calls":null}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join(""));

    const events = await collect(adapter.parseStream(response));
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "done", usage: { inputTokens: 7, outputTokens: 2 } },
    ]);
  });

  test("malformed nested streaming tool calls are terminal errors", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    for (const toolCalls of [{ unexpected: true }, [null]]) {
      const response = new Response([
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: toolCalls } }],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));

      const events = await collect(adapter.parseStream(response));
      expect(events).toEqual([{
        type: "error",
        message: "upstream response contained invalid tool calls",
        usage: { inputTokens: 7, outputTokens: 2 },
      }]);
    }
  });

  test("debug mode classifies streaming tool-call structure without retaining values", async () => {
    process.env.OCX_DEBUG = "1";
    const privateName = "private-tool-name";
    const adapter = createOpenAIChatAdapter(provider());
    const response = new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        privateName,
        privateArguments: "private arguments",
      }, null] } }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));

    const events = await collect(adapter.parseStream(response));
    expect(events).toEqual([{ type: "error", message: "upstream response contained invalid tool calls" }]);
    const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
    expect(lines).toContain('"mode":"stream"');
    expect(lines).toContain('"reason":"tool_call_not_object"');
    expect(lines).toContain('"callIndex":1');
    expect(lines).toContain('"valueType":"null"');
    expect(lines).not.toContain(privateName);
    expect(lines).not.toContain("private arguments");
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

  test("preserves a caller-supplied service tier when the provider opts in", () => {
    const adapter = createOpenAIChatAdapter(provider({ chatServiceTier: true }));
    const req = parsed();
    req.options.serviceTier = "priority";

    const body = JSON.parse(adapter.buildRequest(req).body);

    expect(body.service_tier).toBe("priority");
  });

  // `service_tier` is an OpenAI-specific extension and this adapter serves 66 registry
  // providers, several of which reject unknown body fields. Forwarding it by default would
  // turn a caller-supplied tier into an upstream 400 on those routes, so absence of the
  // opt-in must mean the field is dropped — the same contract `prompt_cache_key` uses.
  test("drops a caller-supplied service tier when the provider has not opted in", () => {
    for (const p of [provider(), provider({ chatServiceTier: false })]) {
      const req = parsed();
      req.options.serviceTier = "priority";

      const body = JSON.parse(createOpenAIChatAdapter(p).buildRequest(req).body);

      expect(body).not.toHaveProperty("service_tier");
    }
  });

  test("an opted-in provider without a caller tier still sends no service_tier", () => {
    const body = JSON.parse(createOpenAIChatAdapter(provider({ chatServiceTier: true })).buildRequest(parsed()).body);

    expect(body).not.toHaveProperty("service_tier");
  });

  test("canonical Kimi Coding Plan routes forward Codex prompt_cache_key", () => {
    for (const [providerName, authMode] of [
      ["kimi", "oauth"],
      ["kimi-code", "key"],
    ] as const) {
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: providerName,
        providers: {
          [providerName]: {
            adapter: "openai-chat",
            baseUrl: "https://api.kimi.com/coding/v1",
            apiKey: "test-kimi-credential",
            authMode,
          },
        },
      };
      const route = routeModel(config, `${providerName}/k3`);
      const req = parsed();
      req.modelId = route.modelId;
      req.options.promptCacheKey = "codex-kimi-session-v1";

      expect(route.provider.promptCacheKey).toBe(true);
      const body = JSON.parse(createOpenAIChatAdapter(route.provider).buildRequest(req).body);
      expect(body).toMatchObject({
        model: "k3",
        prompt_cache_key: "codex-kimi-session-v1",
      });
    }
  });

  test("an explicit Kimi promptCacheKey false remains an opt-out", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "kimi",
      providers: {
        kimi: {
          adapter: "openai-chat",
          baseUrl: "https://api.kimi.com/coding/v1",
          apiKey: "test-kimi-credential",
          authMode: "oauth",
          promptCacheKey: false,
        },
      },
    };
    const route = routeModel(config, "kimi/k3");
    const req = parsed();
    req.modelId = route.modelId;
    req.options.promptCacheKey = "codex-kimi-session-v1";

    expect(route.provider.promptCacheKey).toBe(false);
    const body = JSON.parse(createOpenAIChatAdapter(route.provider).buildRequest(req).body);
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

describe("openai-chat response_format emission", () => {
  const bodyOf = (req: { body?: unknown }): Record<string, unknown> =>
    JSON.parse(req.body as string) as Record<string, unknown>;

  test("maps textFormat json_object onto response_format", () => {
    const req = createOpenAIChatAdapter(provider()).buildRequest({
      ...parsed(),
      options: { textFormat: { type: "json_object" } },
    });

    expect(bodyOf(req).response_format).toEqual({ type: "json_object" });
  });

  test("re-nests textFormat json_schema as chat response_format", () => {
    const req = createOpenAIChatAdapter(provider()).buildRequest({
      ...parsed(),
      options: {
        textFormat: { type: "json_schema", name: "answer", description: "shape", schema: { type: "object" }, strict: true },
      },
    });

    expect(bodyOf(req).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", description: "shape", schema: { type: "object" }, strict: true },
    });
  });

  test("defaults the json_schema name when the Responses form omits it", () => {
    const req = createOpenAIChatAdapter(provider()).buildRequest({
      ...parsed(),
      options: { textFormat: { type: "json_schema", schema: { type: "object" } } },
    });

    expect(bodyOf(req).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", schema: { type: "object" } },
    });
  });

  test("omits response_format without a textFormat option", () => {
    const plain = createOpenAIChatAdapter(provider()).buildRequest(parsed());

    expect(bodyOf(plain).response_format).toBeUndefined();
  });

  test("preserves a schema-less json_schema response_format", () => {
    const schemaless = createOpenAIChatAdapter(provider()).buildRequest({
      ...parsed(),
      options: { textFormat: { type: "json_schema", name: "answer" } },
    });

    expect(bodyOf(schemaless).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer" },
    });
  });

  test("omits response_format only for an explicitly opted-out model", () => {
    const adapter = createOpenAIChatAdapter(provider({
      noStructuredOutputModels: ["test-model"],
    }));
    const options: OcxParsedRequest["options"] = {
      textFormat: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true },
    };

    const optedOut = adapter.buildRequest({ ...parsed(), options });
    const supportedSibling = adapter.buildRequest({ ...parsed(), modelId: "supported-model", options });
    const colonVariant = adapter.buildRequest({ ...parsed(), modelId: "test-model:structured", options });

    expect(bodyOf(optedOut).response_format).toBeUndefined();
    expect(bodyOf(supportedSibling).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    });
    expect(bodyOf(colonVariant).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    });
  });
});
