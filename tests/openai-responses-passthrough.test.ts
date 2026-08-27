import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { openaiResponsesUrl } from "../src/adapters/openai-responses-url";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { XAI_GROK_CLI_BASE_URL } from "../src/providers/xai-transport";
import { routeModel } from "../src/router";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { handleResponses, sanitizeEncryptedContentInPlace } from "../src/server/responses";
import {
  encodeCompactionSummary,
  OPAQUE_COMPACTION_NOTE,
  SUMMARY_PREFIX,
} from "../src/responses/compaction";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import type { OcxConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const provider = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward" as const,
};

test("noncanonical forward providers cannot receive caller or runtime credentials", () => {
  const userInfoUrl = new URL("https://chatgpt.com/backend-api/codex");
  userInfoUrl.username = "user";
  userInfoUrl.password = "secret";
  for (const baseUrl of [
    "https://provider.example/v1/",
    "https://chatgpt.com/backend-api/not-codex",
    "https://chatgpt.example/backend-api/codex",
    "https://chatgpt.com/backend-api/codex?target=custom",
    "https://chatgpt.com/backend-api/codex#custom",
    userInfoUrl.toString(),
  ]) {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl,
      authMode: "forward",
      headers: { "x-provider-option": "enabled" },
      _codexAccountRequired: true,
      _codexAccountOverride: {
        accessToken: "runtime-secret",
        chatgptAccountId: "runtime-account",
      },
    } as Parameters<typeof createResponsesPassthroughAdapter>[0]);
    const request = adapter.buildRequest({
      modelId: "test-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "test-model", input: "ping" },
    }, {
      headers: new Headers({
        authorization: "Bearer caller-secret",
        "chatgpt-account-id": "caller-account",
        session_id: "caller-session",
      }),
    });

    expect(request.url).toBe(`${baseUrl.replace(/\/+$/, "")}/responses`);
    expect(request.headers["x-provider-option"]).toBe("enabled");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["chatgpt-account-id"]).toBeUndefined();
    expect(request.headers.session_id).toBeUndefined();
  }
});

test("canonical forward providers normalize trailing slashes and let the pool override win", () => {
  const adapter = createResponsesPassthroughAdapter({
    ...provider,
    baseUrl: "https://chatgpt.com/backend-api/codex///",
    _codexAccountRequired: true,
    _codexAccountOverride: {
      accessToken: "runtime-secret",
      chatgptAccountId: "runtime-account",
    },
  } as Parameters<typeof createResponsesPassthroughAdapter>[0]);
  const request = adapter.buildRequest({
    modelId: "test-model",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: "test-model", input: "ping" },
  }, { headers: new Headers({ authorization: "Bearer caller-secret" }) });

  expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(request.headers.authorization).toBe("Bearer runtime-secret");
  expect(request.headers["chatgpt-account-id"]).toBe("runtime-account");
});

test("noncanonical pool-required providers use only their configured static credentials", () => {
  const adapter = createResponsesPassthroughAdapter({
    adapter: "openai-responses",
    baseUrl: "https://provider.example/v1/",
    authMode: "forward",
    headers: { authorization: "Bearer provider-static", "x-provider-option": "enabled" },
    _codexAccountRequired: true,
  } as Parameters<typeof createResponsesPassthroughAdapter>[0]);
  const request = adapter.buildRequest({
    modelId: "test-model",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: "test-model", input: "ping" },
  }, {
    headers: new Headers({
      authorization: "Bearer caller-secret",
      "chatgpt-account-id": "caller-account",
      session_id: "caller-session",
    }),
  });

  expect(request.url).toBe("https://provider.example/v1/responses");
  expect(request.headers["x-provider-option"]).toBe("enabled");
  expect(request.headers.authorization).toBe("Bearer provider-static");
  expect(request.headers["chatgpt-account-id"]).toBeUndefined();
  expect(request.headers.session_id).toBeUndefined();
});

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
      ["https://api.openai.example/v1/responses", "https://api.openai.example/v1/responses"],
      ["https://api.openai.example/v1/responses/", "https://api.openai.example/v1/responses"],
      ["https://responses", "https://responses/v1/responses"],
      ["https://v1", "https://v1/v1/responses"],
      ["https://responses:8443/v1", "https://responses:8443/v1/responses"],
      ["https://[2001:db8::1]:8443/v1", "https://[2001:db8::1]:8443/v1/responses"],
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

  test("key-auth routed Responses converts exec custom tools while native forward preserves them", () => {
    const rawBody = {
      model: "deepseek-v4-flash",
      input: "ping",
      tools: [
        { type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } },
        { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark" } },
      ],
    };
    const parsed = {
      modelId: "deepseek-v4-flash",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: rawBody,
    };
    const keyed = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.deepseek.com",
      responsesPath: "/responses",
      authMode: "key" as const,
      apiKey: "sk-test",
    });
    const keyedBody = JSON.parse(keyed.buildRequest(parsed, { headers: new Headers() }).body) as typeof rawBody;
    expect(keyedBody.tools[0]).toMatchObject({ type: "function", name: "exec" });
    expect(keyedBody.tools[1]).toMatchObject({ type: "custom", name: "apply_patch" });

    const nativeBody = JSON.parse(createResponsesPassthroughAdapter(provider).buildRequest(
      { ...parsed, modelId: "gpt-5.6-sol" },
      { headers: new Headers({ authorization: "Bearer token" }) },
    ).body) as typeof rawBody;
    expect(nativeBody.tools).toEqual(rawBody.tools);
  });

  test("xAI multi-agent clamps synthetic max and ultra efforts to its real Responses ladder", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test-key",
        },
      },
    };
    const route = routeModel(config, "xai/grok-4.20-multi-agent-0309");
    const responsesProvider = resolveWireProtocolOverride(
      "xai",
      route.modelId,
      route.provider,
      "responses",
    );

    expect(responsesProvider.adapter).toBe("openai-responses");
    for (const requested of ["max", "ultra"] as const) {
      const body = JSON.parse(createResponsesPassthroughAdapter(responsesProvider).buildRequest({
        modelId: route.modelId,
        context: { messages: [] },
        stream: true,
        options: { reasoning: requested },
        _rawBody: {
          model: route.modelId,
          input: "ping",
          reasoning: { effort: requested },
        },
      }, { headers: new Headers() }).body) as { reasoning?: { effort?: string } };

      expect(body.reasoning?.effort).toBe("xhigh");
    }
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

