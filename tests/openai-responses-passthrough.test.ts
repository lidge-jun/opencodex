import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { sanitizeEncryptedContentInPlace } from "../src/server/responses";

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.example/backend-api/codex",
  authMode: "forward" as const,
};

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

describe("OpenAI Responses passthrough sanitization", () => {
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

  test("keyed platform strips hosted image_generation that collides with a declared image_gen.imagegen tool", () => {
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
    expect(body.tools.some(t => t.type === "function" && t.name === "image_gen.imagegen")).toBe(true);
    expect(body.tools.some(t => t.type === "web_search")).toBe(true);
  });

  test("keyed platform strips hosted image_generation when the skill is declared as an image_gen namespace tool", () => {
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
          { type: "namespace", name: "image_gen" },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: { type: string; name?: string }[] };

    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ type: "namespace", name: "image_gen" });
    expect(body.tools.some(t => t.type === "image_generation")).toBe(false);
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

  test("forward backend preserves the image_generation + image_gen.imagegen pair", () => {
    // The ChatGPT backend tolerates the pair; stripping there would disable native imagegen.
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
          { type: "function", name: "image_gen.imagegen", parameters: {} },
          { type: "image_generation" },
        ],
      },
    }, meta);
    const body = JSON.parse(request.body) as { tools: { type: string; name?: string }[] };

    expect(body.tools).toHaveLength(2);
    expect(body.tools.some(t => t.type === "image_generation")).toBe(true);
    expect(body.tools.some(t => t.type === "function" && t.name === "image_gen.imagegen")).toBe(true);
  });
});
