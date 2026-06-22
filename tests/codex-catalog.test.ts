import { describe, expect, test } from "bun:test";
import { augmentRoutedModelsWithJawcodeMetadata, buildCatalogEntries, gatherRoutedModels, isMediaGenerationModelId, normalizeRoutedCatalogEntry } from "../src/codex-catalog";
import { getJawcodeModelMetadata, resolveJawcodeProvider } from "../src/generated/jawcode-model-metadata";
import { clearModelCache, setCached } from "../src/model-cache";

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: {
      instructions_template: "You are Codex, a coding agent based on GPT-5.",
    },
    tool_mode: "code",
    multi_agent_version: "v2",
    use_responses_lite: true,
    supports_websockets: true,
    web_search_tool_type: "text_and_image",
    supports_search_tool: true,
    additional_speed_tiers: [{ id: "priority" }],
    service_tier: "fast",
    service_tiers: [{ id: "fast" }],
    default_service_tier: "priority",
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

describe("Codex catalog routed normalization", () => {
  test("normalizeRoutedCatalogEntry strips native-only routed selectors", () => {
    const entry = nativeTemplate();

    normalizeRoutedCatalogEntry(entry);

    expect(entry).not.toHaveProperty("model_messages");
    expect(entry).not.toHaveProperty("tool_mode");
    expect(entry).not.toHaveProperty("multi_agent_version");
    expect(entry).not.toHaveProperty("use_responses_lite");
    expect(entry).not.toHaveProperty("supports_websockets");
    expect(entry).not.toHaveProperty("additional_speed_tiers");
    expect(entry).not.toHaveProperty("service_tier");
    expect(entry).not.toHaveProperty("service_tiers");
    expect(entry).not.toHaveProperty("default_service_tier");
    expect(entry.web_search_tool_type).toBe("text_and_image");
    expect(entry.supports_search_tool).toBe(true);
  });

  test("buildCatalogEntries strips routed entries cloned from native templates", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], [
      { provider: "anthropic", id: "claude-sonnet-4-6", owned_by: "anthropic" },
    ]);
    const routed = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(routed).toBeDefined();
    expect(routed).not.toHaveProperty("model_messages");
    expect(routed).not.toHaveProperty("tool_mode");
    expect(routed).not.toHaveProperty("multi_agent_version");
    expect(routed).not.toHaveProperty("use_responses_lite");
    expect(routed).not.toHaveProperty("supports_websockets");
    expect(routed).not.toHaveProperty("additional_speed_tiers");
    expect(routed).not.toHaveProperty("service_tier");
    expect(routed).not.toHaveProperty("service_tiers");
    expect(routed).not.toHaveProperty("default_service_tier");
    expect(routed?.web_search_tool_type).toBe("text_and_image");
    expect(routed?.supports_search_tool).toBe(true);
    expect(routed?.base_instructions).not.toBe(nativeTemplate().base_instructions);
    expect(routed?.base_instructions).toContain("claude-sonnet-4-6");
    expect(routed?.default_reasoning_level).toBe("medium");
  });

  test("routed entries fill auto compact when context already exists on the template", () => {
    const template = {
      ...nativeTemplate(),
      context_window: 272_000,
      max_context_window: 272_000,
    };
    const entries = buildCatalogEntries(template, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.context_window).toBe(272_000);
    expect(routed?.max_context_window).toBe(272_000);
    expect(routed?.auto_compact_token_limit).toBe(244_800);
  });

  test("buildCatalogEntries preserves native bare GPT template fields", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], []);
    const native = entries.find(e => e.slug === "gpt-5.5");

    expect(native).toBeDefined();
    expect(native).toHaveProperty("model_messages");
    expect(native?.tool_mode).toBe("code");
    expect(native?.multi_agent_version).toBe("v2");
    expect(native?.use_responses_lite).toBe(true);
    // WebSocket advertisement is opt-in; templates must not leak it by default.
    expect(native).not.toHaveProperty("supports_websockets");
    expect(native?.web_search_tool_type).toBe("text_and_image");
    expect(native?.supports_search_tool).toBe(true);
    expect(native?.service_tier).toBe("priority");
    expect(native?.service_tiers).toEqual([{ id: "priority" }]);
  });

  test("buildCatalogEntries advertises supports_websockets only on explicit opt-in", () => {
    const goModels = [{ provider: "anthropic", id: "claude-sonnet-4-6", owned_by: "anthropic" }];

    const defaultOff = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], goModels);
    expect(defaultOff.find(e => e.slug === "gpt-5.5")).not.toHaveProperty("supports_websockets");
    expect(defaultOff.find(e => e.slug === "anthropic/claude-sonnet-4-6")).not.toHaveProperty("supports_websockets");

    const on = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], goModels, undefined, true);
    expect(on.find(e => e.slug === "gpt-5.5")?.supports_websockets).toBe(true);
    expect(on.find(e => e.slug === "anthropic/claude-sonnet-4-6")?.supports_websockets).toBe(true);

    const off = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], goModels, undefined, false);
    expect(off.find(e => e.slug === "gpt-5.5")).not.toHaveProperty("supports_websockets");
    expect(off.find(e => e.slug === "anthropic/claude-sonnet-4-6")).not.toHaveProperty("supports_websockets");
  });

  test("fallback routed entries still receive explicit search metadata", () => {
    const entries = buildCatalogEntries(null, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.web_search_tool_type).toBe("text_and_image");
    expect(routed?.supports_search_tool).toBe(true);
  });

  test("provider contextWindow caps live /models metadata instead of overriding it", async () => {
    clearModelCache("live-cap");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ id: "large-live", max_model_len: 1_000_000 }],
    }), { status: 200 })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          "live-cap": {
            adapter: "openai-chat",
            baseUrl: "https://example.invalid/v1",
            authMode: "key",
            contextWindow: 262_144,
          },
        },
      });

      expect(models.find(m => m.id === "large-live")?.contextWindow).toBe(262_144);
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("live-cap");
    }
  });

  test("modelContextWindows caps a specific live /models row", async () => {
    clearModelCache("model-live-cap");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: "large-live", max_model_len: 1_000_000 },
        { id: "uncapped-live", max_model_len: 512_000 },
      ],
    }), { status: 200 })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          "model-live-cap": {
            adapter: "openai-chat",
            baseUrl: "https://example.invalid/v1",
            authMode: "key",
            modelContextWindows: { "large-live": 128_000 },
          },
        },
      });

      expect(models.find(m => m.id === "large-live")?.contextWindow).toBe(128_000);
      expect(models.find(m => m.id === "uncapped-live")?.contextWindow).toBe(512_000);
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("model-live-cap");
    }
  });

  test("configured contextWindow does not raise smaller live metadata", async () => {
    clearModelCache("small-live-cap");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ id: "small-live", max_model_len: 128_000 }],
    }), { status: 200 })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          "small-live-cap": {
            adapter: "openai-chat",
            baseUrl: "https://example.invalid/v1",
            authMode: "key",
            contextWindow: 262_144,
          },
        },
      });

      expect(models.find(m => m.id === "small-live")?.contextWindow).toBe(128_000);
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache("small-live-cap");
    }
  });

  test("configured contextWindow caps fresh cached live metadata", async () => {
    clearModelCache("cached-live-cap");
    setCached("cached-live-cap", [
      { provider: "cached-live-cap", id: "cached-large", contextWindow: 1_000_000 },
    ]);
    try {
      const models = await gatherRoutedModels({
        providers: {
          "cached-live-cap": {
            adapter: "openai-chat",
            baseUrl: "https://example.invalid/v1",
            authMode: "key",
            contextWindow: 262_144,
          },
        },
      });

      expect(models.find(m => m.id === "cached-large")?.contextWindow).toBe(262_144);
    } finally {
      clearModelCache("cached-live-cap");
    }
  });

  test("routed entries receive exact jawcode context metadata", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "opencode-go", id: "deepseek-v4-pro" },
    ]);
    const routed = entries.find(e => e.slug === "opencode-go/deepseek-v4-pro");

    expect(routed?.context_window).toBe(1_000_000);
    expect(routed?.max_context_window).toBe(1_000_000);
    expect(routed?.auto_compact_token_limit).toBe(900_000);
    expect(routed?.input_modalities).toEqual(["text"]);
  });

  test("opencode-go high-risk models use official jawcode metadata in the Codex catalog", () => {
    const cases = [
      { id: "glm-5.2", context: 1_000_000, auto: 900_000, input: ["text"] },
      { id: "qwen3.5-plus", context: 1_000_000, auto: 900_000, input: ["text", "image"] },
      { id: "kimi-k2.7-code", context: 262_144, auto: 235_929, input: ["text", "image"] },
      { id: "minimax-m3", context: 512_000, auto: 460_800, input: ["text", "image"] },
      { id: "hy3-preview", context: 256_000, auto: 230_400, input: ["text"] },
    ] as const;
    const entries = buildCatalogEntries(nativeTemplate(), [], cases.map(({ id }) => ({ provider: "opencode-go", id })));

    for (const item of cases) {
      const routed = entries.find(e => e.slug === `opencode-go/${item.id}`);

      expect(routed?.context_window).toBe(item.context);
      expect(routed?.max_context_window).toBe(item.context);
      expect(routed?.auto_compact_token_limit).toBe(item.auto);
      expect(routed?.input_modalities).toEqual(item.input);
      expect(getJawcodeModelMetadata("opencode-go", item.id)?.contextWindow).toBe(item.context);
    }
  });

  test("opencode-go catalog sync appends official rows missing from /v1/models", () => {
    const models = augmentRoutedModelsWithJawcodeMetadata(
      [{ provider: "opencode-go", id: "glm-5.2" }],
      ["opencode-go"],
    );
    const slugs = new Set(models.map(m => `${m.provider}/${m.id}`));

    expect(slugs.has("opencode-go/glm-5.2")).toBe(true);
    expect(slugs.has("opencode-go/qwen3.5-plus")).toBe(true);
    expect(slugs.has("opencode-go/hy3-preview")).toBe(true);
    expect(models.filter(m => `${m.provider}/${m.id}` === "opencode-go/glm-5.2")).toHaveLength(1);
  });

  test("anthropic sonnet 4.6 uses the 200k opencodex catalog cap", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "anthropic", id: "claude-sonnet-4-6" },
    ]);
    const routed = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(routed?.context_window).toBe(200_000);
    expect(routed?.max_context_window).toBe(200_000);
    expect(routed?.auto_compact_token_limit).toBe(180_000);
    expect(getJawcodeModelMetadata("anthropic", "claude-sonnet-4-6")?.contextWindow).toBe(200_000);
  });

  test("routed entries resolve jawcode provider aliases", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "kimi", id: "kimi-k2.5" },
    ]);
    const routed = entries.find(e => e.slug === "kimi/kimi-k2.5");

    expect(routed?.context_window).toBe(262_144);
    expect(routed?.max_context_window).toBe(262_144);
    expect(routed?.auto_compact_token_limit).toBe(235_929);
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("unknown routed entries receive conservative strict catalog defaults", () => {
    const entries = buildCatalogEntries(null, [], [
      { provider: "local", id: "qwen3-coder" },
    ]);
    const routed = entries.find(e => e.slug === "local/qwen3-coder");

    expect(routed?.context_window).toBe(128_000);
    expect(routed?.max_context_window).toBe(128_000);
    expect(routed?.auto_compact_token_limit).toBe(115_200);
    expect(routed?.input_modalities).toEqual(["text"]);
    expect(routed?.supports_reasoning_summaries).toBe(true);
    expect(routed?.default_reasoning_summary).toBe("none");
  });

  test("generated jawcode snapshot is restricted to mapped providers", () => {
    expect(resolveJawcodeProvider("kimi")).toBe("moonshot");
    expect(resolveJawcodeProvider("nanogpt")).toBeUndefined();
    expect(getJawcodeModelMetadata("moonshot", "kimi-k2.5")?.contextWindow).toBe(262_144);
    expect(getJawcodeModelMetadata("nanogpt", "some-model")).toBeUndefined();
  });
});

describe("media-generation model filtering", () => {
  test("flags image/video generation model ids", () => {
    for (const id of [
      "grok-2-image", "grok-2-image-1212", "grok-2-image-latest", "grok-video",
      "gpt-5-image", "gpt-5-image-mini", "gpt-image-1", "gemini-3-pro-image",
      "dall-e-3", "imagen-4", "sora-2", "veo-3", "flux", "stable-diffusion-3.5", "sdxl", "kling-2",
    ]) {
      expect(isMediaGenerationModelId(id)).toBe(true);
    }
  });

  test("keeps text + vision-input chat model ids", () => {
    for (const id of [
      "grok-4.3", "grok-2-vision", "grok-2-vision-1212", "grok-composer-2.5-fast",
      "gpt-4o", "gpt-5.2", "claude-opus-4-8", "gemini-3-pro-preview",
      "qwen3-vl-30b-a3b-instruct", "openrouter/aurora-alpha", "deepseek-v4-pro", "minimax-m3",
    ]) {
      expect(isMediaGenerationModelId(id)).toBe(false);
    }
  });
});
