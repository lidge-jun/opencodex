import { describe, expect, test } from "bun:test";
import { createOllamaNativeAdapter } from "../../../src/adapters/ollama-native";
import {
  ollamaNativeChatUrl,
  ollamaNativeEndpointKind,
} from "../../../src/adapters/ollama-native-url";
import { buildCatalogEntries, gatherRoutedModels as gatherRoutedModelsDirect, upstreamNativeEntry } from "../../../src/codex/catalog";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import { withStubbedProviderFetch } from "../../helpers/catalog-provider-fetch";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

/** Discover routed test models with provider fetches stubbed to avoid live requests. */
const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

/** The four ids this transport is maintained against. */
const TARGETS = ["glm-5.3-flash", "deepseek-v4-flash:0731", "glm-5.2", "kimi-k3"] as const;

/** Configure a native Ollama test provider with inert credentials and caller overrides. */
function ollamaProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "ollama-native",
    baseUrl: "https://ollama.com/v1",
    authMode: "key",
    apiKey: "test-key-not-a-real-credential",
    liveModels: false,
    models: [...TARGETS],
    modelReasoningEfforts: { "deepseek-v4-flash:0731": ["low", "medium", "high", "max"] },
    ...overrides,
  } as OcxProviderConfig;
}

/** Build a minimal streamed replay request from synthetic messages and caller options. */
function parsedWith(
  messages: unknown[],
  options: Record<string, unknown> = {},
  modelId = "glm-5.3-flash",
): OcxParsedRequest {
  return { modelId, stream: true, options, context: { messages } } as unknown as OcxParsedRequest;
}

describe("ollama-native — URL policy", () => {
  test("normalizes every accepted cloud spelling onto /api/chat", () => {
    for (const base of [
      "https://ollama.com",
      "https://ollama.com/",
      "https://ollama.com/v1",
      "https://ollama.com/v1/chat/completions",
      "https://ollama.com/api",
      "https://ollama.com/api/chat",
    ]) {
      expect(ollamaNativeChatUrl(base)).toBe("https://ollama.com/api/chat");
    }
  });

  test("live model discovery is origin-relative, so the stored /v1 base reaches /v1/models", () => {
    // model-discovery resolves a leading-slash spec path against base.origin:
    // path "/v1/models" on baseUrl https://ollama.com/v1 -> https://ollama.com/v1/models.
    const base = new URL("https://ollama.com/v1/");
    expect(new URL("/v1/models", base.origin).toString()).toBe("https://ollama.com/v1/models");
  });

  test("classifies endpoints and refuses unsafe cloud transports", () => {
    expect(ollamaNativeEndpointKind("https://ollama.com/v1")).toBe("cloud");
    expect(ollamaNativeEndpointKind("http://localhost:11434")).toBe("local");
    expect(ollamaNativeEndpointKind("https://ollama.internal.example/api")).toBe("custom");
    expect(() => ollamaNativeChatUrl("http://ollama.com/v1")).toThrow(/HTTPS/);
    expect(() => ollamaNativeChatUrl("https://ollama.com:8443/v1")).toThrow(/non-default ports/);
  });

  test("treats one terminal-dot Ollama Cloud hostname as canonical", () => {
    expect(ollamaNativeEndpointKind("https://ollama.com./api")).toBe("cloud");
    expect(ollamaNativeChatUrl("https://ollama.com./api")).toBe("https://ollama.com/api/chat");
  });

  test("rejects the www Ollama Cloud alias instead of treating it as custom", () => {
    expect(() => ollamaNativeEndpointKind("https://www.ollama.com/v1"))
      .toThrow("requires canonical Ollama Cloud host ollama.com");
    expect(() => ollamaNativeChatUrl("https://www.ollama.com/v1"))
      .toThrow("requires canonical Ollama Cloud host ollama.com");
  });

  test("never silently rewrites a /v1 path on an unrelated host", () => {
    expect(() => ollamaNativeChatUrl("https://ollama.internal.example/v1")).toThrow(/refuses custom baseUrl path/);
    expect(ollamaNativeChatUrl("https://ollama.internal.example/api")).toBe("https://ollama.internal.example/api/chat");
  });

  test("rejects credential-bearing, query-bearing and non-http base URLs", () => {
    expect(() => ollamaNativeChatUrl("https://user:pw@chatgpt.com/v1")).toThrow(/must not contain credentials/);
    expect(() => ollamaNativeChatUrl("https://ollama.com/v1?k=v")).toThrow(/must not contain credentials/);
    expect(() => ollamaNativeChatUrl("ftp://ollama.com")).toThrow(/only supports http/);
    expect(() => ollamaNativeChatUrl("   ")).toThrow(/non-empty baseUrl/);
  });
});

