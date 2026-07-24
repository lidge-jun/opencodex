import { describe, expect, test } from "bun:test";
import { parseProviderModelsApiItems } from "../src/codex/catalog/provider-fetch";

describe("provider model catalog envelopes", () => {
  test("normalizes OpenAI, Google/Ollama, and top-level catalog shapes", () => {
    expect(parseProviderModelsApiItems({ data: [{ id: "openai-model" }] })?.map(model => model.id))
      .toEqual(["openai-model"]);
    expect(parseProviderModelsApiItems({ models: [{ name: "models/gemini-flash", inputTokenLimit: 1_000_000 }] }, true))
      .toEqual([{ id: "gemini-flash", context_length: 1_000_000 }]);
    expect(parseProviderModelsApiItems([{ id: "accounts/fireworks/models/llama" }])?.map(model => model.id))
      .toEqual(["llama"]);
  });

  test("rejects malformed rows instead of making an empty catalog authoritative", () => {
    expect(parseProviderModelsApiItems({ models: [{ displayName: "missing id" }] }, true)).toBeNull();
    expect(parseProviderModelsApiItems({ models: [{ name: "   " }] }, true)).toBeNull();
    expect(parseProviderModelsApiItems({ models: [{ name: "models/gemini-flash" }] })).toBeNull();
  });
});