describe("Responses custom-tool destination capability", () => {
  test("xAI explicitly denies native custom tools and registry enrichment preserves an override", () => {
    const entry = getProviderRegistryEntry("xai")!;
    expect(entry.supportsResponsesCustomTools).toBe(false);

    const inherited = {
      adapter: entry.adapter,
      baseUrl: entry.baseUrl,
    } as Parameters<typeof enrichProviderFromRegistry>[1];
    enrichProviderFromRegistry("xai", inherited);
    expect(inherited.supportsResponsesCustomTools).toBe(false);

    const explicit = {
      adapter: entry.adapter,
      baseUrl: entry.baseUrl,
      supportsResponsesCustomTools: true,
    } as Parameters<typeof enrichProviderFromRegistry>[1];
    enrichProviderFromRegistry("xai", explicit);
    expect(explicit.supportsResponsesCustomTools).toBe(true);

    const routed = routeModel({
      port: 0,
      defaultProvider: "xai",
      providers: {
        xai: { adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: "oauth" },
      },
    } as OcxConfig, "xai/grok-4.6");
    expect(routed.provider.supportsResponsesCustomTools).toBe(false);
  });

  test("noncanonical forward destinations that deny custom tools lower apply_patch", () => {
    const rawBody = {
      model: "routed-model",
      input: [
        { type: "custom_tool_call", id: "ctc_patch", call_id: "c1", name: "apply_patch", input: "noop" },
      ],
      tools: [
        { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark" } },
      ],
    };
    const parsed = {
      modelId: "routed-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: rawBody,
    };
    const request = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://provider.example/v1",
      authMode: "forward",
      headers: { authorization: "Bearer provider-static" },
      supportsResponsesCustomTools: false,
    }).buildRequest(parsed, { headers: new Headers({ authorization: "Bearer caller-secret" }) });
    const body = JSON.parse(request.body) as {
      tools: Array<Record<string, unknown>>;
      input: Array<Record<string, unknown>>;
    };

    expect(request.headers.authorization).toBe("Bearer provider-static");
    expect(body.tools[0]).toMatchObject({ type: "function", name: "apply_patch" });
    expect(body.input[0]).toMatchObject({
      type: "function_call",
      call_id: "c1",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "noop" }),
    });
    expect([...(request.convertedRoutedCustomToolNames ?? [])]).toEqual(["apply_patch"]);
  });

  test("the canonical Codex forward surface never lowers custom tools, even with an explicit denial", () => {
    const rawBody = {
      model: "gpt-5.6-sol",
      stream: true,
      input: [
        { type: "custom_tool_call", id: "ctc_patch", call_id: "c1", name: "apply_patch", input: "noop" },
      ],
      tools: [
        { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark" } },
      ],
    };
    const parsed = {
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: rawBody,
    };
    const request = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      // Exact canonical Codex forward base URL: isCanonicalOpenAiForwardProvider is true,
      // so the lowering gate must be unreachable regardless of the capability flag.
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      headers: { authorization: "Bearer provider-static" },
      supportsResponsesCustomTools: false,
    }).buildRequest(parsed, { headers: new Headers({ authorization: "Bearer caller-secret" }) });
    const body = JSON.parse(request.body) as {
      tools: Array<Record<string, unknown>>;
      input: Array<Record<string, unknown>>;
    };

    expect(body.tools[0]).toMatchObject({ type: "custom", name: "apply_patch" });
    expect(body.input[0]).toMatchObject({ type: "custom_tool_call", call_id: "c1", name: "apply_patch" });
    expect(request.convertedRoutedCustomToolNames ?? []).toEqual([]);
  });
});

describe("routed compaction lowering order", () => {
  const baseInput = [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "earlier turn" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    },
    { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "noop" },
    { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
    {
      type: "tool_search_call",
      call_id: "c2",
      execution: "client",
      arguments: { query: "database" },
    },
    {
      type: "tool_search_output",
      call_id: "c2",
      execution: "client",
      status: "completed",
      tools: [{
        type: "function",
        name: "loaded_tool",
        defer_loading: true,
        parameters: { type: "object" },
      }],
    },
    {
      type: "function_call",
      call_id: "c3",
      namespace: "collaboration",
      name: "spawn_agent",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "c3", output: "done" },
    {
      type: "additional_tools",
      role: "developer",
      tools: [{
        type: "function",
        name: "extra",
        defer_loading: true,
        parameters: { type: "object" },
      }],
    },
  ];
  const rawBody = (compaction: boolean) => ({
    model: "routed-model",
    stream: false,
    input: [
      ...baseInput,
      ...(compaction ? [{ type: "compaction_trigger" }] : []),
    ],
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply patch",
        format: { type: "text" },
      },
      {
        type: "function",
        name: "tool_search",
        description: "Ordinary collision",
        parameters: { type: "object" },
      },
      {
        type: "tool_search",
        execution: "client",
        description: "Find tools",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        type: "namespace",
        name: "collaboration",
        tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    text: { format: { type: "json_object" } },
  });
  const loweredReplay = [
    {
      type: "function_call",
      call_id: "c1",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "noop" }),
    },
    { type: "function_call_output", call_id: "c1", output: "ok" },
    {
      type: "function_call",
      call_id: "c2",
      name: "opencodex_tool_search",
      arguments: JSON.stringify({ query: "database" }),
    },
    {
      type: "function_call_output",
      call_id: "c2",
      output: JSON.stringify({
        tools: [{
          type: "function",
          name: "loaded_tool",
          defer_loading: true,
          parameters: { type: "object" },
        }],
        status: "completed",
      }),
    },
    {
      type: "function_call",
      call_id: "c3",
      name: "collaboration__spawn_agent",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "c3", output: "done" },
  ];
  const loweredTools = [
    {
      type: "function",
      name: "apply_patch",
      description: "Apply patch",
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Raw input for this client-executed custom tool.",
          },
        },
        required: ["input"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "tool_search",
      description: "Ordinary collision",
      parameters: { type: "object" },
    },
    {
      type: "function",
      description: "Find tools",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      name: "opencodex_tool_search",
    },
    {
      type: "function",
      name: "collaboration__spawn_agent",
      parameters: { type: "object" },
    },
    { type: "function", name: "loaded_tool", parameters: { type: "object" } },
  ];

  function build(compaction: boolean) {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://gateway.example/v1",
      authMode: "key",
      apiKey: "test-key",
      supportsResponsesCustomTools: false,
    });
    return adapter.buildRequest({
      modelId: "routed-model",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: rawBody(compaction),
      ...(compaction ? { _compactionRequest: true } : {}),
    }, { headers: new Headers() });
  }

  test("lowers replayed calls before removing the compaction tool surface", () => {
    const built = build(true);
    const body = JSON.parse(built.body) as Record<string, unknown> & {
      input: Array<Record<string, unknown>>;
    };

    expect(body.input.slice(0, -1)).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "earlier turn" },
          { type: "input_text", text: "[image omitted for compaction]" },
        ],
      },
      ...loweredReplay,
    ]);
    expect(body.input.at(-1)).toEqual({
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: expect.stringContaining("CONTEXT CHECKPOINT COMPACTION"),
      }],
    });

    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body).not.toHaveProperty("text");
    expect(body.input.some(item => item.type === "compaction_trigger")).toBe(false);
    expect(body.input.some(item => item.type === "additional_tools")).toBe(false);
    expect(JSON.stringify(body)).not.toContain("input_image");
    expect(JSON.stringify(body)).not.toContain("data:image/png");
    expect(body.input.find(item => item.call_id === "c3")).not.toHaveProperty("namespace");

    expect([...(built.convertedRoutedCustomToolNames ?? [])]).toEqual(["apply_patch"]);
    expect([...(built.convertedRoutedToolSearchNames ?? [])]).toEqual(["opencodex_tool_search"]);
    expect([...(built.convertedRoutedNamespaceToolAliases ?? new Map()).entries()]).toEqual([
      ["collaboration__spawn_agent", { namespace: "collaboration", name: "spawn_agent", kind: "function" }],
    ]);
  });

  test("leaves the non-compaction serialized body byte-identical", () => {
    const built = build(false);
    expect(built.body).toBe(JSON.stringify({
      model: "routed-model",
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "earlier turn" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
        ...loweredReplay,
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "function", name: "extra", parameters: { type: "object" } }],
        },
      ],
      tools: loweredTools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      text: { format: { type: "json_object" } },
    }));
  });
});

