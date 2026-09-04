import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { getProviderRegistryEntry } from "../src/providers/registry";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const ZEN_PROVIDER = {
  adapter: "openai-responses",
  baseUrl: "https://opencode.ai/zen/v1",
  apiKey: "test-key",
} as unknown as OcxProviderConfig;

const ZEN_GO_PROVIDER = {
  ...ZEN_PROVIDER,
  baseUrl: "https://opencode.ai/zen/go/v1",
};

const ZEN_PATH_PROVIDER = {
  ...ZEN_PROVIDER,
  baseUrl: "https://opencode.ai",
  responsesPath: "/zen/v1/responses",
};

const ZEN_GO_PATH_PROVIDER = {
  ...ZEN_PROVIDER,
  baseUrl: "https://opencode.ai",
  responsesPath: "/zen/go/v1/responses",
};

const META_PROVIDER = {
  ...ZEN_PROVIDER,
  baseUrl: "https://api.meta.ai/v1",
};

/** A Codex web_search declaration exactly as `hosted_spec.rs` emits it for TextAndImage. */
function webSearchTool(): Record<string, unknown> {
  return {
    type: "web_search",
    search_content_types: ["text", "image"],
    indexed_web_access: true,
    search_context_size: "medium",
  };
}

/** Build one passthrough request for an explicit Responses provider fixture. */
function buildForProvider(
  provider: OcxProviderConfig,
  modelId: string,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId,
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: modelId, input: "ping", ...rawBody },
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

/** Build with the default OpenCode Zen fixture used by the original regressions. */
function build(modelId: string, rawBody: Record<string, unknown>): Record<string, unknown> {
  return buildForProvider(ZEN_PROVIDER, modelId, rawBody);
}

const toolsOf = (body: Record<string, unknown>) => body.tools as Array<Record<string, unknown>>;

/**
 * Muse Spark's Responses gateway 400s a plain `web_search` carrying provider-rejected
 * fields, while accepting the preview shape and a bare `web_search` (#2617, #3378).
 *
 * The field is not ours: Codex emits it from `web_search_tool_type: TextAndImage`. This is
 * the same incompatibility class Codex itself handles for Bedrock by selecting text-only
 * search, so dropping exactly the refused field at the adapter boundary is a compatibility
 * guard rather than a symptom patch — the tool type and every other accepted option survive.
 */
