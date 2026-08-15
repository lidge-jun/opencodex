import { describe, expect, test } from "bun:test";
import { catalogHintsFromModelsApiItem } from "../src/codex/catalog/provider-fetch";
import { extractProviderModelItems } from "../src/providers/model-discovery";

/**
 * Regression coverage for the context half of #1797.
 *
 * A llama.cpp server reports its served context under `meta.n_ctx`, which was in
 * none of the recognized context fields, so a correct local server produced no
 * context evidence at all.
 *
 * The image half of #1797 is NOT fixed here and is characterized below: the
 * `multimodal` token lives in the Ollama-style `models[]` array while discovery
 * deliberately reads only `data[]`, and even a merged item would stay
 * image-unknown because `multimodal` is not a recognized capability string.
 */

const VERBATIM_LLAMACPP_BODY = {
  models: [{
    name: "qwen3.8-27b-nvfp4",
    model: "qwen3.8-27b-nvfp4",
    capabilities: ["completion", "multimodal"],
    details: { format: "gguf" },
  }],
  object: "list",
  data: [{
    id: "qwen3.8-27b-nvfp4",
    object: "model",
    owned_by: "llamacpp",
    meta: { n_ctx: 262144, n_ctx_train: 262144, n_vocab: 248320, n_embd: 5120 },
  }],
};

describe("llama.cpp served context ingestion (#1797)", () => {
  test("absorbs meta.n_ctx from the verbatim data[] item", () => {
    const hints = catalogHintsFromModelsApiItem("lidge", {
      id: "qwen3.8-27b-nvfp4",
      object: "model",
      owned_by: "llamacpp",
      meta: { n_ctx: 262144, n_ctx_train: 262144 },
    });
    expect(hints.contextWindow).toBe(262144);
  });

  test("prefers the served n_ctx over the trained maximum", () => {
    // Routing must not promise a window the running server will refuse.
    const hints = catalogHintsFromModelsApiItem("lidge", {
      id: "short-ctx",
      meta: { n_ctx: 8192, n_ctx_train: 262144 },
    });
    expect(hints.contextWindow).toBe(8192);
  });

  test("a recognized context field still wins over meta", () => {
    // Contested on purpose: meta entries are appended last so no provider
    // already supplying a recognized field changes behavior.
    const hints = catalogHintsFromModelsApiItem("lidge", {
      id: "both",
      context_length: 32768,
      meta: { n_ctx: 8192 },
    });
    expect(hints.contextWindow).toBe(32768);
  });

  test("the dual-envelope body yields context but still no image evidence", () => {
    // Characterization of the KNOWN remaining gap in #1797, so the follow-up fix
    // has a live witness and a test to flip rather than a prose claim.
    const extracted = extractProviderModelItems(VERBATIM_LLAMACPP_BODY, {
      maxModels: 100,
    } as never);
    expect(extracted.ok).toBe(true);
    const items = (extracted as { ok: true; items: Array<Record<string, unknown>> }).items;
    expect(items.length).toBe(1);

    const hints = catalogHintsFromModelsApiItem("lidge", items[0] as never);
    expect(hints.contextWindow).toBe(262144);
    // The "multimodal" token was discarded with models[]; unknown, never false.
    expect(hints.inputModalities).toBeUndefined();
  });
});
