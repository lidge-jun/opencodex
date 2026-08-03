import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { sanitizeEncryptedContentInPlace } from "../src/server/responses";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.example/backend-api/codex",
  authMode: "forward" as const,
};

test("passthrough serialized-body observation releases after the request settles", () => {
  const budget = createTranslatorBudget();
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: "test-model",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: "test-model", input: "ping" },
  }, { headers: new Headers({ authorization: "Bearer token" }), translatorBudget: budget });
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  request.releaseBodyObservation?.();
  expect(budget.snapshot().currentBytes).toBe(0);
  budget.dispose();
});

function buildKeyAuthUrl(baseUrl: string, responsesPath?: string): string {
  const adapter = createResponsesPassthroughAdapter({
    adapter: "openai-responses",
    baseUrl,
    authMode: "key" as const,
    apiKey: "sk-test",
    ...(responsesPath === undefined ? {} : { responsesPath }),
  });
  return adapter.buildRequest({
    modelId: "test-model",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: "test-model", input: "ping" },
  }, { headers: new Headers() }).url;
}

describe("OpenAI Responses key-auth URL construction", () => {
  test("BUG-R289 preserves legacy /v1/responses URL when responsesPath is absent", () => {
    for (const [baseUrl, expectedUrl] of [
      ["https://api.openai.example", "https://api.openai.example/v1/responses"],
      ["https://api.openai.example/v1", "https://api.openai.example/v1/responses"],
      ["https://api.openai.example/v1/", "https://api.openai.example/v1/responses"],
    ] as const) {
      expect(buildKeyAuthUrl(baseUrl)).toBe(expectedUrl);
    }
  });

  test("BUG-R289 appends responsesPath to a baseUrl with one trailing slash", () => {
    expect(buildKeyAuthUrl("https://gateway.example/api/v3/", "/responses"))
      .toBe("https://gateway.example/api/v3/responses");
  });

  test("BUG-R289 routes Volcengine Ark Agent Plan to /api/plan/v3/responses", () => {
    expect(buildKeyAuthUrl(
      "https://ark.cn-beijing.volces.com/api/plan/v3",
      "/responses",
    )).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/responses");
  });
});

/**
 * DeepSeek documents `POST /responses` with no `/v1` segment
 * (https://api-docs.deepseek.com/api/create-response/). Commit e743660fc defaulted
 * deepseek-v4-flash onto the Responses wire but left the path unset, so the adapter
 * fell back to the legacy `/v1/responses` construction and the wire could never route.
 */
describe("DeepSeek Responses endpoint contract", () => {
  test("the seeded deepseek provider targets the documented /responses route", () => {
    const seed = providerConfigSeed(getProviderRegistryEntry("deepseek")!);
    expect(seed.responsesPath).toBe("/responses");
    expect(buildKeyAuthUrl(seed.baseUrl, seed.responsesPath))
      .toBe("https://api.deepseek.com/responses");
  });

  test("a provider that declares no responsesPath still gets the legacy construction", () => {
    // Negative control: the fix must not become a global change of the default branch.
    const seed = providerConfigSeed(getProviderRegistryEntry("cerebras")!);
    expect(seed.responsesPath).toBeUndefined();
    expect(buildKeyAuthUrl("https://api.cerebras.ai/v1", seed.responsesPath))
      .toBe("https://api.cerebras.ai/v1/responses");
  });

  test("a config saved before the fix is backfilled, and a hand-set path is preserved", () => {
    const saved = { adapter: "openai-chat", baseUrl: "https://api.deepseek.com", apiKey: "sk-test" } as Parameters<typeof enrichProviderFromRegistry>[1];
    enrichProviderFromRegistry("deepseek", saved);
    expect(saved.responsesPath).toBe("/responses");

    const custom = { adapter: "openai-chat", baseUrl: "https://api.deepseek.com", apiKey: "sk-test", responsesPath: "/custom/responses" } as Parameters<typeof enrichProviderFromRegistry>[1];
    enrichProviderFromRegistry("deepseek", custom);
    expect(custom.responsesPath).toBe("/custom/responses");
  });
});

