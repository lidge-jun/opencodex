import { afterEach, describe, expect, test } from "bun:test";
import { applyProviderConfigHints, gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import type { OcxProviderConfig } from "../src/types";

const base: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://opencode.ai/zen/go/v1",
  noVisionModels: ["glm-5.2"],
};

describe("vision-sidecar catalog modalities", () => {
  test("noVisionModels models advertise image input (sidecar gives them eyes)", () => {
    const hinted = applyProviderConfigHints("opencode-go", base, { id: "glm-5.2", provider: "opencode-go" });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });

  test("suffixed ids ([1m]-style colon variants) inherit the base model's coverage", () => {
    const hinted = applyProviderConfigHints("opencode-go", base, { id: "glm-5.2:extended", provider: "opencode-go" });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });

  test("models outside noVisionModels keep their existing modalities untouched", () => {
    const hinted = applyProviderConfigHints("opencode-go", base, {
      id: "kimi-k2.7-code", provider: "opencode-go", inputModalities: ["text", "image", "video"],
    });
    expect(hinted.inputModalities).toEqual(["text", "image", "video"]);
    const plain = applyProviderConfigHints("opencode-go", base, { id: "kimi-k2.7-code", provider: "opencode-go" });
    expect(plain.inputModalities).toBeUndefined();
  });

  test("image is not duplicated when the listing already advertises it", () => {
    const hinted = applyProviderConfigHints("opencode-go", base, {
      id: "glm-5.2", provider: "opencode-go", inputModalities: ["text", "image"],
    });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });

  test("explicit modelInputModalities config still wins as the base, plus image", () => {
    const prov: OcxProviderConfig = { ...base, modelInputModalities: { "glm-5.2": ["text"] } };
    const hinted = applyProviderConfigHints("opencode-go", prov, { id: "glm-5.2", provider: "opencode-go" });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });
});

describe("vision-sidecar custom-model override (#349/#344)", () => {
  afterEach(() => clearModelCache("opencode-go"));

  test("a noVisionModels custom row still advertises image input through gatherRoutedModels", async () => {
    // Regression: customModels used to bypass applyProviderConfigHints, so a noVisionModels-tagged
    // custom override was re-advertised text-only and the Codex app blocked images before the
    // vision sidecar could run. The image augmentation must come from the REGISTRY-enriched clone,
    // so we deliberately do NOT set noVisionModels on the persisted provider — opencode-go's
    // registry entry classifies glm-5.2 as text-only, and enrichment must supply it.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("fetch should not be called"); }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "opencode-go",
        providers: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["baseline-model"],
          },
        },
        customModels: [
          { id: "cm-1", provider: "opencode-go", modelId: "glm-5.2", displayName: "GLM 5.2", addedAt: "2026-01-01T00:00:00.000Z" },
        ],
      });
      const custom = models.find(m => m.provider === "opencode-go" && m.id === "glm-5.2");
      expect(custom).toBeDefined();
      expect(custom?.inputModalities).toEqual(["text", "image"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a custom row NOT in noVisionModels keeps its declared modalities untouched", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("fetch should not be called"); }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "opencode-go",
        providers: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["baseline-model"],
            noVisionModels: ["glm-5.2"],
          },
        },
        customModels: [
          { id: "cm-2", provider: "opencode-go", modelId: "kimi-text", inputModalities: ["text"], addedAt: "2026-01-01T00:00:00.000Z" },
        ],
      });
      const custom = models.find(m => m.provider === "opencode-go" && m.id === "kimi-text");
      expect(custom?.inputModalities).toEqual(["text"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the image augmentation does NOT overwrite a custom row's explicit context/modalities/reasoning", async () => {
    // The augmentation must be narrow: for a noVisionModels custom row we only ADD image; every
    // other explicitly configured custom field (contextWindow, extra modalities) stays verbatim,
    // and no registry reasoning metadata leaks onto the user override.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("fetch should not be called"); }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        port: 10100,
        defaultProvider: "opencode-go",
        providers: {
          "opencode-go": {
            baseUrl: "https://opencode.ai/zen/go/v1",
            adapter: "openai-chat",
            authMode: "key",
            liveModels: false,
            models: ["baseline-model"],
          },
        },
        customModels: [
          { id: "cm-3", provider: "opencode-go", modelId: "glm-5.2", contextWindow: 2_000_000, inputModalities: ["text", "video"], addedAt: "2026-01-01T00:00:00.000Z" },
        ],
      });
      const custom = models.find(m => m.provider === "opencode-go" && m.id === "glm-5.2");
      // image is appended to the user's declared modalities (not replaced), context is preserved,
      // and no registry reasoning fields were injected onto the custom override.
      expect(custom?.inputModalities).toEqual(["text", "video", "image"]);
      expect(custom?.contextWindow).toBe(2_000_000);
      expect(custom?.reasoningEfforts).toBeUndefined();
      expect(custom?.defaultReasoningEffort).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