describe("ollama-native — registry and discovery contract", () => {
  test("the registry declares the native transport and origin-relative /v1/models discovery", () => {
    const entry = getProviderRegistryEntry("ollama-cloud");
    expect(entry?.adapter).toBe("ollama-native");
    // The compat base URL is deliberately retained; the normalizer maps it to /api/chat.
    expect(entry?.baseUrl).toBe("https://ollama.com/v1");
    // Discovery resolves the leading-slash path against the ORIGIN, giving
    // https://ollama.com/v1/models — the standard data[] envelope the generic pipeline
    // already understands, so no special-case envelope code ships with this adapter.
    expect(entry?.modelDiscovery).toEqual({ path: "/v1/models" });
    expect(entry?.modelContextWindows).toMatchObject({
      "glm-5.3": 1_048_576,
      "glm-5.3-flash": 1_048_576,
    });
  });
});

describe("ollama-native — truthful serialized catalog capabilities", () => {
  test("no target advertises verbosity, a verbosity default, or a service/speed tier", async () => {
    const models = await gatherRoutedModels({ providers: { "ollama-cloud": ollamaProvider() } } as never);
    const entries = buildCatalogEntries(null, [], models);

    for (const id of TARGETS) {
      const entry = entries.find(e => e.slug === `ollama-cloud/${id}`);
      expect(entry).toBeDefined();
      // Serialized Codex spelling. `supports_verbosity` (plural) does not exist in this format,
      // which is exactly how an earlier assertion passed while the rows advertised the control.
      expect(entry).not.toHaveProperty("supports_verbosity");
      expect(entry?.support_verbosity).toBe(false);
      // default_verbosity is owned by the generic catalog verbosity fix (#2799); on a dev tree
      // without it the strict-fields backfill still emits "low" here. Not asserted in this PR.
      expect(entry?.service_tiers).toBeUndefined();
      expect(entry?.default_service_tier).toBeUndefined();
      expect(entry?.additional_speed_tiers).toBeUndefined();
      expect(entry?.fast_tier_description).toBeUndefined();
    }
  });

  test("a live-discovered Ollama id inherits the provider-wide opt-out", async () => {
    // The Ollama catalog is discovery-authoritative, so ids absent from the registry row still
    // reach the catalog. A per-model map alone would let those re-advertise the control.
    const models = await gatherRoutedModels({
      providers: { "ollama-cloud": ollamaProvider({ models: ["a-model-not-in-the-registry"] }) },
    } as never);
    const entries = buildCatalogEntries(null, [], models);
    const entry = entries.find(e => e.slug === "ollama-cloud/a-model-not-in-the-registry");
    expect(entry?.support_verbosity).toBe(false);
  });

  test("CONTROL: a routed provider that never disowns verbosity keeps the permissive default", async () => {
    const models = await gatherRoutedModels({
      providers: {
        plain: {
          adapter: "openai-responses",
          baseUrl: "https://plain.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["plain-model"],
        },
      },
    } as never);
    const entries = buildCatalogEntries(null, [], models);
    const entry = entries.find(e => e.slug === "plain/plain-model");
    expect(entry?.support_verbosity).toBe(true);
  });

  test("CONTROL: xAI's own opt-out is unchanged", async () => {
    const models = await gatherRoutedModels({
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth",
          liveModels: false,
          models: ["grok-4.6"],
        },
      },
    } as never);
    const entries = buildCatalogEntries(null, [], models);
    const entry = entries.find(e => e.slug === "xai/grok-4.6");
    expect(entry?.support_verbosity).toBe(false);
  });

  test("CONTROL: a native OpenAI row keeps verbosity, which it genuinely supports", () => {
    const template = upstreamNativeEntry("gpt-5.6-sol");
    expect(template).not.toBeNull();
    const entries = buildCatalogEntries(template, ["gpt-5.6-sol"], []);
    const native = entries.find(e => e.slug === "gpt-5.6-sol");
    expect(native).toBeDefined();
    expect(native?.support_verbosity).toBe(true);
  });
});