describe("OpenAI Responses passthrough sanitization", () => {
  test("normalizes top-level function schemas in the serialized raw body (#745)", () => {
    const validParameters = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    };
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [],
        tools: [
          { type: "function", name: "missing_parameters" },
          { type: "function", name: "missing_root_type", parameters: { properties: { query: { type: "string" } } } },
          { type: "function", name: "valid_schema", parameters: validParameters },
        ],
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as { tools: { name: string; parameters: Record<string, unknown> }[] };

    expect(body.tools).toEqual([
      { type: "function", name: "missing_parameters", parameters: { type: "object" } },
      {
        type: "function",
        name: "missing_root_type",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
      { type: "function", name: "valid_schema", parameters: validParameters },
    ]);
  });

  test("normalizes additional_tools function schemas in the serialized raw body (#745)", () => {
    const validParameters = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    };
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [{
          type: "additional_tools",
          tools: [
            { type: "function", name: "missing_parameters" },
            { type: "function", name: "missing_root_type", parameters: { properties: { query: { type: "string" } } } },
            { type: "function", name: "valid_schema", parameters: validParameters },
          ],
        }],
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as {
      input: { type: string; tools: { name: string; parameters: Record<string, unknown> }[] }[];
    };

    expect(body.input[0].tools).toEqual([
      { type: "function", name: "missing_parameters", parameters: { type: "object" } },
      {
        type: "function",
        name: "missing_root_type",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
      { type: "function", name: "valid_schema", parameters: validParameters },
    ]);
  });

  test("model reasoning-summary opt-out strips unsupported delivery fields (#323)", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://compat.example.test/v1",
      authMode: "key",
      apiKey: "sk-test",
      modelSupportsReasoningSummaries: { "strict-summary-model": false },
    });
    const request = adapter.buildRequest({
      modelId: "strict-summary-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "strict-summary-model",
        input: [],
        stream_options: {
          include_usage: true,
          reasoning_summary_delivery: "sequential_cutoff",
        },
        reasoning: {
          effort: "high",
          summary: "auto",
          generate_summary: true,
        },
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, Record<string, unknown>>;

    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  test("model reasoning-summary delivery rewrites only the configured stale-client enum (#538)", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://compat.example.test/v1",
      authMode: "key",
      apiKey: "sk-test",
      modelReasoningSummaryDelivery: { "summary-model": "sequential" },
    });
    const request = adapter.buildRequest({
      modelId: "summary-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "summary-model",
        input: [],
        stream_options: {
          include_usage: true,
          reasoning_summary_delivery: "sequential_cutoff",
        },
        reasoning: { effort: "high", summary: "auto" },
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, Record<string, unknown>>;

    expect(body.stream_options).toEqual({
      include_usage: true,
      reasoning_summary_delivery: "sequential",
    });
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("model reasoning-summary delivery does not inject a missing caller field (#538)", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://compat.example.test/v1",
      authMode: "key",
      apiKey: "sk-test",
      modelReasoningSummaryDelivery: { "summary-model": "concurrent" },
    });
    const request = adapter.buildRequest({
      modelId: "summary-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "summary-model",
        input: [],
        stream_options: { include_usage: true },
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, Record<string, unknown>>;

    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("reasoning-summary fields remain untouched without an explicit opt-out", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://compat.example.test/v1",
      authMode: "key",
      apiKey: "sk-test",
    });
    const request = adapter.buildRequest({
      modelId: "normal-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "normal-model",
        input: [],
        stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, Record<string, unknown>>;

    expect(body.stream_options).toEqual({ reasoning_summary_delivery: "sequential_cutoff" });
  });

  test("agent_message conversion removes its non-OpenAI item id", () => {
    const input = [{
      type: "agent_message",
      id: "019f5e7f-ac31-7610-b69c-43ae41759fce",
      author: "/root",
      recipient: "/root/worker",
      content: [{ type: "encrypted_content", encrypted_content: "delegated task" }],
    }];

    expect(sanitizeEncryptedContentInPlace(input)).toBe(1);
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "delegated task" }],
    });
    expect(input[0]).not.toHaveProperty("id");
  });

  test("strips invalid type-specific ids from serialized input items", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const encryptedContent = "opaque-openai-encrypted-content";
    const cases = [
      { item: { type: "message", id: "019f5e7f-ac31-7610-b69c-43ae41759fce", role: "user", content: "first" }, expectedId: undefined },
      { item: { type: "message", id: "msg_abc", role: "assistant", content: "second" }, expectedId: "msg_abc" },
      { item: { type: "custom_tool_call", id: "fc_old", call_id: "call_1", name: "patch", input: "old" }, expectedId: undefined },
      { item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_2", name: "patch", input: "new" }, expectedId: "ctc_1" },
      { item: { type: "function_call", id: "fc_1", call_id: "call_3", name: "ping", arguments: "{}" }, expectedId: "fc_1" },
      { item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encryptedContent }, expectedId: "rs_1" },
      { item: { type: "tool_search_call", id: "fc_old_search", call_id: "call_4", execution: "client", arguments: {} }, expectedId: undefined },
      { item: { type: "tool_search_call", id: "tsc_1", call_id: "call_5", execution: "client", arguments: {} }, expectedId: "tsc_1" },
      { item: { type: "web_search_call", id: "fc_wrong", status: "completed" }, expectedId: undefined },
      { item: { type: "web_search_call", id: "ws_valid", status: "completed" }, expectedId: "ws_valid" },
      { item: { type: "agent_message", id: "msg_wrong-dialect", content: [{ type: "output_text", text: "routed reply" }] }, expectedId: undefined },
      { item: { type: "agent_message", id: "amsg_1", content: [{ type: "output_text", text: "routed reply" }] }, expectedId: "amsg_1" },
    ];
    const input = cases.map(({ item }) => item);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Record<string, unknown>[] };

    cases.forEach(({ expectedId }, index) => {
      if (expectedId === undefined) expect(body.input[index]).not.toHaveProperty("id");
      else expect(body.input[index].id).toBe(expectedId);
    });
    expect(body.input[5]).toEqual(input[5]);
  });

  test("strips all item ids when store is false and preserves them otherwise", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const input = [
      { type: "message", id: "msg_abc", role: "assistant", content: "hello" },
      { type: "function_call", id: "fc_xyz", call_id: "call_1", name: "ping", arguments: "{}" },
      { type: "reasoning", id: "rs_123", summary: [] },
    ];
    const unstoredBody = JSON.parse(adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", store: false, input },
    }, { headers: new Headers({ authorization: "Bearer token" }) }).body) as { input: Record<string, unknown>[] };

    unstoredBody.input.forEach(item => expect(item).not.toHaveProperty("id"));
    expect(unstoredBody.input[1].call_id).toBe("call_1");

    const omittedStoreBody = JSON.parse(adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input },
    }, { headers: new Headers({ authorization: "Bearer token" }) }).body) as { input: Record<string, unknown>[] };
    const storedBody = JSON.parse(adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", store: true, input },
    }, { headers: new Headers({ authorization: "Bearer token" }) }).body) as { input: Record<string, unknown>[] };

    expect(omittedStoreBody.input.map(item => item.id)).toEqual(["msg_abc", "fc_xyz", "rs_123"]);
    expect(storedBody.input.map(item => item.id)).toEqual(["msg_abc", "fc_xyz", "rs_123"]);
  });

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

  const expandedRawBody = {
    model: "gpt-5.5",
    previous_response_id: "resp_1",
    input: [
      { role: "user", content: "first" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
  };
  const deltaRawBody = {
    ...expandedRawBody,
    input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
  };
  const parsedBase = {
    modelId: "gpt-5.5",
    previousResponseId: "resp_1",
    context: { messages: [] },
    stream: true,
    options: {},
  };
  const meta = { headers: new Headers({ authorization: "Bearer token" }) };

  test("forward mode always drops previous_response_id (ChatGPT backend rejects it)", () => {
    const adapter = createResponsesPassthroughAdapter(provider);

    const expandedBody = JSON.parse(adapter.buildRequest({
      ...parsedBase,
      _previousResponseInputExpanded: true,
      _rawBody: expandedRawBody,
    }, meta).body) as { previous_response_id?: string; input: unknown[] };
    expect(expandedBody.previous_response_id).toBeUndefined();
    expect(expandedBody.input).toHaveLength(3);

    // Unexpanded miss (proxy restart, TTL, prior passthrough turn): the field must STILL be
    // stripped — the Codex REST backend 400s on it ({"detail":"Unsupported parameter: ..."}).
    const rawDeltaBody = JSON.parse(adapter.buildRequest({
      ...parsedBase,
      _rawBody: deltaRawBody,
    }, meta).body) as { previous_response_id?: string; input: unknown[] };
    expect(rawDeltaBody.previous_response_id).toBeUndefined();
    expect(rawDeltaBody.input).toHaveLength(1);
  });

  test("api-key mode drops previous_response_id only after proxy-expanded replay", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.example/v1",
      authMode: "key" as const,
      apiKey: "sk-test",
    });

    const expandedBody = JSON.parse(adapter.buildRequest({
      ...parsedBase,
      _previousResponseInputExpanded: true,
      _rawBody: expandedRawBody,
    }, meta).body) as { previous_response_id?: string; input: unknown[] };
    expect(expandedBody.previous_response_id).toBeUndefined();
    expect(expandedBody.input).toHaveLength(3);

    // Platform /v1/responses supports server-side storage; an unexpanded id stays intact.
    const rawDeltaBody = JSON.parse(adapter.buildRequest({
      ...parsedBase,
      _rawBody: deltaRawBody,
    }, meta).body) as { previous_response_id?: string; input: unknown[] };
    expect(rawDeltaBody.previous_response_id).toBe("resp_1");
    expect(rawDeltaBody.input).toHaveLength(1);
  });

  test("forward unexpanded miss converts orphan tool outputs and drops reasoning", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const body = JSON.parse(adapter.buildRequest({
      ...parsedBase,
      _rawBody: {
        model: "gpt-5.5",
        previous_response_id: "resp_gone",
        input: [
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "function_call_output", call_id: "call_orphan", output: "tool said hi" },
          { type: "custom_tool_call_output", call_id: "call_custom", output: [{ type: "output_text", text: "custom out" }] },
          { role: "user", content: "next question" },
        ],
      },
    }, meta).body) as { previous_response_id?: string; input: Record<string, unknown>[] };

    expect(body.previous_response_id).toBeUndefined();
    // reasoning dropped, both orphan outputs converted to user messages, user message intact
    expect(body.input).toHaveLength(3);
    expect(body.input[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "[tool output for call_orphan]\ntool said hi" }],
    });
    expect(body.input[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "[tool output for call_custom]\ncustom out" }],
    });
    expect(body.input[2]).toMatchObject({ role: "user", content: "next question" });
  });

  test("forward mode keeps paired tool outputs and local_shell_call pairs intact", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const input = [
      { type: "function_call", call_id: "call_fn", name: "ping", arguments: "{}" },
      { type: "function_call_output", call_id: "call_fn", output: "pong" },
      { type: "local_shell_call", call_id: "call_sh", action: { type: "exec", command: ["ls"] } },
      { type: "function_call_output", call_id: "call_sh", output: "files" },
      { role: "user", content: "go on" },
    ];
    const body = JSON.parse(adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input },
    }, meta).body) as { input: Record<string, unknown>[] };

    expect(body.input).toEqual(input);
  });

  test("forward mode repairs oversized call ids consistently across paired replay items", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const oversizedCallId = `call_${"x".repeat(80)}`;
    const input = [
      { type: "function_call", call_id: oversizedCallId, name: "ping", arguments: "{}" },
      { type: "function_call_output", call_id: oversizedCallId, output: "pong" },
      { type: "function_call", call_id: "call_short", name: "keep", arguments: "{}" },
      { type: "function_call_output", call_id: "call_short", output: "kept" },
    ];

    const body = JSON.parse(adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.6-sol", input },
    }, meta).body) as { input: Record<string, unknown>[] };

    const repairedCallId = body.input[0].call_id as string;
    expect(repairedCallId).toStartWith("call_ocx_");
    expect(repairedCallId.length).toBeLessThanOrEqual(64);
    expect(body.input[1].call_id).toBe(repairedCallId);
    expect(body.input[2].call_id).toBe("call_short");
    expect(body.input[3].call_id).toBe("call_short");
    expect(input[0].call_id).toBe(oversizedCallId);
    expect(input[1].call_id).toBe(oversizedCallId);
  });

  test("forward mode assigns distinct stable aliases to oversized custom and tool-search pairs", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const customCallId = `call_custom_${"a".repeat(80)}`;
    const searchCallId = `call_search_${"b".repeat(80)}`;
    const input = [
      { type: "custom_tool_call", call_id: customCallId, name: "apply_patch", input: "patch" },
      { type: "custom_tool_call_output", call_id: customCallId, output: "done" },
      { type: "tool_search_call", call_id: searchCallId, execution: "client", arguments: {} },
      { type: "tool_search_output", call_id: searchCallId, tools: [] },
    ];

    const build = () => JSON.parse(adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.6-sol", input },
    }, meta).body) as { input: Record<string, unknown>[] };

    const first = build().input;
    const second = build().input;
    expect(first[0].call_id).toBe(first[1].call_id);
    expect(first[2].call_id).toBe(first[3].call_id);
    expect(first[0].call_id).not.toBe(first[2].call_id);
    expect((first[0].call_id as string).length).toBeLessThanOrEqual(64);
    expect((first[2].call_id as string).length).toBeLessThanOrEqual(64);
    expect(second.map(item => item.call_id)).toEqual(first.map(item => item.call_id));
  });

  test("api-key mode preserves oversized call ids that may reference upstream stored state", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.example/v1",
      authMode: "key" as const,
      apiKey: "sk-test",
    });
    const oversizedCallId = `call_${"stored".repeat(14)}`;
    const input = [
      { type: "function_call_output", call_id: oversizedCallId, output: "pong" },
    ];

    const body = JSON.parse(adapter.buildRequest({
      ...parsedBase,
      _rawBody: {
        model: "gpt-5.5",
        previous_response_id: "resp_stored",
        input,
      },
    }, meta).body) as { previous_response_id: string; input: Array<{ call_id: string }> };

    expect(body.previous_response_id).toBe("resp_stored");
    expect(body.input[0]?.call_id).toBe(oversizedCallId);
  });

  test("api-key mode repairs oversized call ids after proxy-expanded replay", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.example/v1",
      authMode: "key" as const,
      apiKey: "sk-test",
    });
    const oversizedCallId = `call_${"expanded".repeat(12)}`;

    const body = JSON.parse(adapter.buildRequest({
      ...parsedBase,
      _previousResponseInputExpanded: true,
      _rawBody: {
        model: "gpt-5.5",
        previous_response_id: "resp_expanded",
        input: [
          { type: "function_call", call_id: oversizedCallId, name: "ping", arguments: "{}" },
          { type: "function_call_output", call_id: oversizedCallId, output: "pong" },
        ],
      },
    }, meta).body) as { previous_response_id?: string; input: Array<{ call_id: string }> };

    expect(body.previous_response_id).toBeUndefined();
    expect(body.input[0]?.call_id).toStartWith("call_ocx_");
    expect(body.input[0]?.call_id.length).toBe(64);
    expect(body.input[1]?.call_id).toBe(body.input[0]?.call_id);
  });

  test("forward expanded replay keeps reasoning items (chain is intact)", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const body = JSON.parse(adapter.buildRequest({
      ...parsedBase,
      _previousResponseInputExpanded: true,
      _rawBody: {
        model: "gpt-5.5",
        previous_response_id: "resp_1",
        input: [
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "prior" }] },
          { role: "user", content: "next" },
        ],
      },
    }, meta).body) as { input: Record<string, unknown>[] };

    expect(body.input).toHaveLength(3);
    expect(body.input[0]).toMatchObject({ type: "reasoning", id: "rs_1" });
  });
});

