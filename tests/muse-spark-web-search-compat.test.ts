import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { getProviderRegistryEntry } from "../src/providers/registry";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const PROVIDER = {
  adapter: "openai-responses",
  baseUrl: "https://opencode.ai/zen/v1",
  apiKey: "test-key",
} as unknown as OcxProviderConfig;

/** A Codex web_search declaration exactly as `hosted_spec.rs` emits it for TextAndImage. */
function webSearchTool(): Record<string, unknown> {
  return {
    type: "web_search",
    search_content_types: ["text", "image"],
    search_context_size: "medium",
  };
}

function build(modelId: string, rawBody: Record<string, unknown>): Record<string, unknown> {
  const request = createResponsesPassthroughAdapter(PROVIDER).buildRequest({
    modelId,
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: modelId, input: "ping", ...rawBody },
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

const toolsOf = (body: Record<string, unknown>) => body.tools as Array<Record<string, unknown>>;

/**
 * Muse Spark's Responses gateway 400s a plain `web_search` carrying
 * `search_content_types`, while accepting the same field on `web_search_preview` and
 * accepting a bare `web_search` (#2617).
 *
 * The field is not ours: Codex emits it from `web_search_tool_type: TextAndImage`. This is
 * the same incompatibility class Codex itself handles for Bedrock by selecting text-only
 * search, so dropping exactly the refused field at the adapter boundary is a compatibility
 * guard rather than a symptom patch — the tool type and every other accepted option survive.
 */
describe("#2617 Muse Spark web_search compatibility", () => {
  test("drops search_content_types from a plain web_search, keeping the tool and its other fields", () => {
    const body = build("muse-spark-1.2-contributor", { tools: [webSearchTool()] });
    const tool = toolsOf(body)[0]!;
    expect(tool.type).toBe("web_search");
    expect(tool.search_context_size).toBe("medium");
    expect(Object.hasOwn(tool, "search_content_types")).toBe(false);
  });

  test("web_search_preview keeps the field, because the gateway accepts it there", () => {
    const body = build("muse-spark-1.2-contributor", {
      tools: [{ ...webSearchTool(), type: "web_search_preview" }],
    });
    const tool = toolsOf(body)[0]!;
    expect(tool.type).toBe("web_search_preview");
    expect(tool.search_content_types).toEqual(["text", "image"]);
  });

  test("another model on the same provider is untouched", () => {
    const body = build("gpt-5.6-luna", { tools: [webSearchTool()] });
    expect(toolsOf(body)[0]!.search_content_types).toEqual(["text", "image"]);
  });

  test("a nested additional_tools declaration is sanitized too", () => {
    const body = build("muse-spark-1.2-contributor", {
      input: [{ type: "additional_tools", tools: [webSearchTool()] }],
    });
    const item = (body.input as Array<Record<string, unknown>>)[0]!;
    const nested = (item.tools as Array<Record<string, unknown>>)[0]!;
    expect(nested.type).toBe("web_search");
    expect(Object.hasOwn(nested, "search_content_types")).toBe(false);
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
  });

  test("1.3 keeps the field on web_search_preview, where the gateway accepts it", () => {
    const body = build("muse-spark-1.3-contributor", {
      tools: [{ ...webSearchTool(), type: "web_search_preview" }],
    });
    const tool = toolsOf(body)[0]!;
    expect(tool.type).toBe("web_search_preview");
    expect(tool.search_content_types).toEqual(["text", "image"]);
  });

  test("a nested additional_tools declaration is sanitized for 1.3 too", () => {
    const body = build("muse-spark-1.3-contributor", {
      input: [{ type: "additional_tools", tools: [webSearchTool()] }],
    });
    const item = (body.input as Array<Record<string, unknown>>)[0]!;
    const nested = (item.tools as Array<Record<string, unknown>>)[0]!;
    expect(nested.type).toBe("web_search");
    expect(Object.hasOwn(nested, "search_content_types")).toBe(false);
  });
});