describe("OpenAI Responses passthrough sanitization", () => {
  const deferredToolBody = {
    model: "routed-model",
    input: [
      {
        type: "tool_search_call",
        call_id: "call_search",
        execution: "client",
        arguments: { query: "deferred read" },
      },
      {
        type: "tool_search_output",
        call_id: "call_search",
        status: "completed",
        execution: "client",
        tools: [{
          type: "namespace",
          name: "workspace",
          description: "Workspace tools",
          tools: [{
            type: "function",
            name: "deferred_read",
            description: "Read deferred data",
            strict: false,
            defer_loading: true,
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
          }, {
            type: "function",
            name: "declared_deferred_read",
            description: "Read declared deferred data",
            defer_loading: true,
            parameters: { type: "object", properties: {}, additionalProperties: false },
          }],
        }],
      },
    ],
    tools: [
      {
        type: "namespace",
        name: "workspace",
        description: "Workspace tools",
        tools: [{
          type: "function",
          name: "upfront_read",
          description: "Read upfront data",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        }, {
          type: "function",
          name: "declared_deferred_read",
          description: "Read declared deferred data",
          defer_loading: true,
          parameters: { type: "object", properties: {}, additionalProperties: false },
        }],
      },
      {
        type: "tool_search",
        execution: "client",
        description: "Search deferred tools",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
  };

  test("routed passthrough promotes tool-search results into the active namespace", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://provider.example/v1",
      authMode: "key",
      apiKey: "test-key",
    });
    const body = JSON.parse(adapter.buildRequest({
      modelId: deferredToolBody.model,
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: deferredToolBody,
    }, { headers: new Headers() }).body) as {
      tools: Array<{
        type: string;
        name?: string;
        tools?: Array<{ name: string; defer_loading?: boolean }>;
      }>;
    };

    expect(body.tools.some(tool => tool.type === "namespace")).toBe(false);
    expect(body.tools.filter(tool => tool.name?.startsWith("workspace__")).map(tool => tool.name)).toEqual([
      "workspace__upfront_read",
      "workspace__declared_deferred_read",
      "workspace__deferred_read",
    ]);
    expect(body.tools.find(tool => tool.name === "workspace__declared_deferred_read"))
      .not.toHaveProperty("defer_loading");
    expect(body.tools.find(tool => tool.name === "workspace__deferred_read"))
      .not.toHaveProperty("defer_loading");
    expect(body.tools.find(tool => tool.name === "tool_search")).toMatchObject({
      type: "function",
      name: "tool_search",
      description: "Search deferred tools",
    });
  });

  test("noncanonical forward passthrough also lowers tool_search without caller credential relay", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://provider.example/v1",
      authMode: "forward",
      headers: { authorization: "Bearer provider-static" },
    });
    const request = adapter.buildRequest({
      modelId: deferredToolBody.model,
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: deferredToolBody,
    }, { headers: new Headers({ authorization: "Bearer caller-secret" }) });
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools.find(tool => tool.name === "tool_search")).toMatchObject({
      type: "function",
      name: "tool_search",
    });
    expect(request.headers.authorization).toBe("Bearer provider-static");
  });

  test("canonical forward passthrough leaves tool-search loading to the native backend", () => {
    const body = JSON.parse(createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: deferredToolBody.model,
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: deferredToolBody,
    }, { headers: new Headers({ authorization: "Bearer test" }) }).body) as { tools: unknown[] };

    expect(body.tools).toEqual(deferredToolBody.tools);
  });

  test("routed passthrough promotes tool-search results into Responses Lite additional tools", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://provider.example/v1",
      authMode: "key",
      apiKey: "test-key",
    });
    const { tools, ...bodyWithoutTools } = deferredToolBody;
    const rawBody = {
      ...bodyWithoutTools,
      input: [
        ...bodyWithoutTools.input,
        { type: "additional_tools", role: "developer", tools },
      ],
    };
    const body = JSON.parse(adapter.buildRequest({
      modelId: rawBody.model,
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: rawBody,
    }, { headers: new Headers() }).body) as {
      tools?: unknown[];
      input: Array<{
        type: string;
        tools?: Array<{ type: string; name?: string; tools?: Array<{ name: string }> }>;
      }>;
    };

    expect(body.tools).toBeUndefined();
    const additionalTools = body.input.find(item => item.type === "additional_tools")?.tools;
    expect(additionalTools?.some(tool => tool.type === "namespace")).toBe(false);
    expect(additionalTools?.filter(tool => tool.name?.startsWith("workspace__")).map(tool => tool.name)).toEqual([
      "workspace__upfront_read",
      "workspace__declared_deferred_read",
      "workspace__deferred_read",
    ]);
    expect(additionalTools?.find(tool => tool.name === "tool_search"))
      .toMatchObject({ type: "function", name: "tool_search" });
  });

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

  test("normalizes or omits xAI CLI root unions after namespace lowering", () => {
    const unsafeAutomationParameters = {
      oneOf: [
        {
          type: "object",
          properties: { mode: { type: "string", enum: ["view"] } },
          required: ["mode"],
        },
        {
          oneOf: [
            {
              type: "object",
              properties: { id: { type: "string" }, mode: { const: "update" } },
              required: ["id", "mode"],
            },
            {
              type: "object",
              properties: { name: { type: "string" }, mode: { const: "create" } },
              required: ["name", "mode"],
            },
          ],
        },
      ],
    };
    const safeUnionParameters = {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
      oneOf: [
        { properties: { mode: { const: "view" } } },
        { properties: { mode: { const: "delete" } } },
      ],
    };
    const namespace = {
      type: "namespace",
      name: "mcp__codex_app",
      tools: [
        { type: "function", name: "automation_update", parameters: unsafeAutomationParameters },
        { type: "function", name: "safe_union", parameters: safeUnionParameters },
        { type: "function", name: "plain", parameters: {} },
      ],
    };
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: XAI_GROK_CLI_BASE_URL,
      authMode: "oauth",
      apiKey: "xai-test",
    });
    const build = (lite: boolean) => JSON.parse(adapter.buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "grok-4.6",
        input: lite ? [{ type: "additional_tools", tools: [namespace] }] : [],
        ...(lite ? {} : { tools: [namespace] }),
      },
    }, { headers: new Headers() }).body) as {
      tools?: Array<{ name?: string; parameters?: Record<string, unknown> }>;
      input: Array<{ type: string; tools?: Array<{ name?: string; parameters?: Record<string, unknown> }> }>;
    };

    for (const lite of [false, true]) {
      const body = build(lite);
      const tools = lite ? body.input[0]?.tools : body.tools;
      expect(tools?.map(tool => tool.name)).toEqual([
        "mcp__codex_app__safe_union",
        "mcp__codex_app__plain",
      ]);
      const safe = tools?.find(tool => tool.name === "mcp__codex_app__safe_union")?.parameters;
      expect(safe).toEqual({
        type: "object",
        properties: {
          token: { type: "string" },
          // Disjoint consts, so `anyOf` describes the same set the root `oneOf` did. `mode` is
          // promoted into `required`: absent, it matched BOTH branches, which `oneOf` rejects.
          mode: { anyOf: [{ const: "view" }, { const: "delete" }] },
        },
        required: ["token", "mode"],
      });
      expect(tools?.find(tool => tool.name === "mcp__codex_app__plain")?.parameters)
        .toEqual({ type: "object" });
    }
  });

  test("reconciles tool_choice against tools the xAI CLI schema policy omitted", () => {
    // `oneOf` branches that disagree on which property names exist cannot be flattened, so this
    // function is dropped. Namespace lowering already rewrote both the declaration and the
    // selector to wire names, so the selector is left pointing at a tool that no longer ships.
    const unsafe = {
      oneOf: [
        { type: "object", properties: { mode: { const: "view" } }, required: ["mode"] },
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      ],
    };
    const namespace = {
      type: "namespace",
      name: "mcp__codex_app",
      tools: [
        { type: "function", name: "automation_update", parameters: unsafe },
        { type: "function", name: "plain", parameters: {} },
      ],
    };
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: XAI_GROK_CLI_BASE_URL,
      authMode: "oauth",
      apiKey: "xai-test",
    });
    const build = (toolChoice: unknown) => adapter.buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "grok-4.6", input: [], tools: [namespace], tool_choice: toolChoice },
    }, { headers: new Headers() });

    // A forced selection has no safe replacement: relaxing it to auto would quietly run the turn
    // without the tool the caller required, so this fails locally instead of reaching Grok.
    expect(() => build({ type: "function", name: "mcp__codex_app__automation_update" }))
      .toThrow(/tool_choice requires function "mcp__codex_app__automation_update"/);

    // An allowed_tools list still has a usable entry, so it simply loses the omitted one.
    const narrowed = JSON.parse(build({
      type: "allowed_tools",
      mode: "auto",
      tools: [
        { type: "function", name: "mcp__codex_app__automation_update" },
        { type: "function", name: "mcp__codex_app__plain" },
      ],
    }).body) as { tool_choice: { tools: Array<{ name: string }> } };
    expect(narrowed.tool_choice.tools).toEqual([{ type: "function", name: "mcp__codex_app__plain" }]);

    // Nothing left to point at is the forced case again.
    expect(() => build({
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "function", name: "mcp__codex_app__automation_update" }],
    })).toThrow(/tool_choice requires function/);

    // A selector naming a surviving tool is untouched.
    const kept = JSON.parse(build({ type: "function", name: "mcp__codex_app__plain" }).body) as {
      tool_choice: unknown;
    };
    expect(kept.tool_choice).toEqual({ type: "function", name: "mcp__codex_app__plain" });
  });

  test("keeps native root unions on public xAI Responses", () => {
    const parameters = {
      oneOf: [
        { type: "object", properties: { mode: { const: "view" } } },
        { oneOf: [{ type: "object", properties: {} }, { type: "object", properties: {} }] },
      ],
    };
    const request = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      authMode: "key",
      apiKey: "xai-test",
    }).buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "grok-4.6",
        input: [],
        tools: [{ type: "function", name: "automation_update", parameters }],
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as {
      tools: Array<{ parameters: Record<string, unknown> }>;
    };

    expect(body.tools[0]?.parameters).toEqual({ ...parameters, type: "object" });
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

  function routedXaiResponsesProvider() {
    const entry = getProviderRegistryEntry("xai")!;
    const route = routeModel({
      port: 0,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: entry.adapter,
          baseUrl: entry.baseUrl,
          authMode: "key",
          apiKey: "xai-test-key",
          modelAdapters: { "grok-4.6": "openai-responses" },
        },
      },
    } as OcxConfig, "xai/grok-4.6");
    return resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  }

  test("xAI verbosity opt-out strips verbosity but preserves sibling text settings", () => {
    const provider = routedXaiResponsesProvider();
    expect(provider.modelSupportsVerbosity?.["grok-4.6"]).toBe(false);
    expect(provider.adapter).toBe("openai-responses");

    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "grok-4.6",
        input: [],
        reasoning: { effort: "high" },
        text: { verbosity: "high", format: { type: "json_object" } },
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body.text).toEqual({ format: { type: "json_object" } });
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  test("xAI verbosity opt-out removes an emptied text object", () => {
    const request = createResponsesPassthroughAdapter(routedXaiResponsesProvider()).buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "grok-4.6", input: [], text: { verbosity: "low" } },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body).not.toHaveProperty("text");
  });

  test("unclassified Responses destinations preserve text verbosity", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://compat.example.test/v1",
      authMode: "key",
      apiKey: "sk-test",
    });
    const request = adapter.buildRequest({
      modelId: "other-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "other-model", input: [], text: { verbosity: "medium" } },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body.text).toEqual({ verbosity: "medium" });
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

  test("backfills queries on a replayed single-query web_search_call (#930)", () => {
    // The bridge fix only helps items created after it. A conversation that already
    // recorded {type:"search", query:"..."} replays that stored item every turn, and
    // DeepSeek's parser rejects the whole request over it — so upgrading alone would
    // leave those threads permanently broken.
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "provider-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "provider-model",
        input: [
          { type: "web_search_call", id: "ws_legacy", status: "completed", action: { type: "search", query: "legacy" } },
          { type: "web_search_call", id: "ws_batch", status: "completed", action: { type: "search", queries: ["a", "b"] } },
          { type: "web_search_call", id: "ws_other", status: "completed", action: { type: "open_page", url: "https://example.test" } },
        ],
      },
    }, meta);
    const input = (JSON.parse(request.body) as { input: Array<{ action: Record<string, unknown> }> }).input;

    // Repaired: singular query gains the array the strict parser requires.
    expect(input[0].action).toEqual({ type: "search", query: "legacy", queries: ["legacy"] });
    // Untouched: a batch already satisfies the parser, and adding `query` would collapse
    // the native plural rendering.
    expect(input[1].action).toEqual({ type: "search", queries: ["a", "b"] });
    // Untouched: not a search action.
    expect(input[2].action).toEqual({ type: "open_page", url: "https://example.test" });
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

  test("keeps a blob-bearing reasoning item but strips output-only status when the route is unchanged", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const reasoningItem = {
      type: "reasoning",
      id: "rs_same_backend",
      status: "completed",
      summary: [{ type: "summary_text", text: "summary" }],
      encrypted_content: "backend-minted-blob",
      content: [],
    };
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        store: true,
        input: [reasoningItem],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Record<string, unknown>[] };

    expect(body.input[0]).toEqual({
      type: "reasoning",
      id: "rs_same_backend",
      summary: [{ type: "summary_text", text: "summary" }],
      encrypted_content: "backend-minted-blob",
      content: [],
    });
  });

  test("keeps a native blob while blanking its raw reasoning content", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [{
          type: "reasoning",
          status: "completed",
          summary: [],
          encrypted_content: "native-backend-blob",
          content: [{ type: "reasoning_text", text: "raw routed reasoning" }],
        }],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Record<string, unknown>[] };

    expect(body.input[0]).toEqual({
      type: "reasoning",
      summary: [],
      encrypted_content: "native-backend-blob",
      content: [],
    });
  });

  test("keeps encrypted reasoning content without a proven route switch", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [{
          type: "reasoning",
          summary: [],
          encrypted_content: "same-backend-blob",
        }],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Record<string, unknown>[] };

    expect(body.input[0]).toEqual({
      type: "reasoning",
      summary: [],
      encrypted_content: "same-backend-blob",
    });
  });

  test("strips encrypted reasoning content after a known route switch but keeps the item", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _stripReasoningEncryptedContent: true,
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [
          {
            type: "reasoning",
            id: "rs_foreign_backend",
            status: "completed",
            summary: [{ type: "summary_text", text: "still useful" }],
            encrypted_content: "foreign-backend-blob",
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "continue" }],
          },
        ],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Record<string, unknown>[] };

    expect(body.input).toEqual([
      {
        type: "reasoning",
        id: "rs_foreign_backend",
        summary: [{ type: "summary_text", text: "still useful" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue" }],
      },
    ]);
  });

  test("strips status from a reasoning item that has no encrypted content", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.6-sol",
        input: [{
          type: "reasoning",
          id: "rs_without_blob",
          status: "completed",
          summary: [{ type: "summary_text", text: "summary" }],
        }],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { input: Record<string, unknown>[] };

    expect(body.input[0]).toEqual({
      type: "reasoning",
      id: "rs_without_blob",
      summary: [{ type: "summary_text", text: "summary" }],
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

 test("normalizes xAI top-level and additional web search without stale tool choice", () => {
   const adapter = createResponsesPassthroughAdapter({
     adapter: "openai-responses",
     baseUrl: "https://api.x.ai/v1",
     authMode: "key" as const,
     apiKey: "xai-test",
      // The registry declares this denial for xAI; the strip is capability-driven, not
      // hostname-driven (official OpenAI API-key traffic keeps the fields).
      supportsOpenAiWebSearchToolFields: false,
   });
    const request = adapter.buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "grok-4.6",
        input: [{
          type: "additional_tools",
          tools: [{ type: "web_search", external_web_access: true, search_context_size: "medium" }],
        }],
        tools: [{ type: "web_search", external_web_access: false, filters: { allowed_domains: ["example.com"] } }],
        tool_choice: { type: "web_search" },
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as {
      tools?: Record<string, unknown>[];
      input: Array<{ type: string; tools: Record<string, unknown>[] }>;
      tool_choice: Record<string, unknown>;
    };

    expect(body.tools).toBeUndefined();
    expect(body.input[0]?.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toEqual({ type: "web_search" });
  });

  test("preserves external_web_access on the canonical OpenAI forward route", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "gpt-5.5",
        input: [],
        tools: [{ type: "web_search", external_web_access: true }],
      },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { tools: Record<string, unknown>[] };

    expect(body.tools).toEqual([{ type: "web_search", external_web_access: true }]);
  });

  function buildXaiXSearchBody({
    baseUrl = "https://cli-chat-proxy.grok.com/v1",
    enabled,
    tools,
    toolChoice,
  }: {
    baseUrl?: string;
    enabled?: boolean;
    tools: Record<string, unknown>[];
    toolChoice?: unknown;
  }): Record<string, unknown> {
    const request = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl,
      authMode: "key",
      apiKey: "xai-test",
      supportsOpenAiWebSearchToolFields: false,
      ...(enabled === undefined ? {} : { xaiResponsesXSearch: enabled }),
    }).buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "grok-4.6",
        input: [],
        tools,
        ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      },
    }, { headers: new Headers() });
    return JSON.parse(request.body) as Record<string, unknown>;
  }

  test.each([
    "https://api.x.ai/v1",
    "https://cli-chat-proxy.grok.com/v1",
  ])("injects x_search after live web_search normalization for %s", baseUrl => {
    const body = buildXaiXSearchBody({
      baseUrl,
      enabled: true,
      tools: [
        { type: "function", name: "shell", parameters: { type: "object" } },
        { type: "web_search", external_web_access: true, search_context_size: "medium" },
      ],
    }) as { tools: Record<string, unknown>[] };

    expect(body.tools).toEqual([
      { type: "function", name: "shell", parameters: { type: "object" } },
      { type: "web_search" },
      { type: "x_search" },
    ]);
  });

  test("does not inject x_search outside the exact activation contract", () => {
    const cases = [
      buildXaiXSearchBody({
        tools: [{ type: "web_search", external_web_access: true }],
      }),
      buildXaiXSearchBody({
        baseUrl: "https://responses.example.test/v1",
        enabled: true,
        tools: [{ type: "web_search", external_web_access: true }],
      }),
      buildXaiXSearchBody({
        baseUrl: "https://api.x.ai/v1",
        enabled: true,
        tools: [
          { type: "function", name: "shell", parameters: { type: "object" } },
          { type: "web_search", external_web_access: false },
        ],
      }),
      buildXaiXSearchBody({
        enabled: true,
        tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
      }),
    ];

    for (const body of cases) {
      expect((body.tools as Record<string, unknown>[] | undefined)?.some(tool => tool.type === "x_search") ?? false)
        .toBe(false);
    }
    expect(cases[2].tools).toEqual([
      { type: "function", name: "shell", parameters: { type: "object" } },
    ]);
  });

  test("keeps specific and allowed_tools selectors unchanged when x_search is injected", () => {
    const selectors = [
      { type: "function", name: "shell" },
      {
        type: "allowed_tools",
        mode: "auto",
        tools: [{ type: "function", name: "shell" }, { type: "web_search" }],
      },
    ];

    for (const selector of selectors) {
      const body = buildXaiXSearchBody({
        enabled: true,
        tools: [
          { type: "function", name: "shell", parameters: { type: "object" } },
          { type: "web_search", external_web_access: true },
        ],
        toolChoice: selector,
      }) as { tools: Record<string, unknown>[]; tool_choice: Record<string, unknown> };
      expect(body.tools.some(tool => tool.type === "x_search")).toBe(true);
      expect(body.tool_choice).toEqual(selector);
      const allowed = body.tool_choice.type === "allowed_tools"
        ? body.tool_choice.tools as Record<string, unknown>[]
        : [];
      expect(allowed.some(tool => tool.type === "x_search")).toBe(false);
    }
  });

  // `activateDeferredTool` clears `defer_loading` only for tools a `tool_search_output` already
  // loaded, so the first turn of a deferred catalog — and any child promoted out of a namespace
  // group — otherwise carries the private field to a gateway that rejects unknown arguments.
 test("drops Codex-private tool fields from routed declarations", () => {
   const adapter = createResponsesPassthroughAdapter({
     adapter: "openai-responses",
     baseUrl: "https://api.x.ai/v1",
     authMode: "key" as const,
     apiKey: "xai-test",
      supportsOpenAiWebSearchToolFields: false,
   });
    const request = adapter.buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "grok-4.6",
        tools: [
          { type: "web_search_preview", external_web_access: true },
          {
            type: "namespace",
            name: "workspace",
            tools: [{ type: "function", name: "read", defer_loading: true, parameters: {} }],
          },
        ],
        input: [{
          type: "additional_tools",
          tools: [{ type: "function", name: "loose", defer_loading: true, parameters: {} }],
        }],
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as {
      tools: Record<string, unknown>[];
      input: Array<{ tools: Record<string, unknown>[] }>;
    };

    expect(body.tools[0]).toEqual({ type: "web_search" });
    expect(body.tools[1]).toMatchObject({ type: "function", name: "workspace__read" });
    expect(body.tools[1]).not.toHaveProperty("defer_loading");
    expect(body.input[0].tools[0]).not.toHaveProperty("defer_loading");
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

  /**
   * Issue #2092: the ChatGPT backend 400s a gpt-5.6 request that still carries the retired
   * `prompt_cache_retention`. The strip is deliberately narrow, and these cases pin the
   * narrowness itself — a wider strip passes the first block and fails the second.
   */
  test.each(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "drops the retired prompt_cache_retention for %s without inventing replacement options",
    modelId => {
      const adapter = createResponsesPassthroughAdapter(provider);
      const request = adapter.buildRequest({
        modelId,
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: { model: modelId, input: "hi", prompt_cache_retention: "24h" },
      }, { headers: new Headers({ authorization: "Bearer token" }) });
      const body = JSON.parse(request.body) as {
        prompt_cache_retention?: string;
        prompt_cache_options?: unknown;
      };

      expect(body.prompt_cache_retention).toBeUndefined();
      // Translating "24h" into the replacement field would invent a caching decision the
      // caller never made, so absence must stay absence.
      expect(body.prompt_cache_options).toBeUndefined();
    },
  );

  test.each(["gpt-5.5", "gpt-5.6-luna"])(
    "drops caller-sent prompt_cache_options for canonical forward model %s",
    modelId => {
      const adapter = createResponsesPassthroughAdapter(provider);
      const request = adapter.buildRequest({
        modelId,
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: {
          model: modelId,
          input: "hi",
          prompt_cache_options: { ttl: "30m" },
        },
      }, { headers: new Headers({ authorization: "Bearer token" }) });
      const body = JSON.parse(request.body) as { prompt_cache_options?: { ttl?: string } };

      expect(body.prompt_cache_options).toBeUndefined();
    },
  );

  test("keeps prompt_cache_options for noncanonical forward and API-key providers", () => {
    for (const configuredProvider of [
      {
        adapter: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        authMode: "forward" as const,
      },
      {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key" as const,
        apiKey: "test-key",
      },
    ]) {
      const adapter = createResponsesPassthroughAdapter(configuredProvider);
      const request = adapter.buildRequest({
        modelId: "gpt-5.6-sol",
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: {
          model: "gpt-5.6-sol",
          input: "hi",
          prompt_cache_options: { ttl: "30m" },
        },
      }, { headers: new Headers({ authorization: "Bearer token" }) });
      const body = JSON.parse(request.body) as { prompt_cache_options?: { ttl?: string } };

      expect(body.prompt_cache_options).toEqual({ ttl: "30m" });
    }
  });

  test("a near-miss model id is not swept up by the gpt-5.6 family match", () => {
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest({
      modelId: "gpt-5.60",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.60", input: "hi", prompt_cache_retention: "24h" },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { prompt_cache_retention?: string };

    // A bare startsWith("gpt-5.6") would strip here and silently change an unrelated model.
    expect(body.prompt_cache_retention).toBe("24h");
  });

  test("a noncanonical forward gateway keeps the field even for gpt-5.6", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://gateway.example/v1",
      authMode: "forward" as const,
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "gpt-5.6-sol", input: "hi", prompt_cache_retention: "24h" },
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    const body = JSON.parse(request.body) as { prompt_cache_retention?: string };

    // Only the canonical ChatGPT backend is known to reject it. Stripping everywhere would be
    // a behavior change for deployments that still honor the field.
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

  test("keyed platform flattens complete namespaces and drops ones it cannot express", () => {
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

    // The empty `image_gen` group declares nothing, and relaying `type: "namespace"` is the shape a
    // strict gateway rejects for the whole request.
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "web__run",
        parameters: { type: "object" },
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

    // The empty namespace group is lowered away; only the hosted tool reaches the wire.
    expect(body.tools).toEqual([{ type: "image_generation" }]);
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

    // The empty namespace group is lowered away; only the hosted tool reaches the wire.
    expect(body.tools).toEqual([{ type: "image_generation" }]);
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

describe("routed namespace and custom-tool identity", () => {
  const customNamespace = "custom_catalog";
  const functionNamespace = "function_catalog";
  const rawTools = [
    {
      type: "namespace",
      name: customNamespace,
      tools: [{
        type: "custom",
        name: "read",
        description: "Read freeform input",
        format: { type: "text" },
      }],
    },
    {
      type: "namespace",
      name: functionNamespace,
      tools: [{
        type: "function",
        name: "read",
        description: "Read structured input",
        parameters: { type: "object", properties: {} },
      }],
    },
  ];
  const customUpstreamItem = {
    type: "function_call",
    id: "fc_custom_read",
    call_id: "call_custom_read",
    name: `${customNamespace}__read`,
    arguments: JSON.stringify({ input: "freeform payload" }),
    status: "completed",
  };
  const functionUpstreamItem = {
    type: "function_call",
    id: "fc_function_read",
    call_id: "call_function_read",
    name: `${functionNamespace}__read`,
    arguments: "{}",
    status: "completed",
  };
  const config = {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-responses",
        baseUrl: "https://fixture.test/v1",
        authMode: "key",
        apiKey: "fixture-key",
      },
    },
  } as OcxConfig;

  const frame = (event: string, payload: Record<string, unknown>): string =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}`;

  test("round-trips same-named namespaced custom and function calls through JSON and SSE", async () => {
    const adapter = createResponsesPassthroughAdapter(config.providers.fixture!);
    const built = adapter.buildRequest({
      modelId: "routed-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "routed-model", input: "read", tools: rawTools },
    }, { headers: new Headers() });
    const builtBody = JSON.parse(built.body) as { tools: Array<Record<string, unknown>> };

    expect(builtBody.tools.map(tool => ({ type: tool.type, name: tool.name }))).toEqual([
      { type: "function", name: `${customNamespace}__read` },
      { type: "function", name: `${functionNamespace}__read` },
    ]);
    expect([...(built.convertedRoutedCustomToolNames ?? [])]).toEqual([
      `${customNamespace}__read`,
    ]);

    const savedFetch = globalThis.fetch;
    const outboundBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      const outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
      outboundBodies.push(outbound);
      if (outbound.stream === true) {
        const upstream = [
          frame("response.output_item.added", {
            output_index: 0,
            item: { ...customUpstreamItem, arguments: "", status: "in_progress" },
          }),
          frame("response.function_call_arguments.done", {
            output_index: 0,
            item_id: customUpstreamItem.id,
            arguments: customUpstreamItem.arguments,
          }),
          frame("response.output_item.done", { output_index: 0, item: customUpstreamItem }),
          frame("response.output_item.added", {
            output_index: 1,
            item: { ...functionUpstreamItem, arguments: "", status: "in_progress" },
          }),
          frame("response.function_call_arguments.done", {
            output_index: 1,
            item_id: functionUpstreamItem.id,
            arguments: functionUpstreamItem.arguments,
          }),
          frame("response.output_item.done", { output_index: 1, item: functionUpstreamItem }),
          frame("response.completed", {
            response: {
              id: "resp_stream",
              status: "completed",
              output: [customUpstreamItem, functionUpstreamItem],
            },
          }),
          "data: [DONE]",
        ].join("\n\n") + "\n\n";
        return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        id: "resp_json",
        status: "completed",
        output: [customUpstreamItem, functionUpstreamItem],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const requestBody = (stream: boolean) => ({
      model: "fixture/routed-model",
      stream,
      input: [{ role: "user", content: [{ type: "input_text", text: "read both" }] }],
      tools: rawTools,
    });

    try {
      const jsonResponse = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody(false)),
      }), config, { model: "", provider: "" });
      const json = await jsonResponse.json() as { output: Array<Record<string, unknown>> };
      expect(json.output[0]).toMatchObject({
        type: "custom_tool_call",
        namespace: customNamespace,
        name: "read",
        input: "freeform payload",
      });
      expect(json.output[0]).not.toHaveProperty("arguments");
      expect(json.output[1]).toMatchObject({
        type: "function_call",
        namespace: functionNamespace,
        name: "read",
        arguments: "{}",
      });

      const sseResponse = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody(true)),
      }), config, { model: "", provider: "" });
      const clientSse = await sseResponse.text();
      const payloads = clientSse
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
        .map(line => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
      const completed = payloads.find(payload => payload.type === "response.completed") as {
        response: { output: Array<Record<string, unknown>> };
      } | undefined;
      expect(completed?.response.output[0]).toMatchObject({
        type: "custom_tool_call",
        namespace: customNamespace,
        name: "read",
        input: "freeform payload",
      });
      expect(completed?.response.output[1]).toMatchObject({
        type: "function_call",
        namespace: functionNamespace,
        name: "read",
        arguments: "{}",
      });
      expect(payloads.some(payload => payload.type === "response.custom_tool_call_input.done")).toBe(true);
      expect(payloads.some(payload => payload.type === "response.function_call_arguments.done")).toBe(true);

      for (const outbound of outboundBodies) {
        const tools = outbound.tools as Array<Record<string, unknown>>;
        expect(tools.map(tool => ({ type: tool.type, name: tool.name }))).toEqual([
          { type: "function", name: `${customNamespace}__read` },
          { type: "function", name: `${functionNamespace}__read` },
        ]);
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("noncanonical forward lowers a namespaced custom tool and restores its response identity", async () => {
    const forwardConfig = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://forward-gateway.example.test/v1",
          authMode: "forward",
        },
      },
    } as OcxConfig;
    const savedFetch = globalThis.fetch;
    let outbound: { tools?: Array<Record<string, unknown>> } | undefined;
    globalThis.fetch = (async (_input, init) => {
      outbound = JSON.parse(String(init?.body)) as { tools?: Array<Record<string, unknown>> };
      return Response.json({
        id: "resp_forward_custom",
        status: "completed",
        output: [customUpstreamItem],
      });
    }) as typeof fetch;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/routed-model",
          stream: false,
          input: "read",
          tools: [rawTools[0]],
        }),
      }), forwardConfig, { model: "", provider: "" });
      const body = await response.json() as { output: Array<Record<string, unknown>> };

      expect(outbound?.tools).toEqual([
        expect.objectContaining({ type: "function", name: `${customNamespace}__read` }),
      ]);
      expect(outbound?.tools?.[0]).not.toHaveProperty("format");
      expect(body.output[0]).toMatchObject({
        type: "custom_tool_call",
        namespace: customNamespace,
        name: "read",
        input: "freeform payload",
      });
      expect(body.output[0]).not.toHaveProperty("arguments");
    } finally {
      globalThis.fetch = savedFetch;
    }
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

describe("replayed compaction blobs", () => {
  type PassthroughProvider = Parameters<typeof createResponsesPassthroughAdapter>[0];

  // Shaped like a blob minted by an OpenAI-operated backend: opaque, no `ocx1:` envelope.
  const NATIVE_BLOB = "gAAAAAB-openai-minted-compaction-blob";
  const routedProvider: PassthroughProvider = {
    adapter: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    authMode: "key",
    apiKey: "xai-test",
  };
  const openaiKeyedProvider: PassthroughProvider = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authMode: "key",
    apiKey: "sk-test",
  };
  // Forward auth alone says nothing about the backend. Noncanonical providers receive no caller
  // credentials, so this relay cannot be assumed to understand OpenAI's native blob.
  const forwardRelayProvider: PassthroughProvider = {
    adapter: "openai-responses",
    baseUrl: "https://relay.example/backend-api/codex",
    authMode: "forward",
  };
  const optedInRelayProvider: PassthroughProvider = {
    adapter: "openai-responses",
    baseUrl: "https://openai-relay.example/v1",
    authMode: "key",
    apiKey: "relay-test",
    decodesNativeCompactionBlobs: true,
  };

  function forwardedInput(
    target: PassthroughProvider,
    input: unknown[],
    threadServingIdentityChanged = false,
  ): Record<string, unknown>[] {
    const request = createResponsesPassthroughAdapter(target).buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "grok-4.6", store: false, input },
      ...(threadServingIdentityChanged ? { _stripReasoningEncryptedContent: true } : {}),
    }, { headers: new Headers({ authorization: "Bearer token" }) });
    return (JSON.parse(request.body) as { input: Record<string, unknown>[] }).input;
  }

  // Forwarding a blob to a backend that did not mint it fails the turn, and because the item lives
  // in the client transcript the failure repeats on every later turn — including the compaction turn
  // — so the session cannot recover until its history is cleared.
  test("degrades a foreign blob to a note on a destination that cannot decode it", () => {
    for (const target of [routedProvider, forwardRelayProvider]) {
      for (const type of ["compaction", "compaction_summary", "context_compaction"]) {
        const forwarded = forwardedInput(target, [
          { type, encrypted_content: NATIVE_BLOB },
        ]);
        expect(forwarded[0]).toEqual({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: OPAQUE_COMPACTION_NOTE }],
        });
        expect(JSON.stringify(forwarded)).not.toContain(NATIVE_BLOB);
      }
    }
  });

  test("forwards a foreign blob untouched to destinations known to decode it", () => {
    const item = { type: "compaction", encrypted_content: NATIVE_BLOB };
    for (const target of [provider, openaiKeyedProvider, optedInRelayProvider]) {
      expect(forwardedInput(target, [item])[0]).toEqual(item);
    }
  });

  test("a known serving-identity change overrides the native-blob destination gate", () => {
    const before = { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] };
    const after = { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] };

    expect(forwardedInput(openaiKeyedProvider, [
      before,
      { type: "compaction", encrypted_content: NATIVE_BLOB },
      after,
    ], true)).toEqual([
      before,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: OPAQUE_COMPACTION_NOTE }],
      },
      after,
    ]);
  });

  // The proxy's own envelope is transparent base64, so no upstream can read it anywhere.
  test("lowers proxy-minted ocx1 envelopes on every destination", () => {
    const item = { type: "compaction", encrypted_content: encodeCompactionSummary("prior work") };
    for (const target of [provider, openaiKeyedProvider, routedProvider]) {
      for (const threadServingIdentityChanged of [false, true]) {
        expect(forwardedInput(target, [item], threadServingIdentityChanged)[0]).toEqual({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\nprior work` }],
        });
      }
    }
  });

  // A bare marker carries no blob, so there is nothing to mis-route.
  test("leaves compaction items without encrypted_content alone", () => {
    for (const target of [provider, routedProvider]) {
      for (const type of ["compaction", "context_compaction"]) {
        for (const threadServingIdentityChanged of [false, true]) {
          const item = { type };
          expect(forwardedInput(target, [item], threadServingIdentityChanged)[0]).toEqual(item);
        }
      }
    }
  });
});