describe("OpenAI Responses hosted-tool name conflicts", () => {
  const keyedProvider = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.example/v1",
    authMode: "key" as const,
    apiKey: "sk-test",
  };
  const meta = { headers: new Headers({ authorization: "Bearer token" }) };

  test("keyed platform replaces a dotted image_gen function with a safe alias", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "function", name: "image_gen.imagegen", parameters: {} },
          { type: "image_generation" },
          { type: "web_search" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: { type: string; name?: string }[] };

    // Hosted image_generation dropped; the declared client tool wins and unrelated hosted tools stay.
    expect(body.tools).toHaveLength(2);
    expect(body.tools.some(t => t.type === "image_generation")).toBe(false);
    expect(body.tools.some(t => t.type === "function" && t.name === "image_gen__imagegen")).toBe(true);
    expect(body.tools.some(t => t.type === "web_search")).toBe(true);
  });

  test("keyed platform flattens an image_gen namespace and removes the hosted duplicate", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          {
            type: "namespace",
            name: "image_gen",
            description: "Client image tools",
            tools: [{
              type: "function",
              name: "imagegen",
              description: "Generate or edit an image",
              parameters: { type: "object", properties: { prompt: { type: "string" } } },
              strict: true,
            }],
          },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      name: "image_gen__imagegen",
      description: "Generate or edit an image",
      parameters: { type: "object", properties: { prompt: { type: "string" } } },
      strict: true,
    });
  });

  test("keyed platform rewrites a forced image-gen tool choice with its declared alias", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [{
          type: "namespace",
          name: "image_gen",
          tools: [{ type: "function", name: "imagegen", parameters: {} }],
        }],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tool_choice: { type: string; name: string };
    };

    expect(body.tool_choice).toEqual({ type: "function", name: "image_gen__imagegen" });
  });

  test("keyed platform rewrites image-gen entries in an allowed-tools choice", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [{
          type: "additional_tools",
          tools: [{ type: "function", name: "image_gen.imagegen", parameters: {} }],
        }],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "function", name: "image_gen.imagegen" },
            { type: "function", name: "exec_command" },
          ],
        },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tool_choice: { type: string; mode: string; tools: Array<{ type: string; name: string }> };
    };

    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "function", name: "image_gen__imagegen" },
        { type: "function", name: "exec_command" },
      ],
    });
  });

  test("keyed responses-lite flattens a nested namespace without requiring a hosted tool", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "namespace",
                name: "image_gen",
                tools: [{ type: "function", name: "imagegen", parameters: { type: "object" } }],
              },
              { type: "web_search" },
            ],
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ type: string; role?: string; tools?: Array<{ type: string; name?: string }> }>;
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    // Preserve the input entry and unrelated tools while lowering the private namespace.
    expect(additionalTools).toBeDefined();
    expect(additionalTools?.role).toBe("developer");
    expect(additionalTools?.tools?.some(t => t.type === "namespace")).toBe(false);
    expect(additionalTools?.tools?.some(t =>
      t.type === "function" && t.name === "image_gen__imagegen"
    )).toBe(true);
    expect(additionalTools?.tools?.some(t => t.type === "web_search")).toBe(true);
    expect(body.input.some(item => item.type === "message")).toBe(true);
  });

  test("keyed responses-lite detects image_gen conflicts across top-level and nested tool groups", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        tools: [
          { type: "image_generation" },
          { type: "web_search" },
        ],
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [{ type: "function", name: "image_gen.imagegen", parameters: {} }],
          },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      input: Array<{ type: string; tools?: Array<{ type: string; name?: string }> }>;
      tool_choice?: { type: string; name?: string };
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    // The platform validates one merged namespace even when declarations use different groups.
    expect(body.tools.some(t => t.type === "image_generation")).toBe(false);
    expect(body.tools.some(t => t.type === "web_search")).toBe(true);
    expect(additionalTools?.tools?.some(t => t.name === "image_gen__imagegen")).toBe(true);
  });

  test("keyed platform encodes native and legacy image-gen calls for upstream replay", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        tools: [{
          type: "namespace",
          name: "image_gen",
          tools: [{ type: "function", name: "imagegen", parameters: {} }],
        }],
        input: [
          {
            type: "function_call",
            namespace: "image_gen",
            name: "imagegen",
            call_id: "call_native",
            arguments: "{}",
          },
          {
            type: "function_call",
            name: "image_gen.imagegen",
            call_id: "call_legacy",
            arguments: "{}",
          },
          { type: "function_call", name: "exec_command", call_id: "call_other", arguments: "{}" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ name?: string; namespace?: string }>;
    };

    expect(body.input[0]).toMatchObject({ name: "image_gen__imagegen", call_id: "call_native" });
    expect(body.input[0]).not.toHaveProperty("namespace");
    expect(body.input[1]).toMatchObject({ name: "image_gen__imagegen", call_id: "call_legacy" });
    expect(body.input[2]).toMatchObject({ name: "exec_command", call_id: "call_other" });
  });

  test("keyed responses normalization is idempotent and deduplicates image-gen aliases", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const firstRequest = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        tools: [{
          type: "namespace",
          name: "image_gen",
          tools: [{ type: "function", name: "imagegen", parameters: { type: "object" } }],
        }],
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "function", name: "image_gen.imagegen", parameters: { type: "object" } },
            { type: "web_search" },
          ],
        }],
      },
    }, meta);
    const firstBody = JSON.parse(firstRequest.body) as {
      tools: Array<{ type: string; name?: string }>;
      input: Array<{ type: string; tools?: Array<{ type: string; name?: string }> }>;
    };

    expect(firstBody.tools).toEqual([
      { type: "function", name: "image_gen__imagegen", parameters: { type: "object" } },
    ]);
    expect(firstBody.input[0]?.tools).toEqual([{ type: "web_search" }]);

    const secondRequest = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: firstBody,
    }, meta);
    expect(JSON.parse(secondRequest.body)).toEqual(firstBody);
  });

  test("keyed platform preserves unrelated and malformed namespaces", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          {
            type: "namespace",
            name: "web",
            tools: [{ type: "function", name: "run", parameters: {} }],
          },
          { type: "image_generation" },
        ],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<Record<string, unknown>>;
      tool_choice: { type: string; name: string };
    };

    expect(body.tools).toEqual([
      { type: "namespace", name: "image_gen", tools: [] },
      {
        type: "namespace",
        name: "web",
        tools: [{ type: "function", name: "run", parameters: {} }],
      },
      { type: "image_generation" },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", name: "image_gen.imagegen" });
  });

  test("configured model removes an empty image_gen namespace and preserves hosted image generation", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        tools: [{ type: "image_generation" }],
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "namespace", name: "image_gen", tools: [] },
            { type: "web_search" },
          ],
        }],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      input: Array<{ type: string; tools?: Array<{ type: string; name?: string }> }>;
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(additionalTools?.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  test("an inherited Object.prototype key is not read as a preference", () => {
    // `provider.modelPreferHostedTools?.[modelId]` walked the prototype chain, so a
    // routed model literally named `constructor` or `toString` yielded a function
    // and threw on `.includes` before the request was ever dispatched.
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    for (const inheritedKey of ["constructor", "toString", "hasOwnProperty"]) {
      const request = adapter.buildRequest({
        modelId: inheritedKey,
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: {
          model: inheritedKey,
          tools: [{ type: "image_generation" }],
          tool_choice: { type: "function", name: "image_gen.imagegen" },
        },
      }, meta);
      const body = JSON.parse(request.body) as { tool_choice: unknown };
      // Unconfigured model: ordinary normalization applies, the hosted preference does not.
      expect(body.tool_choice).toEqual({ type: "function", name: "image_gen.imagegen" });
    }
  });

  test("multi-container stripping restores hosted image generation exactly once", () => {
    // Stripping runs over every container. Restoration must not: tool declarations are
    // request-scoped, and `hasHostedImageGenDeclaration` treats a declaration in any
    // container as covering the request. #924 briefly restored into each stripped
    // container and put `image_generation` on the wire twice; this asserts against both
    // that and the original defect of losing the capability entirely.
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [{ type: "namespace", name: "image_gen", tools: [] }, { type: "web_search" }],
          },
          {
            type: "additional_tools",
            role: "developer",
            tools: [{ type: "namespace", name: "image_gen", tools: [] }],
          },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ type: string; tools?: Array<{ type: string }> }>;
    };
    const containers = body.input.filter(item => item.type === "additional_tools");

    expect(containers).toHaveLength(2);
    const hostedDeclarations = containers.flatMap(container =>
      (container.tools ?? []).filter(tool => tool.type === "image_generation"));
    // Exactly one hosted declaration on the wire, riding the first stripped container
    // so the capability is neither lost nor duplicated.
    expect(hostedDeclarations).toEqual([{ type: "image_generation" }]);
    expect(containers[0].tools).toContainEqual({ type: "image_generation" });
  });

  test("configured model rewrites a custom image-gen selector", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [],
        tools: [
          { type: "custom", name: "image_gen.render" },
          { type: "image_generation" },
        ],
        tool_choice: { type: "custom", name: "image_gen.render" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      tool_choice: { type: string };
    };

    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  test("configured model retains a hosted declaration for a wrapper-only selector", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [],
        tools: [{ type: "namespace", name: "image_gen", tools: [] }],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      tool_choice: { type: string };
    };

    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  test("configured model retains hosted image generation without a forced selector", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });

    for (const toolChoice of ["auto", "none", undefined] as const) {
      const request = adapter.buildRequest({
        modelId: "provider-image-model",
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: {
          model: "provider-image-model",
          input: [],
          tools: [{ type: "namespace", name: "image_gen", tools: [] }],
          ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
        },
      }, meta);
      const body = JSON.parse(request.body) as {
        tools: Array<{ type: string }>;
        tool_choice?: string;
      };

      expect(body.tools).toEqual([{ type: "image_generation" }]);
      expect(body.tool_choice).toBe(toolChoice);
    }
  });

  test("configured model retains a hosted declaration in wrapper-only additional tools", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        tools: [],
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "namespace", name: "image_gen", tools: [] }],
        }],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ type: string; tools?: Array<{ type: string }> }>;
      tool_choice: { type: string };
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    expect(additionalTools?.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  test("configured model restores hosted image generation in unforced additional tools", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        tools: [],
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "namespace", name: "image_gen", tools: [] }],
        }],
        tool_choice: "auto",
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      input: Array<{ type: string; tools?: Array<{ type: string }> }>;
      tool_choice: string;
    };
    const additionalTools = body.input.find(item => item.type === "additional_tools");

    expect(additionalTools?.tools).toEqual([{ type: "image_generation" }]);
    expect(body.tool_choice).toBe("auto");
  });

  test("configured model retains unrelated allowed-tools selector entries", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          { type: "image_generation" },
          { type: "function", name: "exec_command", parameters: {} },
        ],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "function", name: "image_gen.imagegen" },
            { type: "function", name: "exec_command" },
          ],
        },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string; name?: string }>;
      tool_choice?: { type: string; mode: string; tools: Array<{ type: string; name?: string }> };
    };

    expect(body.tools).toEqual([
      { type: "image_generation" },
      { type: "function", name: "exec_command", parameters: { type: "object" } },
    ]);
    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "image_generation" },
        { type: "function", name: "exec_command" },
      ],
    });
  });

  test("configured model rewrites custom image-gen entries in an allowed-tools selector", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model",
        input: [],
        tools: [
          { type: "custom", name: "image_gen.render" },
          { type: "image_generation" },
          { type: "custom", name: "exec_command" },
        ],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "custom", name: "image_gen.render" },
            { type: "custom", name: "exec_command" },
          ],
        },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string; name?: string }>;
      tool_choice: { type: string; mode: string; tools: Array<{ type: string; name?: string }> };
    };

    expect(body.tools).toEqual([
      { type: "image_generation" },
      { type: "custom", name: "exec_command" },
    ]);
    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "image_generation" },
        { type: "custom", name: "exec_command" },
      ],
    });
  });

  test("hosted-tool preference stays scoped to its configured model", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "other-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "other-model",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([
      { type: "namespace", name: "image_gen", tools: [] },
      { type: "image_generation" },
    ]);
  });

  test("hosted-tool preference uses the exact model id", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "provider-image-model:variant",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-image-model:variant",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([
      { type: "namespace", name: "image_gen", tools: [] },
      { type: "image_generation" },
    ]);
  });

  test("hosted-tool preference honors an OpenAI virtual model's selected id", () => {
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "gpt-5.6-sol-pro": ["image_generation"] },
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      _openAiVirtualSelectedModelId: "gpt-5.6-sol-pro",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "namespace", name: "image_gen", tools: [] },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([{ type: "image_generation" }]);
  });

  test("keyed platform preserves hosted image_generation for replay-only image-gen calls", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        tools: [{ type: "image_generation" }],
        input: [{
          type: "function_call",
          namespace: "image_gen",
          name: "imagegen",
          call_id: "call_replay",
          arguments: "{}",
        }],
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string }>;
      input: Array<{ name?: string; namespace?: string }>;
    };

    expect(body.tools).toEqual([{ type: "image_generation" }]);
    expect(body.input[0]).toMatchObject({
      type: "function_call",
      name: "image_gen__imagegen",
      call_id: "call_replay",
    });
    expect(body.input[0]).not.toHaveProperty("namespace");
  });

  test("keyed platform preserves hosted image_generation for a bare image_gen function", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "function", name: "image_gen", parameters: {} },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([
      { type: "function", name: "image_gen", parameters: { type: "object" } },
      { type: "image_generation" },
    ]);
  });

  test("keyed platform keeps hosted image_generation when no conflicting tool is declared", () => {
    const adapter = createResponsesPassthroughAdapter(keyedProvider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [],
        tools: [
          { type: "function", name: "shell", parameters: {} },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: { type: string }[] };

    expect(body.tools).toHaveLength(2);
    expect(body.tools.some(t => t.type === "image_generation")).toBe(true);
  });

  test("forward backend preserves the private image_gen namespace and hosted tool", () => {
    // The ChatGPT backend understands the private namespace; lowering it would change native behavior.
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [],
        tools: [
          {
            type: "namespace",
            name: "image_gen",
            tools: [{ type: "function", name: "imagegen", parameters: {} }],
          },
          { type: "image_generation" },
        ],
        tool_choice: { type: "function", name: "image_gen.imagegen" },
      },
    }, meta);
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string; name?: string; tools?: Array<{ name?: string }> }>;
      tool_choice: { type: string; name: string };
    };

    expect(body.tools).toHaveLength(2);
    expect(body.tools.some(t => t.type === "image_generation")).toBe(true);
    expect(body.tools.some(t =>
      t.type === "namespace"
      && t.name === "image_gen"
      && t.tools?.some(inner => inner.name === "imagegen")
    )).toBe(true);
    expect(body.tool_choice).toEqual({ type: "function", name: "image_gen.imagegen" });
  });
});

describe("OpenAI Responses forward-mode unsupported param stripping", () => {
  const meta = { headers: new Headers({ authorization: "Bearer token" }) };
  const rawBody = {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
    stream: true,
    store: false,
    max_output_tokens: 32000,
    metadata: { user_id: "u-1" },
    reasoning: { effort: "low" },
  };

  test("forward mode strips max_output_tokens and metadata", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { ...rawBody },
    }, meta);
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("metadata");
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.model).toBe("gpt-5.6-sol");
  });

  test("forward mode is a no-op when neither field is present", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const { max_output_tokens: _m, metadata: _d, ...codexBody } = rawBody;
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { ...codexBody },
    }, meta);
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.store).toBe(false);
  });

  test("key-auth mode preserves max_output_tokens and metadata", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.example/v1",
      authMode: "key",
      apiKey: "sk-test",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { ...rawBody },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body.max_output_tokens).toBe(32000);
    expect(body.metadata).toEqual({ user_id: "u-1" });
  });
});