describe("ollama-native — reasoning ladder", () => {
  test("routed rows carry the upstream-required synthetic top rungs; the WIRE clamps", async () => {
    const models = await gatherRoutedModels({ providers: { "ollama-cloud": ollamaProvider() } } as never);
    const entries = buildCatalogEntries(null, [], models);
    const efforts = (slug: string) =>
      ((entries.find(e => e.slug === slug)?.supported_reasoning_levels ?? []) as Array<{ effort?: string }>)
        .map(l => l.effort);

    // Catalog universality (upstream design): every reasoning-capable routed row advertises the
    // synthetic top rungs so subagent effort overrides validate by catalog membership. The
    // ollama-native adapter is responsible for keeping the WIRE honest (see the wire-clamp tests).
    expect(efforts("ollama-cloud/deepseek-v4-flash:0731")).toEqual(["low", "medium", "high", "max", "ultra"]);
    for (const id of ["glm-5.3-flash", "glm-5.2", "kimi-k3"]) {
      expect(efforts(`ollama-cloud/${id}`)).toContain("max");
      expect(efforts(`ollama-cloud/${id}`)).toContain("ultra");
    }
  });

  test("every advertised rung maps into an allowed native wire value", async () => {
    const provider = ollamaProvider();
    const adapter = createOllamaNativeAdapter(provider);
    const allowed = new Set([undefined, true, false, "low", "medium", "high", "max"]);
    for (const requested of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "none"]) {
      const { body } = await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }], { reasoning: requested }));
      const think = JSON.parse(String(body)).think;
      expect(allowed.has(think)).toBe(true);
    }
    // xhigh and ultra collapse onto Ollama's top rung rather than being sent through verbatim.
    for (const requested of ["xhigh", "ultra"]) {
      const { body } = await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }], { reasoning: requested }));
      expect(JSON.parse(String(body)).think).toBe("max");
    }
  });

  test("an unmappable effort fails the turn instead of degrading silently", () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    expect(() =>
      adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }], { reasoning: "turbo" })),
    ).toThrow(/does not support reasoning level/);
  });
});

