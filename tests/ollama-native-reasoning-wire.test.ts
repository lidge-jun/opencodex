import { describe, expect, test } from "bun:test";
import { createOllamaNativeAdapter } from "../src/adapters/ollama-native";
import { buildCatalogEntries, gatherRoutedModels as gatherRoutedModelsDirect } from "../src/codex/catalog";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import { REASONING_EFFORT_OMIT_SENTINEL } from "../src/reasoning-effort";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

/**
 * The wire-level reasoning invariant.
 *
 * Upstream DELIBERATELY advertises synthetic max/ultra rungs on reasoning-capable routed rows:
 * Codex and subagent spawns validate requested efforts against catalog membership, so a missing
 * top rung hard-fails spawn_agent effort overrides. The wire stays honest because the native
 * adapter clamps the requested effort onto the provider's real supported ladder. These tests pin
 * the WIRE behavior (what actually reaches /api/chat), not the catalog shape.
 */
function provider(modelReasoningEfforts: Record<string, string[]>): OcxProviderConfig {
  return {
    adapter: "ollama-native",
    baseUrl: "https://ollama.com/v1",
    authMode: "key",
    apiKey: "test-key-not-a-real-credential",
    liveModels: false,
    models: ["deepseek-v4-flash:0731"],
    modelReasoningEfforts: modelReasoningEfforts,
  } as OcxProviderConfig;
}

function parsedWith(options: Record<string, unknown>, modelId = "deepseek-v4-flash:0731"): OcxParsedRequest {
  return { modelId, stream: true, options, context: { messages: [{ role: "user", content: "hi" }] } } as unknown as OcxParsedRequest;
}

describe("ollama-native — reasoning wire clamp (catalog universality preserved)", () => {
  test("RED/GREEN: synthetic catalog rungs do NOT leak unsupported think values onto the wire", async () => {
    // Real provider ladder is only [low, medium, high]. The catalog advertises the synthetic
    // max/ultra rungs (upstream requirement); a max or ultra request must serialize the CLAMPED
    // supported value, never an unsupported one.
    const adapter = createOllamaNativeAdapter(provider({ "deepseek-v4-flash:0731": ["low", "medium", "high"] }));
    for (const requested of ["max", "ultra"]) {
      const { body } = await adapter.buildRequest(parsedWith({ reasoning: requested }));
      const think = JSON.parse(String(body)).think;
      expect(think, `requested=${requested}`).toBe("high");
    }
    // In-ladder values pass through unchanged.
    for (const [requested, expected] of [["low", "low"], ["medium", "medium"], ["high", "high"]] as const) {
      const { body } = await adapter.buildRequest(parsedWith({ reasoning: requested }));
      expect(JSON.parse(String(body)).think).toBe(expected);
    }
    // And the catalog really does advertise the synthetic rungs this clamp exists for.
    const models = await gatherRoutedModels({ providers: { "ollama-cloud": provider({ "deepseek-v4-flash:0731": ["low", "medium", "high"] }) } } as never);
    const entries = buildCatalogEntries(null, [], models);
    const levels = ((entries.find(e => e.slug === "ollama-cloud/deepseek-v4-flash:0731")?.supported_reasoning_levels ?? []) as Array<{ effort?: string }>).map(l => l.effort);
    expect(levels).toEqual(["low", "medium", "high", "max", "ultra"]);
  });

  test("an explicit __omit__ mapping leaves the reasoning field OFF the wire", async () => {
    const adapter = createOllamaNativeAdapter(provider({
      "deepseek-v4-flash:0731": ["low", "medium", "high"],
    }));
    // Drive the omit sentinel through a provider reasoning map: max -> __omit__.
    const omitting = createOllamaNativeAdapter({
      ...provider({ "deepseek-v4-flash:0731": ["low", "medium", "high"] }),
      modelReasoningEffortMap: { "deepseek-v4-flash:0731": { max: REASONING_EFFORT_OMIT_SENTINEL } },
    } as never);
    const { body } = await omitting.buildRequest(parsedWith({ reasoning: "max" }));
    const parsed = JSON.parse(String(body));
    expect(parsed).not.toHaveProperty("think");
    void adapter;
  });

  test("a low-effort request on an omit-mapped model stays omitted", async () => {
    const omitting = createOllamaNativeAdapter({
      ...provider({ "deepseek-v4-flash:0731": ["low", "medium", "high"] }),
      modelReasoningEffortMap: { "deepseek-v4-flash:0731": { low: REASONING_EFFORT_OMIT_SENTINEL } },
    } as never);
    const { body } = await omitting.buildRequest(parsedWith({ reasoning: "low" }));
    expect(JSON.parse(String(body))).not.toHaveProperty("think");
  });
});

describe("ollama — post-clamp __omit__ sentinel (V9)", () => {
  test("RED (V8 semantics) / GREEN: wireMap.high=__omit__ + requested max omits the field, never think:max", async () => {
    const adapter = createOllamaNativeAdapter({
      ...provider({ "deepseek-v4-flash:0731": ["low", "medium", "high"] }),
      modelReasoningEffortMap: { "deepseek-v4-flash:0731": { high: REASONING_EFFORT_OMIT_SENTINEL } },
    } as never);
    const { body } = await adapter.buildRequest(parsedWith({ reasoning: "max" }));
    // mapReasoningEffort clamps max -> high; the wire rung's __omit__ mapping is authoritative.
    expect(JSON.parse(String(body))).not.toHaveProperty("think");
  });

  test("GREEN: ultra with max->high clamp still serializes high (boundary-first preserved)", async () => {
    const adapter = createOllamaNativeAdapter({
      ...provider({ "deepseek-v4-flash:0731": ["low", "medium", "high"] }),
      modelReasoningEffortMap: { "deepseek-v4-flash:0731": { ultra: REASONING_EFFORT_OMIT_SENTINEL, max: "high" } },
    } as never);
    const { body } = await adapter.buildRequest(parsedWith({ reasoning: "ultra" }));
    expect(JSON.parse(String(body)).think).toBe("high");
  });

  test("GREEN: none -> __omit__ omits; none without a mapping still serializes think:false", async () => {
    const omitting = createOllamaNativeAdapter({
      ...provider({ "deepseek-v4-flash:0731": ["low", "medium", "high"] }),
      modelReasoningEffortMap: { "deepseek-v4-flash:0731": { none: REASONING_EFFORT_OMIT_SENTINEL } },
    } as never);
    const { body } = await omitting.buildRequest(parsedWith({ reasoning: "none" }));
    expect(JSON.parse(String(body))).not.toHaveProperty("think");

    const plain = createOllamaNativeAdapter(provider({ "deepseek-v4-flash:0731": ["low", "medium", "high"] }));
    const plainBuilt = await plain.buildRequest(parsedWith({ reasoning: "none" }));
    expect(JSON.parse(String(plainBuilt.body)).think).toBe(false);
  });

  test("GREEN: the clamp itself is unchanged (max/ultra -> high with no omit mapping)", async () => {
    const adapter = createOllamaNativeAdapter(provider({ "deepseek-v4-flash:0731": ["low", "medium", "high"] }));
    for (const requested of ["max", "ultra"]) {
      const { body } = await adapter.buildRequest(parsedWith({ reasoning: requested }));
      expect(JSON.parse(String(body)).think).toBe("high");
    }
  });
});
