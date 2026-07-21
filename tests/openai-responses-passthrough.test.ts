import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { sanitizeEncryptedContentInPlace } from "../src/server/responses";

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.example/backend-api/codex",
  authMode: "forward" as const,
};

describe("OpenAI Responses passthrough sanitization", () => {
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

describe("OpenAI Responses keyed-mode URL construction", () => {
  const meta = { headers: new Headers({ authorization: "Bearer token" }) };

  test("Ark /api/plan/v3 baseUrl builds /v3/responses (not /v3/v1/responses)", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      authMode: "key" as const,
      apiKey: "sk-test",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input: "hi" },
    }, meta);

    expect(request.url).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/responses");
  });

  test("OpenAI /v1 baseUrl still builds /v1/responses (backward compat)", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.example/v1",
      authMode: "key" as const,
      apiKey: "sk-test",
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.5", input: "hi" },
    }, meta);

    expect(request.url).toBe("https://api.openai.example/v1/responses");
  });
});