describe("openaiResponsesUrl", () => {
  test("does not strip mid-path /v1 or a non-endpoint responses suffix", () => {
    expect(openaiResponsesUrl("https://proxy.example.com/v1/relay")).toBe(
      "https://proxy.example.com/v1/relay/v1/responses",
    );
    expect(openaiResponsesUrl("https://api.example.com/somev1")).toBe(
      "https://api.example.com/somev1/v1/responses",
    );
  });
});

describe("reasoning input content channel", () => {
  const routed = {
    adapter: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    authMode: "key" as const,
    apiKey: "xai-test",
  };

  function forwarded(item: Record<string, unknown>): Record<string, unknown> {
    const request = createResponsesPassthroughAdapter(routed).buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "grok-4.6", store: false, input: [item] },
    }, { headers: new Headers() });
    return (JSON.parse(request.body) as { input: Record<string, unknown>[] }).input[0];
  }

  // Codex serializes an absent reasoning content channel as `"content": null`. xAI rejects the item
  // and blames the sibling blob (`Could not decode the compaction blob`), so this reads as an
  // encrypted_content failure; dropping the null key is what actually fixes it. Verified against a
  // captured failing request: removing only this key turned the 400 into a 200.
  test("drops a null content channel while keeping the replayable blob", () => {
    const out = forwarded({
      type: "reasoning",
      content: null,
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "upstream-issued-blob",
    });
    expect(out).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "upstream-issued-blob",
    });
  });

  // An OpenAI-operated backend rejects a blob-bearing item when its null `content` channel is
  // deleted: `The encrypted content ... could not be verified`. Caught in live traffic after an
  // ungated first version of this fix shipped locally — the two backends want opposite things for
  // this channel.
  test("keeps a null content channel on OpenAI-operated destinations", () => {
    const item = {
      type: "reasoning",
      content: null,
      summary: [],
      encrypted_content: "openai-issued-blob",
    };
    for (const target of [
      { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const },
      { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key" as const, apiKey: "sk-t" },
      { adapter: "openai-responses", baseUrl: "https://api.openai.com", responsesPath: "/v1/responses", authMode: "key" as const, apiKey: "sk-t" },
    ]) {
      const request = createResponsesPassthroughAdapter(target).buildRequest({
        modelId: "gpt-5.6-sol",
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: { model: "gpt-5.6-sol", store: false, input: [item] },
      }, { headers: new Headers({ authorization: "Bearer token" }) });
      const out = (JSON.parse(request.body) as { input: Record<string, unknown>[] }).input[0];
      expect(out).toEqual(item);
    }
  });

  // A noncanonical forward gateway does not receive the caller's credentials, so forward auth says
  // nothing about which backend answers; it is routed and must get the strip.
  test("strips a null content channel on a noncanonical forward relay", () => {
    const request = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://relay.example/backend-api/codex",
      authMode: "forward",
    }).buildRequest({
      modelId: "grok-4.6",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "grok-4.6", store: false, input: [{ type: "reasoning", content: null, encrypted_content: "b" }] },
    }, { headers: new Headers() });
    const out = (JSON.parse(request.body) as { input: Record<string, unknown>[] }).input[0];
    expect(out).not.toHaveProperty("content");
  });

  test("leaves an array content channel to the existing sanitizer", () => {
    const out = forwarded({
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "raw" }],
      encrypted_content: "upstream-issued-blob",
    });
    expect(out.content).toEqual([]);
    expect(out.encrypted_content).toBe("upstream-issued-blob");
  });
});
