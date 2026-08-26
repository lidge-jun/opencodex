import { afterEach, describe, expect, test } from "bun:test";
import { applyProviderConfigHints, gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import type { OcxProviderConfig } from "../src/types";
import { deriveComboCatalogModel } from "../src/codex/catalog";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { enrichProviderFromRegistry } from "../src/providers/derive";
import { CURSOR_NO_VISION_MODELS, CURSOR_STATIC_MODELS } from "../src/adapters/cursor/discovery";
import { modelInList } from "../src/types";
import type { CatalogModel } from "../src/types";

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

  test("MiMo token-plan sends only the Pro model through the sidecar (#1927)", () => {
    const canonical: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      authMode: "key",
    };
    enrichProviderFromRegistry("mimo", canonical);
    expect(canonical.noVisionModels).toEqual(["mimo-v2.5-pro"]);
    expect(applyProviderConfigHints("mimo", canonical, {
      id: "mimo-v2.5-pro",
      provider: "mimo",
    }).inputModalities).toEqual(["text", "image"]);
    expect(applyProviderConfigHints("mimo", canonical, {
      id: "mimo-v2.5",
      provider: "mimo",
    }).inputModalities).toBeUndefined();

    const customDestination: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://mimo-compatible.example/v1",
      authMode: "key",
    };
    enrichProviderFromRegistry("mimo", customDestination);
    expect(customDestination.noVisionModels).toBeUndefined();
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

describe("vision-capable provider models feed combo modalities", () => {
  // Regression: xAI declared no modelInputModalities, so xai/grok-4.5 reached
  // deriveComboCatalogModel with inputModalities undefined. The combo aggregator
  // defaults an undefined member to ["text"], so every combo containing an xAI
  // target was advertised to Codex as text-only and the app refused image
  // attachments client-side before any request was made.
  test("xAI grok chat models declare image input in the registry", () => {
    const xai = PROVIDER_REGISTRY.find(entry => entry.id === "xai");
    for (const model of [
      "grok-4.6",
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
    ]) {
      expect(xai?.modelInputModalities?.[model]).toEqual(["text", "image"]);
    }
    // Text-only members stay out of the vision map (they are already in noVisionModels).
    for (const model of ["grok-build-0.1", "grok-composer-2.5-fast"]) {
      expect(xai?.modelInputModalities?.[model]).toBeUndefined();
      expect(xai?.noVisionModels).toContain(model);
    }
  });

  test("a combo of two vision-capable members still advertises image", () => {
    const member = (provider: string, contextWindow: number): CatalogModel => ({
      provider,
      id: "grok-4.5",
      contextWindow,
      inputModalities: ["text", "image"],
    } as CatalogModel);
    const derived = deriveComboCatalogModel(
      "xai_grok_fallback",
      {
        targets: [
          { provider: "xai", model: "grok-4.5" },
          { provider: "cursor", model: "grok-4.5" },
        ],
        defaultEffort: "high",
      } as never,
      [member("xai", 500_000), member("cursor", 200_000)],
    );
    expect(derived?.inputModalities).toEqual(["text", "image"]);
  });

  test("a member with unknown modalities still narrows the combo to text", () => {
    // Intersection semantics are intentional: a member we cannot prove is
    // vision-capable must not let the combo advertise image input.
    const derived = deriveComboCatalogModel(
      "mixed",
      {
        targets: [
          { provider: "xai", model: "grok-4.5" },
          { provider: "other", model: "text-only" },
        ],
        defaultEffort: "high",
      } as never,
      [
        { provider: "xai", id: "grok-4.5", contextWindow: 500_000, inputModalities: ["text", "image"] } as CatalogModel,
        { provider: "other", id: "text-only", contextWindow: 100_000 } as CatalogModel,
      ],
    );
    expect(derived?.inputModalities).toEqual(["text"]);
  });

  test("a partial user modality map does not hide registry vision defaults", () => {
    // Regression: enrichProviderFromRegistry filled modelInputModalities all-or-nothing, so a
    // single customized model suppressed the registry's knowledge about every other model and
    // left vision-capable ids advertising no image support (collapsing combos to text-only).
    // Routing already merged these maps per key; catalog enrichment must match.
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      modelInputModalities: { "grok-4.3": ["text"] },
    } as OcxProviderConfig;
    enrichProviderFromRegistry("xai", prov);
    // The user's explicit narrowing still wins.
    expect(prov.modelInputModalities?.["grok-4.3"]).toEqual(["text"]);
    // Registry defaults fill in beneath it instead of being skipped wholesale.
    expect(prov.modelInputModalities?.["grok-4.5"]).toEqual(["text", "image"]);
    const hinted = applyProviderConfigHints("xai", prov, { provider: "xai", id: "grok-4.5" });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });
});

describe("Cursor native vs sidecar vision registry", () => {
  test("curates noVisionModels for Auto/Composer/GLM while advertising image for all static ids", () => {
    const cursor = PROVIDER_REGISTRY.find(entry => entry.id === "cursor");
    expect(cursor?.noVisionModels).toEqual([...CURSOR_NO_VISION_MODELS]);
    for (const model of ["auto", "composer-1", "composer-2.5", "composer-2.5-fast", "glm-5.2", "glm-5.3"]) {
      expect(modelInList(cursor?.noVisionModels, model), `${model} should match noVision`).toBe(true);
    }
    for (const model of ["auto", "composer-2.5", "glm-5.2", "glm-5.3", "gpt-5.5", "gemini-3-pro", "grok-4.5", "kimi-k3"]) {
      expect(cursor?.modelInputModalities?.[model]).toEqual(["text", "image"]);
    }
    for (const model of ["gpt-5.5", "gemini-3-pro", "grok-4.5", "kimi-k3"]) {
      expect(modelInList(cursor?.noVisionModels, model)).toBe(false);
    }
    for (const model of CURSOR_STATIC_MODELS) {
      expect(cursor?.modelInputModalities?.[model.id]).toEqual(["text", "image"]);
    }
  });
});