describe("#2617/#3378 Muse Spark web_search compatibility", () => {
  test("drops rejected fields from a plain web_search, keeping the tool and its other fields", () => {
    const body = build("muse-spark-1.2-contributor", { tools: [webSearchTool()] });
    const tool = toolsOf(body)[0]!;
    expect(tool.type).toBe("web_search");
    expect(tool.search_context_size).toBe("medium");
    expect(Object.hasOwn(tool, "search_content_types")).toBe(false);
    expect(Object.hasOwn(tool, "indexed_web_access")).toBe(false);
  });

  test("web_search_preview keeps the field, because the gateway accepts it there", () => {
    const body = build("muse-spark-1.2-contributor", {
      tools: [{ ...webSearchTool(), type: "web_search_preview" }],
    });
    const tool = toolsOf(body)[0]!;
    expect(tool.type).toBe("web_search_preview");
    expect(tool.search_content_types).toEqual(["text", "image"]);
    expect(tool.indexed_web_access).toBe(true);
  });

  test("another model on the same provider is untouched", () => {
    const body = build("gpt-5.6-luna", { tools: [webSearchTool()] });
    expect(toolsOf(body)[0]!.search_content_types).toEqual(["text", "image"]);
    expect(toolsOf(body)[0]!.indexed_web_access).toBe(true);
  });

  test("a nested additional_tools declaration is sanitized too", () => {
    const body = build("muse-spark-1.2-contributor", {
      input: [{ type: "additional_tools", tools: [webSearchTool()] }],
    });
    const item = (body.input as Array<Record<string, unknown>>)[0]!;
    const nested = (item.tools as Array<Record<string, unknown>>)[0]!;
    expect(nested.type).toBe("web_search");
    expect(Object.hasOwn(nested, "search_content_types")).toBe(false);
    expect(Object.hasOwn(nested, "indexed_web_access")).toBe(false);
  });

  test("the registry routes only the named exact models to Responses", () => {
    const defaults = getProviderRegistryEntry("opencode-go")?.modelWireDefaults ?? {};
    expect(defaults["muse-spark-1.3-contributor"]).toBe("openai-responses");
    expect(defaults["muse-spark-1.2-contributor"]).toBe("openai-responses");
    // An exact-model allowlist, not a family rule: a sibling must not be dragged along.
    expect(defaults["muse-spark-1.2"]).toBeUndefined();
    expect(defaults["muse-spark-1.3"]).toBeUndefined();
  });

  /**
   * 1.3 shipped 2026-09-02 on the same Zen wire with the same spec as 1.2. The guard
   * used to be an equality check on the 1.2 id, so selecting 1.3 would have sent the
   * refused field straight through and 400ed every Codex web_search request.
   */
  test("Muse Spark 1.3 Contributor gets the same web_search sanitization", () => {
    const body = build("muse-spark-1.3-contributor", { tools: [webSearchTool()] });
    const tool = toolsOf(body)[0]!;
    expect(tool.type).toBe("web_search");
    expect(tool.search_context_size).toBe("medium");
    expect(Object.hasOwn(tool, "search_content_types")).toBe(false);
    expect(Object.hasOwn(tool, "indexed_web_access")).toBe(false);
  });

  test("1.3 keeps the field on web_search_preview, where the gateway accepts it", () => {
    const body = build("muse-spark-1.3-contributor", {
      tools: [{ ...webSearchTool(), type: "web_search_preview" }],
    });
    const tool = toolsOf(body)[0]!;
    expect(tool.type).toBe("web_search_preview");
    expect(tool.search_content_types).toEqual(["text", "image"]);
    expect(tool.indexed_web_access).toBe(true);
  });

  test("a nested additional_tools declaration is sanitized for 1.3 too", () => {
    const body = build("muse-spark-1.3-contributor", {
      input: [{ type: "additional_tools", tools: [webSearchTool()] }],
    });
    const item = (body.input as Array<Record<string, unknown>>)[0]!;
    const nested = (item.tools as Array<Record<string, unknown>>)[0]!;
    expect(nested.type).toBe("web_search");
    expect(Object.hasOwn(nested, "search_content_types")).toBe(false);
    expect(Object.hasOwn(nested, "indexed_web_access")).toBe(false);
  });

  test("OpenCode Go applies the same Muse compatibility guard", () => {
    const body = buildForProvider(ZEN_GO_PROVIDER, "muse-spark-1.3-contributor", {
      tools: [webSearchTool()],
    });
    const tool = toolsOf(body)[0]!;
    expect(Object.hasOwn(tool, "search_content_types")).toBe(false);
    expect(Object.hasOwn(tool, "indexed_web_access")).toBe(false);
  });

  test("split baseUrl and responsesPath configurations derive both strict destinations", () => {
    for (const provider of [ZEN_PATH_PROVIDER, ZEN_GO_PATH_PROVIDER]) {
      const body = buildForProvider(provider, "muse-spark-1.3-contributor", {
        tools: [webSearchTool()],
      });
      const tool = toolsOf(body)[0]!;
      expect(Object.hasOwn(tool, "search_content_types")).toBe(false);
      expect(Object.hasOwn(tool, "indexed_web_access")).toBe(false);
    }
  });

  test("direct Meta preserves its web_search fields at both tool positions", () => {
    const body = buildForProvider(META_PROVIDER, "muse-spark-1.3-contributor", {
      tools: [webSearchTool()],
      input: [{ type: "additional_tools", tools: [webSearchTool()] }],
    });
    const tool = toolsOf(body)[0]!;
    const item = (body.input as Array<Record<string, unknown>>)[0]!;
    const nested = (item.tools as Array<Record<string, unknown>>)[0]!;
    for (const declaration of [tool, nested]) {
      expect(declaration.search_content_types).toEqual(["text", "image"]);
      expect(declaration.indexed_web_access).toBe(true);
    }
  });
});
