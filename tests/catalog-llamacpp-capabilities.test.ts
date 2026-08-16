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

  test("the dual-envelope body now yields BOTH context and image evidence", () => {
    // Was a characterization of the #1797 gap: the multimodal token lived in
    // models[] while discovery read only data[], so the row stayed image-blind.
    // Both halves are now joined on exact id, and multimodal maps to image.
    const extracted = extractProviderModelItems(VERBATIM_LLAMACPP_BODY, {
      maxModels: 100,
    } as never);
    expect(extracted.ok).toBe(true);
    const items = (extracted as { ok: true; items: Array<Record<string, unknown>> }).items;
    expect(items.length).toBe(1);

    const hints = catalogHintsFromModelsApiItem("lidge", items[0] as never);
    expect(hints.contextWindow).toBe(262144);
    expect(hints.inputModalities).toEqual(["text", "image"]);
  });

  test("a data[] value is never overridden by its sibling", () => {
    // models[] is exactly the key discovery refuses to trust as a source of
    // models. Enrichment fills only ABSENT keys, so an authoritative data[]
    // entry always wins.
    const extracted = extractProviderModelItems({
      models: [{ id: "m", context_length: 999 }],
      data: [{ id: "m", context_length: 111 }],
    }, { maxModels: 100 } as never);
    const items = (extracted as { ok: true; items: Array<Record<string, unknown>> }).items;
    expect(items[0]!.context_length).toBe(111);
  });

  test("a model present only in the sibling array is still ignored", () => {
    // Membership is decided entirely by data[]; the conservative boundary that
    // refuses a stray models key is preserved.
    const extracted = extractProviderModelItems({
      models: [{ id: "ghost" }],
      data: [{ id: "real" }],
    }, { maxModels: 100 } as never);
    const items = (extracted as { ok: true; items: Array<Record<string, unknown>> }).items;
    expect(items.map(i => i.id)).toEqual(["real"]);
  });

  test("an ambiguous sibling id is skipped rather than guessed", () => {
    const extracted = extractProviderModelItems({
      models: [{ id: "m", context_length: 999 }, { id: "m", context_length: 555 }],
      data: [{ id: "m" }],
    }, { maxModels: 100 } as never);
    const items = (extracted as { ok: true; items: Array<Record<string, unknown>> }).items;
    expect(items[0]!.context_length).toBeUndefined();
  });
  test("sibling metadata cannot admit a model the provider filter rejects", () => {
    // Enrichment used to run BEFORE admission filtering, so a models[] entry
    // could supply the exact field a filter required. Reproduced against the
    // real Chutes policy: a row without supported_features:["tools"] was
    // admitted once a same-id sibling provided it. Enrichment may change what
    // is KNOWN about a model, never WHICH models are published.
    const extracted = extractProviderModelItems({
      models: [{ id: "not-proven-tool-capable", supported_features: ["tools"] }],
      data: [{ id: "not-proven-tool-capable" }],
    }, {
      maxModels: 100,
      spec: { filter: { allOf: [{ path: ["supported_features"], containsAny: ["tools"] }] } },
    } as never);

    const items = (extracted as { ok: true; items: Array<Record<string, unknown>> }).items;
    expect(items).toEqual([]);
  });

  test("only capability keys are enriched, not arbitrary fields", () => {
    // A blanket fill-every-absent-key made the untrusted models[] array a way
    // into any field the pipeline consumes.
    const extracted = extractProviderModelItems({
      models: [{ id: "m", context_length: 999, owned_by: "hostile" }],
      data: [{ id: "m" }],
    }, { maxModels: 100 } as never);

    const items = (extracted as { ok: true; items: Array<Record<string, unknown>> }).items;
    expect(items[0]).toEqual({ id: "m" });
  });
});
