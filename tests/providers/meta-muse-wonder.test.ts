/**
 * Muse Wonder (muse-wonder-1.0) on Meta's two direct providers.
 *
 * Sources, verified 2026-10-13: dev.meta.ai/docs/models (id, 1,048,576-token window,
 * reasoning effort "minimal" through "max", Model API Standard mode only) and
 * dev.meta.ai/docs/pricing-rate-limits ($4 input / $20 output / $0.20 cached input per 1M).
 * The Spark rows on meta-model keep their xhigh ceiling, so a Wonder-only rung must not
 * leak onto them, and the wire must carry minimal and max unchanged.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { buildCatalogEntries } from "../../src/codex/catalog";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { findExpectedPriceOverlay } from "../../src/usage/expected-prices";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const WONDER = "muse-wonder-1.0";
const WONDER_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
const SPARK_LADDER = ["minimal", "low", "medium", "high", "xhigh"];

function entry(id: "meta-model" | "meta-muse") {
  const found = getProviderRegistryEntry(id);
  if (!found) throw new Error("missing " + id + " registry entry");
  return found;
}

describe("Muse Wonder on the direct Meta providers", () => {
  for (const id of ["meta-model", "meta-muse"] as const) {
    test(id + " serves muse-wonder-1.0 with the published window and text+image input", () => {
      expect(entry(id).models).toContain(WONDER);
      expect(entry(id).modelContextWindows?.[WONDER]).toBe(1_048_576);
      expect(entry(id).modelInputModalities?.[WONDER]).toEqual(["text", "image"]);
      expect(entry(id).modelReasoningEfforts?.[WONDER]).toEqual(WONDER_LADDER);
      // Wonder is in preview; the default stays the recommended Spark model.
      expect(entry(id).defaultModel).toBe("muse-spark-1.3");
    });
  }

  test("the Wonder max rung does not leak onto the meta-model Spark rows", () => {
    for (const spark of ["muse-spark-1.3", "muse-spark-1.3-contributor"]) {
      expect(entry("meta-model").modelReasoningEfforts?.[spark]).toEqual(SPARK_LADDER);
    }
  });

  test("Model API has no Contributor variant of Muse Wonder", () => {
    for (const id of ["meta-model", "meta-muse"] as const) {
      expect(entry(id).models.some(model => model.startsWith("muse-wonder") && model.includes("contributor"))).toBe(false);
    }
  });

  for (const effort of ["minimal", "max"]) {
    test("meta-model sends reasoning.effort " + effort + " for Wonder unchanged", () => {
      const provider = { ...providerConfigSeed(entry("meta-model")), apiKey: "meta-test-key" } as OcxProviderConfig;
      const request = createResponsesPassthroughAdapter(provider).buildRequest({
        modelId: WONDER,
        context: { messages: [] },
        stream: false,
        options: { reasoning: effort },
        _rawBody: { model: WONDER, input: "ping", reasoning: { effort } },
      }, { headers: new Headers() });
      const body = JSON.parse(request.body) as { model?: string; reasoning?: { effort?: string } };
      expect(body.model).toBe(WONDER);
      expect(body.reasoning?.effort).toBe(effort);
    });
  }

  test("the registry seed reaches the Codex catalog row with the 1M window and the full ladder", () => {
    const seed = providerConfigSeed(entry("meta-model"));
    const row = buildCatalogEntries(null, [], [{
      provider: "meta-model",
      id: WONDER,
      owned_by: "meta-model",
      contextWindow: seed.modelContextWindows?.[WONDER],
      inputModalities: seed.modelInputModalities?.[WONDER],
      reasoningEfforts: seed.modelReasoningEfforts?.[WONDER],
    }]).find(candidate => candidate.slug === "meta-model/" + WONDER);
    expect(row?.context_window).toBe(1_048_576);
    expect(row?.input_modalities).toEqual(["text", "image"]);
    const levels = (row?.supported_reasoning_levels ?? []).map(level => level.effort);
    for (const effort of WONDER_LADDER) expect(levels).toContain(effort);
  });

  test("prices Wonder at the published Standard rate on both providers", () => {
    const direct = findExpectedPriceOverlay("meta-model", WONDER);
    expect(direct?.cost4).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
    expect(direct?.status).toBe("verified");
    // The Muse Code credential's settlement is not observable; the public rate is an estimate.
    const derived = findExpectedPriceOverlay("meta-muse", WONDER);
    expect(derived?.cost4).toEqual(direct?.cost4);
    expect(derived?.status).toBe("verified-derived");
  });
});

