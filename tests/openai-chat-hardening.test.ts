import { afterEach, describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { stripResponsesOnlyEncryptedMarker } from "../src/adapters/responses-tool-schema";
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
  // Heartbeats are invisible downstream: the bridge consumes them to re-arm its stall
  // watchdog and emits nothing. Dropping them here keeps these assertions about the wire
  // the client actually sees.
  for await (const event of stream) if (event.type !== "heartbeat") events.push(event);
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

describe("openai-chat request hardening", () => {
  test("strips Responses-only encrypted annotations without changing schema names or literal values", () => {
    const parameters = {
      type: "object",
      properties: {
        encrypted: { type: "boolean", description: "A legitimate tool argument name" },
        message: { type: "string", encrypted: true },
        nested: {
          type: "object",
          properties: { value: { type: "string", encrypted: false } },
        },
        literalData: {
          type: "object",
          const: { encrypted: true },
          default: { encrypted: false },
          enum: [{ encrypted: true }],
          examples: [{ encrypted: false }],
        },
      },
      patternProperties: { encrypted: { type: "string", encrypted: true } },
      $defs: { encrypted: { type: "number", encrypted: true } },
      definitions: { encrypted: { type: "integer", encrypted: false } },
      dependencies: { encrypted: ["message"], other: { type: "object", encrypted: true } },
      dependentSchemas: { encrypted: { type: "string", encrypted: true } },
      dependentRequired: { encrypted: ["message"] },
      propertiesWithSpecialName: { type: "object", properties: { ["__proto__"]: { type: "string", encrypted: true } } },
      required: ["message", "encrypted"],
    };
    const before = structuredClone(parameters);
    const request = createOpenAIChatAdapter(provider()).buildRequest({
      ...parsed(),
      context: {
        messages: [{ role: "user", content: "delegate", timestamp: 0 }],
        tools: [{
          name: "spawn_agent",
          namespace: "collaboration",
          description: "Spawn a child agent",
          parameters,
        }],
      },
    });
    const body = JSON.parse(request.body) as {
      tools: Array<{ function: { parameters: Record<string, unknown> } }>;
    };

    expect(body.tools[0].function.parameters).toEqual({
      type: "object",
      properties: {
        encrypted: { type: "boolean", description: "A legitimate tool argument name" },
        message: { type: "string" },
        nested: {
          type: "object",
          properties: { value: { type: "string" } },
        },
        literalData: {
          type: "object",
          const: { encrypted: true },
          default: { encrypted: false },
          enum: [{ encrypted: true }],
          examples: [{ encrypted: false }],
        },
      },
      patternProperties: { encrypted: { type: "string" } },
      $defs: { encrypted: { type: "number" } },
      definitions: { encrypted: { type: "integer" } },
      dependencies: { encrypted: ["message"], other: { type: "object" } },
      dependentSchemas: { encrypted: { type: "string" } },
      dependentRequired: { encrypted: ["message"] },
      propertiesWithSpecialName: { type: "object", properties: { ["__proto__"]: { type: "string" } } },
      required: ["message", "encrypted"],
    });
    expect(parameters).toEqual(before);
  });

  test("a deeply nested schema is stripped without exhausting the stack", () => {
    // The schema is caller-supplied, so its depth is attacker-influenced: a recursive walk
    // would take the request path down with a stack overflow instead of answering.
    const depth = 50_000;
    const root: Record<string, unknown> = { type: "object", encrypted: true };
    let cursor = root;
    for (let i = 0; i < depth; i++) {
      const child: Record<string, unknown> = { type: "object", encrypted: true };
      cursor.properties = { encrypted: child };
      cursor = child;
    }
    cursor.leaf = { type: "string", encrypted: true };

    const stripped = stripResponsesOnlyEncryptedMarker(root) as Record<string, unknown>;
    expect(stripped.encrypted).toBeUndefined();
    let walk = stripped;
    for (let i = 0; i < depth; i++) {
      // Each level keeps the property literally named `encrypted` and drops the keyword.
      walk = (walk.properties as Record<string, Record<string, unknown>>).encrypted;
      expect(walk.encrypted).toBeUndefined();
      expect(walk.type).toBe("object");
    }
    expect((walk.leaf as Record<string, unknown>).encrypted).toBeUndefined();
  });
});

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
    for (const [toolCalls, message] of [
      [{ unexpected: true }, "upstream response contained invalid tool calls (tool_calls_not_array; valueType=object)"],
      [[null], "upstream response contained invalid tool calls (tool_call_not_object; callIndex=0; valueType=null)"],
      [[{ id: "call_missing_function" }], "upstream response contained invalid tool calls (tool_call_function_not_object; callIndex=0; valueType=undefined)"],
    ] as const) {
      const events = await adapter.parseResponse!(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", tool_calls: toolCalls } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      })));
      expect(events).toEqual([{
        type: "error",
        status: 502,
        errorType: "upstream_error",
        message,
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

    expect(events).toEqual([{
      type: "error",
      status: 502,
      errorType: "upstream_error",
      message: "upstream response contained invalid tool calls (tool_call_function_arguments_invalid; callIndex=0; valueType=object)",
    }]);
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
    for (const [toolCalls, message] of [
      [{ unexpected: true }, "upstream response contained invalid tool calls (tool_calls_not_array; valueType=object)"],
      [[null], "upstream response contained invalid tool calls (tool_call_not_object; callIndex=0; valueType=null)"],
    ] as const) {
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
        status: 502,
        errorType: "upstream_error",
        message,
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
    expect(events).toEqual([{
      type: "error",
      status: 502,
      errorType: "upstream_error",
      message: "upstream response contained invalid tool calls (tool_call_not_object; callIndex=1; valueType=null)",
    }]);
    const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
    expect(lines).toContain('"mode":"stream"');
    expect(lines).toContain('"reason":"tool_call_not_object"');
    expect(lines).toContain('"callIndex":1');
    expect(lines).toContain('"valueType":"null"');
    expect(lines).not.toContain(privateName);
    expect(lines).not.toContain("private arguments");
  });

  test("debug mode skips accepted null padding and blames the real malformed delta (#1731)", async () => {
    process.env.OCX_DEBUG = "1";
    const adapter = createOpenAIChatAdapter(provider());
    const response = new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: null, function: { name: null, arguments: null } },
        null,
      ] } }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));

    const events = await collect(adapter.parseStream(response));
    expect(events).toEqual([{
      type: "error",
      status: 502,
      errorType: "upstream_error",
      message: "upstream response contained invalid tool calls (tool_call_not_object; callIndex=1; valueType=null)",
    }]);
    const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
    // The null-padded continuation delta at index 0 is accepted by the accumulator, so the
    // diagnostic must point at index 1 rather than claiming the padding was the defect.
    expect(lines).toContain('"reason":"tool_call_not_object"');
    expect(lines).toContain('"callIndex":1');
    expect(lines).not.toContain('"tool_call_function_name_invalid"');
  });

  // Some OpenAI-compatible streamers repeat an already-sent field as a non-string placeholder
  // instead of null. Before #2155 that killed the whole turn with a 502 even though the value
  // being repeated was already held in canonical form, so the tool never ran.
  test("a non-string repeat is padding once that field has string provenance (#2155)", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const response = new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_a", function: { name: "shell", arguments: "" } },
      ] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: { padding: true }, function: { name: { padding: true }, arguments: { padding: true } } },
      ] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: "{}" } },
      ] } }] })}\n\n`,
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""));

    const events = await collect(adapter.parseStream(response));
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "tool_call_start", id: "call_a", name: "shell" });
    expect(events).toContainEqual({ type: "tool_call_delta", arguments: "{}" });
  });

  // Tolerance is per field. A canonical NAME is not evidence that `arguments` was ever sent
  // as a string, and accepting a malformed object here would silently discard an argument
  // payload the model meant to send.
  test("a canonical name does not authorize a malformed arguments value (#2155)", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const response = new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_a", function: { name: "shell" } },
      ] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: { bad: true } } },
      ] } }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));

    expect(await collect(adapter.parseStream(response))).toEqual([{
      type: "error",
      status: 502,
      errorType: "upstream_error",
      message: "upstream response contained invalid tool calls (tool_call_function_arguments_invalid; callIndex=0; valueType=object)",
    }]);
  });

  test("a malformed id stays terminal until that call has a canonical id (#2155)", async () => {
    const adapter = createOpenAIChatAdapter(provider());
    const response = new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, function: { name: "shell", arguments: "{}" } },
      ] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: { bad: true } },
      ] } }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));

    expect(await collect(adapter.parseStream(response))).toEqual([{
      type: "error",
      status: 502,
      errorType: "upstream_error",
      message: "upstream response contained invalid tool calls (tool_call_id_invalid; callIndex=0; valueType=object)",
    }]);
  });

  // The reason the diagnostic is passed from the rejection site rather than rescanned: a
  // stateless rescan stops at the first structurally odd value, which here is the ACCEPTED
  // padding on call 0, and would blame the wrong call for the real defect on call 1.
  test("parallel calls blame the unresolved call, not the accepted padding (#2155)", async () => {
    process.env.OCX_DEBUG = "1";
    const adapter = createOpenAIChatAdapter(provider());
    const response = new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_a", function: { name: "alpha", arguments: "" } },
        { index: 1, id: "call_b", function: { name: "beta" } },
      ] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: { padding: true } } },
        { index: 1, function: { arguments: { bad: true } } },
      ] } }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));

    expect(await collect(adapter.parseStream(response))).toEqual([{
      type: "error",
      status: 502,
      errorType: "upstream_error",
      message: "upstream response contained invalid tool calls (tool_call_function_arguments_invalid; callIndex=1; valueType=object)",
    }]);
    const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
    expect(lines).toContain('"callIndex":1');
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

  test("an exact model capability authorizes canonical Fast only for that Chat model", () => {
    const exactOnly = provider({ modelSupportsServiceTier: { "test-model": true } });
    const authorized = parsed();
    authorized.options.serviceTier = "priority";
    expect(JSON.parse(createOpenAIChatAdapter(exactOnly).buildRequest(authorized).body).service_tier)
      .toBe("priority");

    const undeclared = parsed();
    undeclared.modelId = "other-model";
    undeclared.options.serviceTier = "priority";
    expect(JSON.parse(createOpenAIChatAdapter(exactOnly).buildRequest(undeclared).body))
      .not.toHaveProperty("service_tier");

    const foreign = parsed();
    foreign.options.serviceTier = "flex";
    expect(JSON.parse(createOpenAIChatAdapter(exactOnly).buildRequest(foreign).body))
      .not.toHaveProperty("service_tier");

    const providerDenied = provider({
      supportsServiceTier: false,
      modelSupportsServiceTier: { "test-model": true },
    });
    expect(JSON.parse(createOpenAIChatAdapter(providerDenied).buildRequest(authorized).body))
      .not.toHaveProperty("service_tier");
  });

  // Foreign `service_tier` values are OpenAI-specific extensions and this adapter serves 66
  // registry providers, several of which reject unknown body fields. Classified canonical Fast
  // is handled separately by capability; an unclassified caller still needs this opt-in.
  test("drops a foreign caller service tier when the provider has not opted in", () => {
    for (const p of [provider(), provider({ chatServiceTier: false })]) {
      const req = parsed();
      req.options.serviceTier = "flex";

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

  // The native Chat ingress reads the same provider option and must draw the same
  // boundary. It used to match through modelInList, so a `<listed>:<tag>` sibling
  // lost response_format on this wire while keeping it on Responses.
  describe("native chat passthrough draws the same exact boundary", () => {
    const passthrough = (modelId: string, noStructuredOutputModels: string[]) =>
      JSON.parse(buildOpenAIChatPassthroughRequest(
        provider({ noStructuredOutputModels }),
        { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } },
        modelId,
        false,
      ).body as string) as Record<string, unknown>;

    test("omits response_format for the exact listed id", () => {
      expect(passthrough("test-model", ["test-model"]).response_format).toBeUndefined();
    });

    test("keeps response_format for a :tag sibling the operator never listed", () => {
      expect(passthrough("test-model:structured", ["test-model"]).response_format)
        .toEqual({ type: "json_object" });
    });

    test("listing the full :tag id opts that id out", () => {
      expect(passthrough("test-model:structured", ["test-model:structured"]).response_format)
        .toBeUndefined();
    });

    test("leaves an unrelated model untouched", () => {
      expect(passthrough("supported-model", ["test-model"]).response_format)
        .toEqual({ type: "json_object" });
    });
  });

// Tool-call deltas are BUFFERED until a terminal signal, so this adapter can consume upstream
// frames for a long time while yielding nothing downstream. The Responses bridge arms its
// stall watchdog on ADAPTER activity, not socket activity, so a model streaming a large
// argument payload was indistinguishable from a hung upstream.
//
// Found while investigating #2156 but deliberately NOT claimed as its fix: a stall abort
// emits `response.incomplete` with `upstream_stall_timeout`, while that report shows the
// adapter's own EOF error with tool calls still pending. This pins the mechanism only.
test("tool-call deltas emit heartbeats so a long buffering phase is not read as a stall", async () => {
  const adapter = createOpenAIChatAdapter(provider());
  const frames = ['data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "shell", arguments: "" } }] } }] }) + '\n\n'];
  // Many argument chunks and nothing else: exactly the shape that looked like silence.
  for (let i = 0; i < 12; i += 1) {
    frames.push('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"' } }] } }] }) + '\n\n');
  }
  frames.push('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n', "data: [DONE]\n\n");

  const raw: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(new Response(frames.join("")))) raw.push(event);

  // One per consumed tool-call delta: the watchdog sees activity for the whole phase.
  expect(raw.filter(e => e.type === "heartbeat").length).toBeGreaterThanOrEqual(12);
  // And the client-visible wire is unchanged -- a heartbeat is consumed by the bridge.
  const visible = raw.filter(e => e.type !== "heartbeat");
  expect(visible.some(e => e.type === "error")).toBe(false);
  expect(visible).toContainEqual({ type: "tool_call_start", id: "call_a", name: "shell" });
  expect(visible.at(-1)).toMatchObject({ type: "done" });
});
});