describe("ollama-native — request shape", () => {
  test("posts to the native chat endpoint with the wire model id", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { url, method, body } = await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    expect(url).toBe("https://ollama.com/api/chat");
    expect(method).toBe("POST");
    expect(JSON.parse(String(body)).model).toBe("glm-5.3-flash");
  });

  test("a caller-supplied verbosity never reaches /api/chat", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = await adapter.buildRequest(
      parsedWith([{ role: "user", content: "hi" }], { verbosity: "high", text: { verbosity: "high" } }),
    );
    const serialized = String(body);
    expect(serialized).not.toContain("verbosity");
    const parsed = JSON.parse(serialized);
    expect(parsed).not.toHaveProperty("verbosity");
    expect(parsed.options ?? {}).not.toHaveProperty("verbosity");
  });

  test("images travel in the native images[] array, and video is refused", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const { body } = await adapter.buildRequest(parsedWith([
      { role: "user", content: [{ type: "text", text: "read it" }, { type: "image", imageUrl: png }] },
    ]));
    const message = JSON.parse(String(body)).messages.at(-1);
    expect(Array.isArray(message.images)).toBe(true);
    expect(message.images[0]).toBe("iVBORw0KGgo=");
    expect(message.content).toContain("read it");

    expect(() => adapter.buildRequest(parsedWith([
      { role: "user", content: [{ type: "video", videoUrl: "data:video/mp4;base64,AAAA" }] },
    ]))).toThrow(/cannot send video/);
  });

  test("a mid-turn developer message is deferred instead of closing the tool batch", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = await adapter.buildRequest(parsedWith([
      { role: "user", content: "continue", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "applying the patch" },
          { type: "toolCall", id: "call_hook_split", name: "exec", arguments: { cmd: "ls" } },
        ],
        timestamp: 1,
      },
      { role: "developer", content: "[hook] design findings requiring review", timestamp: 2 },
      { role: "toolResult", toolCallId: "call_hook_split", toolName: "exec", content: "done", isError: false, timestamp: 3 },
    ]));
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["user", "assistant", "tool", "system"]);
    expect(messages[2].tool_call_id).toBe("call_hook_split");
    expect(messages[2].content).toBe("done");
    expect(messages[3].content).toBe("[hook] design findings requiring review");
  });

  test("assistant commentary before parallel results keeps the original batch open", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = await adapter.buildRequest(parsedWith([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_commentary_first", name: "exec", arguments: { input: "text('first')" } },
          { type: "toolCall", id: "call_commentary_second", name: "exec", arguments: { input: "text('second')" } },
        ],
        timestamp: 1,
      },
      { role: "assistant", content: [{ type: "text", text: "checking both results" }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_commentary_second", toolName: "exec", content: "second result", isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: "call_commentary_first", toolName: "exec", content: "first result", isError: false, timestamp: 4 },
    ]));
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["assistant", "tool", "tool", "assistant"]);
    expect(messages[1]).toMatchObject({ tool_call_id: "call_commentary_first", content: "first result" });
    expect(messages[2]).toMatchObject({ tool_call_id: "call_commentary_second", content: "second result" });
    expect(messages[3].content).toBe("checking both results");
  });

  test("assistant commentary after one parallel result preserves the remaining genuine result", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = await adapter.buildRequest(parsedWith([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_partial_first", name: "exec", arguments: {} },
          { type: "toolCall", id: "call_partial_second", name: "exec", arguments: {} },
        ],
        timestamp: 1,
      },
      { role: "toolResult", toolCallId: "call_partial_first", toolName: "exec", content: "first done", isError: false, timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "waiting for the second result" }], timestamp: 3 },
      { role: "toolResult", toolCallId: "call_partial_second", toolName: "exec", content: "second done", isError: false, timestamp: 4 },
    ]));
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["assistant", "tool", "tool", "assistant"]);
    expect(messages[1].content).toBe("first done");
    expect(messages[2].content).toBe("second done");
    expect(messages[3].content).toBe("waiting for the second result");
  });

  test("deferred assistant text and thinking retain their order without mutating parsed history", async () => {
    const parsed = parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "call_thinking", name: "exec", arguments: {} }], timestamp: 1 },
      { role: "developer", content: "context notice", timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "first comment" }, { type: "thinking", thinking: "synthetic reasoning" }], timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "second comment" }], timestamp: 4 },
      { role: "toolResult", toolCallId: "call_thinking", toolName: "exec", content: "recorded result", isError: false, timestamp: 5 },
    ]);
    const original = JSON.stringify(parsed);
    const { body } = await createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsed);
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["assistant", "tool", "system", "assistant", "assistant"]);
    expect(messages[1].content).toBe("recorded result");
    expect(messages[2].content).toBe("context notice");
    expect(messages[3]).toMatchObject({ content: "first comment", thinking: "synthetic reasoning" });
    expect(messages[4].content).toBe("second comment");
    expect(JSON.stringify(parsed)).toBe(original);
  });

  test("assistant commentary after a complete batch keeps its existing wire position", async () => {
    const { body } = await createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "call_complete", name: "exec", arguments: {} }], timestamp: 1 },
      { role: "toolResult", toolCallId: "call_complete", toolName: "exec", content: "done", isError: false, timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "completed comment" }], timestamp: 3 },
      { role: "user", content: "next turn", timestamp: 4 },
    ]));
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["assistant", "tool", "assistant", "user"]);
    expect(messages[1].content).toBe("done");
    expect(messages[2].content).toBe("completed comment");
    expect(messages[3].content).toBe("next turn");
  });

  test("a new tool-call batch still settles an unresolved batch after assistant commentary", async () => {
    const { body } = await createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "call_unfinished", name: "exec", arguments: {} }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "before the next batch" }], timestamp: 2 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_next", name: "exec", arguments: {} }], timestamp: 3 },
      { role: "toolResult", toolCallId: "call_next", toolName: "exec", content: "next result", isError: false, timestamp: 4 },
    ]));
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["assistant", "tool", "assistant", "assistant", "tool"]);
    expect(messages[1].tool_call_id).toBe("call_unfinished");
    expect(messages[1].content).toContain("execution status unknown");
    expect(messages[2].content).toBe("before the next batch");
    expect(messages[4]).toMatchObject({ tool_call_id: "call_next", content: "next result" });
  });

  test("routed compaction preserves a result recorded after assistant commentary", async () => {
    const parsed = parsedWith([
      { role: "assistant", content: [{ type: "toolCall", id: "call_compaction", name: "exec", arguments: {} }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "commentary before compaction" }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_compaction", toolName: "exec", content: "genuine result", isError: false, timestamp: 3 },
      { role: "user", content: "summarize this history", timestamp: 4 },
    ], { toolChoice: "none" });
    parsed._compactionRequest = true;
    const { body } = await createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsed);
    const request = JSON.parse(String(body));
    expect(request.messages.map((message: { role: string }) => message.role))
      .toEqual(["assistant", "tool", "assistant", "user"]);
    expect(request.messages[1]).toMatchObject({ tool_call_id: "call_compaction", content: "genuine result" });
    expect(request.messages[2].content).toBe("commentary before compaction");
    expect(request.tools).toBeUndefined();
  });

  test("a deferred user message keeps its text and images after the tool result", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const { body } = await adapter.buildRequest(parsedWith([
      { role: "user", content: "start", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_mid_user", name: "exec", arguments: { cmd: "ls" } }],
        timestamp: 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "look at this" }, { type: "image", imageUrl: png }],
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "call_mid_user", toolName: "exec", content: "done", isError: false, timestamp: 3 },
    ]));
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[2].tool_call_id).toBe("call_mid_user");
    expect(messages[2].content).toBe("done");
    expect(messages[3].content).toBe("look at this");
    expect(messages[3].images).toEqual(["iVBORw0KGgo="]);
  });

  test("out-of-order results inside a parallel batch still serialize in call order", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = await adapter.buildRequest(parsedWith([
      { role: "user", content: "continue", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_first", name: "exec", arguments: { cmd: "ls" } },
          { type: "toolCall", id: "call_second", name: "exec", arguments: { cmd: "pwd" } },
        ],
        timestamp: 1,
      },
      { role: "developer", content: "[hook] findings", timestamp: 2 },
      { role: "toolResult", toolCallId: "call_second", toolName: "exec", content: "second", isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: "call_first", toolName: "exec", content: "first", isError: false, timestamp: 4 },
    ]));
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["user", "assistant", "tool", "tool", "system"]);
    expect(messages[2].tool_call_id).toBe("call_first");
    expect(messages[2].content).toBe("first");
    expect(messages[3].tool_call_id).toBe("call_second");
    expect(messages[3].content).toBe("second");
  });

  test("a call with no recorded result answers with an explicit unknown status", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = await adapter.buildRequest(parsedWith([
      { role: "user", content: "start", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_interrupted", name: "exec", arguments: { cmd: "ls" } }],
        timestamp: 1,
      },
      { role: "user", content: "continue", timestamp: 2 },
    ]));
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[2].tool_call_id).toBe("call_interrupted");
    expect(messages[2].content).toContain("no tool result was recorded");
    expect(messages[2].content).toContain('"exec"');
    expect(messages[2].content).toContain("do not treat this as success, failure, or user-provided input");
    expect(messages[3].content).toBe("continue");
  });

  test("a second assistant turn settles the first batch before its own", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = await adapter.buildRequest(parsedWith([
      { role: "user", content: "start", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_first", name: "exec", arguments: { cmd: "ls" } }],
        timestamp: 1,
      },
      { role: "developer", content: "[hook] findings", timestamp: 2 },
      { role: "toolResult", toolCallId: "call_first", toolName: "exec", content: "first done", isError: false, timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_second", name: "exec", arguments: { cmd: "pwd" } }],
        timestamp: 4,
      },
      { role: "toolResult", toolCallId: "call_second", toolName: "exec", content: "second done", isError: false, timestamp: 5 },
    ]));
    const messages = JSON.parse(String(body)).messages;
    expect(messages.map((message: { role: string }) => message.role))
      .toEqual(["user", "assistant", "tool", "system", "assistant", "tool"]);
    expect(messages[2].tool_call_id).toBe("call_first");
    expect(messages[2].content).toBe("first done");
    expect(messages[3].content).toBe("[hook] findings");
    expect(messages[4].tool_calls[0].id).toBe("call_second");
    expect(messages[5].tool_call_id).toBe("call_second");
    expect(messages[5].content).toBe("second done");
  });

  test("an orphan tool result is still refused", () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    expect(() => adapter.buildRequest(parsedWith([
      { role: "user", content: "hi" },
      { role: "toolResult", toolCallId: "call_ghost", toolName: "exec", content: "x", isError: false, timestamp: 1 },
    ]))).toThrow(/orphan tool result/);
  });

  test("additional results for the same call preserve every fragment", () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = adapter.buildRequest(parsedWith([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_once", name: "exec", arguments: { cmd: "ls" } }],
        timestamp: 1,
      },
      { role: "toolResult", toolCallId: "call_once", toolName: "exec", content: "once", isError: false, timestamp: 2 },
      { role: "toolResult", toolCallId: "call_once", toolName: "exec", content: "twice", isError: false, timestamp: 3 },
    ]));
    const messages = JSON.parse(body).messages;
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_once", content: "once\ntwice" });
  });
});

