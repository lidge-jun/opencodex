import { describe, expect, test } from "bun:test";
import { catalogHintsFromModelsApiItem } from "../../src/codex/catalog/provider-fetch";

/**
 * Regression coverage for #4032 (chained clients / provider hub).
 *
 * A hub that re-serves an upstream catalog reports the per-model window under
 * `capabilities.context_length`. `catalogHintsFromModelsApiItem` already read that
 * same record for `max_output_tokens`, but never for the context window, so every
 * routed row fell through to the 128k compatibility floor in parsing.ts while local
 * forward rows kept their real values.
 *
 * The capability field is appended AFTER the recognized metadata/limits fields and
 * after the Copilot-specific `capabilities.limits.max_context_window_tokens`, so no
 * provider that already resolved a window changes behaviour.
 */

const HUB_MODELS_ITEM = {
  id: "anthropic/claude-opus-5",
  object: "model" as const,
  owned_by: "opencodex-hub",
  capabilities: {
    context_length: 922000,
    max_output_tokens: 64000,
  },
};

describe("provider-hub capabilities.context_length (#4032)", () => {
  test("absorbs capabilities.context_length from a hub-shaped /v1/models item", () => {
    const hints = catalogHintsFromModelsApiItem("hub", HUB_MODELS_ITEM);
    expect(hints.contextWindow).toBe(922000);
  });

  test("the same record still yields max_output_tokens (asymmetry is gone)", () => {
    const hints = catalogHintsFromModelsApiItem("hub", HUB_MODELS_ITEM);
    expect(hints.maxOutputTokens).toBe(64000);
  });

  test("reads the capability record from metadata.capabilities too", () => {
    const hints = catalogHintsFromModelsApiItem("hub", {
      id: "meta-shaped",
      metadata: { capabilities: { context_length: 400000 } },
    });
    expect(hints.contextWindow).toBe(400000);
  });

  test("a recognized context field still wins over the capability record", () => {
    // Contested on purpose: the capability field is appended last so no provider
    // already supplying a recognized field changes behaviour.
    const hints = catalogHintsFromModelsApiItem("hub", {
      id: "both",
      context_length: 32768,
      capabilities: { context_length: 922000 },
    });
    expect(hints.contextWindow).toBe(32768);
  });

  test("Copilot's max_context_window_tokens still wins over the capability record", () => {
    const hints = catalogHintsFromModelsApiItem("copilot", {
      id: "gpt-5.6-sol",
      capabilities: { context_length: 922000, limits: { max_context_window_tokens: 128000 } },
    });
    expect(hints.contextWindow).toBe(128000);
  });

  test("a non-positive or non-integer capability window is ignored", () => {
    expect(catalogHintsFromModelsApiItem("hub", { id: "zero", capabilities: { context_length: 0 } }).contextWindow).toBeUndefined();
    expect(catalogHintsFromModelsApiItem("hub", { id: "neg", capabilities: { context_length: -1 } }).contextWindow).toBeUndefined();
    expect(catalogHintsFromModelsApiItem("hub", { id: "str", capabilities: { context_length: "922000" } }).contextWindow).toBeUndefined();
  });
});
