import { expect, test } from "bun:test";
import { buildCatalogEntries, gatherRoutedModels } from "../src/codex/catalog";

test("custom rows retain declared metadata while inheriting provider capability hints", async () => {
  const models = await gatherRoutedModels({
    port: 10100,
    defaultProvider: "ollama",
    providers: {
      ollama: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        liveModels: false,
        models: ["qwen-coder-3b"],
        modelContextWindows: { "qwen-coder-3b": 32_768 },
        modelInputModalities: { "qwen-coder-3b": ["text", "image"] },
        modelReasoningEfforts: { "qwen-coder-3b": [] },
      },
    },
    customModels: [{
      id: "qwen-coder-3b-custom",
      provider: "ollama",
      modelId: "qwen-coder-3b",
      displayName: "Qwen Coder 3B",
      contextWindow: 65_536,
      inputModalities: ["text"],
      addedAt: "2026-08-03T00:00:00.000Z",
    }],
  });

  const custom = models.filter(model => model.provider === "ollama" && model.id === "qwen-coder-3b");
  expect(custom).toHaveLength(1);
  expect(custom[0]).toMatchObject({
    displayName: "Qwen Coder 3B",
    contextWindow: 65_536,
    inputModalities: ["text"],
    reasoningEfforts: [],
  });

  const entry = buildCatalogEntries(null, [], models).find(candidate => candidate.slug === "ollama/qwen-coder-3b");
  expect(entry?.supported_reasoning_levels).toEqual([]);
  expect(entry).not.toHaveProperty("default_reasoning_level");
});