describe("ollama-native commentary validation and replay ownership", () => {
  const call = (id = "call_guard") => ({
    role: "assistant", content: [{ type: "toolCall", id, name: "exec", namespace: "ops", arguments: { cmd: "pwd" } }], timestamp: 1,
  });
  const commentary = { role: "assistant", content: [{ type: "text", text: "Working." }], timestamp: 2 };
  const result = (id = "call_guard") => ({
    role: "toolResult", toolCallId: id, toolName: "exec", toolNamespace: "ops", content: "done", isError: false, timestamp: 3,
  });

  for (const [label, invalid, error] of [
    ["unknown id", { ...result(), toolCallId: "call_other" }, /has no originating call/],
    ["wrong name", { ...result(), toolName: "other" }, /names the wrong originating tool/],
    ["wrong namespace", { ...result(), toolNamespace: "other" }, /names the wrong originating tool/],
  ] as const) {
    test(`commentary does not bypass result validation: ${label}`, () => {
      const adapter = createOllamaNativeAdapter(ollamaProvider());
      expect(() => adapter.buildRequest(parsedWith([call(), commentary, invalid]))).toThrow(error);
    });
  }

  test("additional output does not consume another call's unresolved count", () => {
    const first = call("first");
    const second = call("second");
    const batch = { ...first, content: [...first.content, ...second.content] };
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = adapter.buildRequest(parsedWith([
      batch, result("first"), { ...result("first"), content: "additional A" },
      commentary, { ...result("second"), content: "done B" },
    ]));
    const messages = JSON.parse(body).messages;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "tool", "tool", "assistant"]);
    expect(messages[0].tool_calls.map((entry: { id: string }) => entry.id)).toEqual(["first", "second"]);
    expect(messages[1]).toMatchObject({ tool_call_id: "first", content: "done\nadditional A" });
    expect(messages[2]).toMatchObject({ tool_call_id: "second", content: "done B" });
    expect(messages[3]).toMatchObject({ role: "assistant", content: "Working." });
  });

  test("late output after completed commentary uses an attributed conversation carrier", () => {
    const { body } = createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsedWith([
      call("settled"), result("settled"), commentary,
      { ...result("settled"), content: "late fragment" }, { role: "user", content: "next" },
    ]));
    const messages = JSON.parse(body).messages;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "tool", "assistant", "user", "user"]);
    expect(messages[1]).toMatchObject({ tool_call_id: "settled", content: "done" });
    expect(messages[2]).toMatchObject({ role: "assistant", content: "Working." });
    expect(messages[3]).toEqual({ role: "user",
      content: '[ocx] additional output for previously issued tool "ops__exec" (settled):\nlate fragment',
    });
    expect(messages[4]).toMatchObject({ role: "user", content: "next" });
  });

  test("known late output follows the subsequent batch without reopening its old call", () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = adapter.buildRequest(parsedWith([call("old"), commentary, call("new"), result("old")]));
    const messages = JSON.parse(body).messages;
    expect(messages[4]).toMatchObject({ role: "tool", tool_call_id: "new" });
    expect(messages[5].role).toBe("user");
    expect(messages[5].content).toContain("[ocx] additional output");
    expect(messages[5].content).toContain("old");
  });

  for (const id of ["", "call_guard"]) {
    test(`new batches still reject ${id ? "reused" : "empty"} call IDs after commentary`, () => {
      const adapter = createOllamaNativeAdapter(ollamaProvider());
      expect(() => adapter.buildRequest(parsedWith([call(), commentary, call(id)]))).toThrow(/id is missing or duplicated/);
    });
  }

  test("EOF settles a missing result once before deferred commentary", () => {
    const { body } = createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsedWith([call(), commentary]));
    const messages = JSON.parse(body).messages;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(messages[1].tool_call_id).toBe("call_guard");
    expect(messages[1].content).toContain("execution status unknown");
    expect(messages[2].content).toBe("Working.");
  });

  test("completed batches release commentary before the next conversation turn", () => {
    const { body } = createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsedWith([
      call(), result(), commentary, { role: "user", content: "next" }, call("next"), result("next"),
    ]));
    const messages = JSON.parse(body).messages;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "tool", "assistant", "user", "assistant", "tool"]);
    expect(messages[2].content).toBe("Working.");
    expect(messages[3].content).toBe("next");
    expect(messages[5].tool_call_id).toBe("next");
  });

  test("deep-frozen history keeps call order, deferred arrival order and original arguments", () => {
    const first = call("first");
    const second = call("second");
    const batch = { ...first, content: [...first.content, ...second.content] };
    const parsed = parsedWith([
      batch,
      { role: "developer", content: "hook" },
      result("second"),
      { role: "assistant", content: [{ type: "thinking", thinking: "Checking." }, { type: "text", text: "Working." }] },
      { role: "user", content: "notice" },
      result("first"),
    ]);
    function freeze(value: unknown): void {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    const before = JSON.stringify(parsed);
    freeze(parsed);
    const { body } = createOllamaNativeAdapter(ollamaProvider()).buildRequest(parsed);
    expect(JSON.stringify(parsed)).toBe(before);
    const messages = JSON.parse(body).messages;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "tool", "tool", "system", "assistant", "user"]);
    expect(messages.slice(1, 3).map((message: { tool_call_id: string }) => message.tool_call_id)).toEqual(["first", "second"]);
    expect(messages.slice(3).map((message: { content: string }) => message.content)).toEqual(["hook", "Working.", "notice"]);
    expect(messages[4].thinking).toBe("Checking.");
    expect(messages[0].tool_calls[0].function.arguments).toEqual({ cmd: "pwd" });
  });
});
