/**
 * Flash-route image modality declarations (#4505).
 *
 * opencode-go and command-code each serve a GLM-5.3-Flash route (native VLM) and a
 * DeepSeek V4.1-Flash route. None of the four declared input modalities, so a
 * failover combo over them intersected to ["text"] in deriveComboCatalogModel
 * and the Codex app refused image attachments for the whole combo — combo image
 * routing was silently disabled even though every member can accept an image.
 *
 * command-code's DeepSeek route was promoted from sidecar-covered to native
 * image on 2026-09-18 after the upstream probe #4505 asked for passed on both
 * the user-message and tool-result paths (see model-seeds.ts); opencode-go's
 * route remains text-only and sidecar-covered.
 *
 * The fix is positive per-route modelInputModalities declarations, not a
 * noVisionModels union: a text-only declaration makes the route a sidecar
 * consumer under isModelVisionSidecarConsumer, and applyProviderConfigHints
 * then appends "image" so the app lets attachments through. These tests pin the
 * declarations, the native-vs-sidecar distinction, the catalog advertisement,
 * and the combo intersection they feed.
 */
import { describe, expect, test } from "bun:test";
import {
  applyProviderConfigHints,
  deriveComboCatalogModel,
  gatherRoutedModels,
  nativeContextLimits,
  nativeOpenAiContextWindow,
  nativeOpenAiMaxInputTokens,
} from "../../src/codex/catalog";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../../src/providers/registry";
import { providerConfigSeed } from "../../src/providers/derive";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import { nativeOpenAiAutoCompactTokenLimit } from "../../src/codex/catalog/metadata";
import type { CatalogModel, OcxConfig, OcxProviderConfig } from "../../src/types";

const OPENCODE_GO_NATIVE = "glm-5.3-flash";
/**
 * Reclassified on 2026-09-19: this route used to be the sidecar-covered counterexample, and was
 * probed natively multimodal on the Zen Go gateway. The name says "deepseek" rather than
 * "sidecar"/"native" so a future reclassification does not leave a lying identifier behind.
 */
const OPENCODE_GO_DEEPSEEK = "deepseek-v4.1-flash";
/** The sibling route on the same gateway that genuinely rejects images upstream. */
const OPENCODE_GO_DEEPSEEK_TEXT_ONLY = "deepseek-v4-flash";
const COMMAND_CODE_NATIVE = "z-ai/glm-5.3-flash";
const COMMAND_CODE_DEEPSEEK = "deepseek/deepseek-v4.1-flash";

/** Seeded provider config, shaped the way an install persists it. */
function seeded(provider: string): OcxProviderConfig {
  const entry = getProviderRegistryEntry(provider);
  if (!entry) throw new Error("missing " + provider + " registry fixture");
  return { ...providerConfigSeed(entry), apiKey: "test-key" };
}

describe("flash-route registry modality declarations (#4505)", () => {
  // WHY: the combo collapse starts at the registry — if any of the four routes
  // loses its declaration the member row reaches the catalog with no modalities
  // and the intersection floor drops the whole combo back to ["text"].
  test("opencode-go declares both flash routes image-capable (deepseek probed 2026-09-19)", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    expect(entry?.modelInputModalities?.[OPENCODE_GO_NATIVE]).toEqual(["text", "image"]);
    // Promoted from the text-only list on 2026-09-19: the route accepted an image_url part and
    // described a four-band colour chart in the correct order. Its sibling below did not.
    expect(entry?.modelInputModalities?.[OPENCODE_GO_DEEPSEEK]).toEqual(["text", "image"]);
    // The sibling carries no positive declaration — its classification comes from the
    // noVisionModels list asserted in the test below, which is the half that survives.
    expect(entry?.modelInputModalities?.[OPENCODE_GO_DEEPSEEK_TEXT_ONLY]).toBeUndefined();
  });

  test("the reclassified route is no longer a sidecar consumer", () => {
    // The negative half matters as much as the positive one: a registry correction that left the
    // id in noVisionModels would still strip images, because the predicate reads that list first.
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    expect(entry?.noVisionModels ?? []).not.toContain(OPENCODE_GO_DEEPSEEK);
    // The sibling keeps its classification — it rejects image_url with HTTP 400 upstream.
    expect(entry?.noVisionModels ?? []).toContain(OPENCODE_GO_DEEPSEEK_TEXT_ONLY);
  });

  test("command-code declares both flash routes image-capable (deepseek probed 2026-09-18)", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "command-code");
    expect(entry?.modelInputModalities?.[COMMAND_CODE_NATIVE]).toEqual(["text", "image"]);
    // Promoted from COMMAND_CODE_TEXT_ONLY_MODELS: the upstream probe #4505
    // asked for passed on both the user-message and tool-result paths.
    expect(entry?.modelInputModalities?.[COMMAND_CODE_DEEPSEEK]).toEqual(["text", "image"]);
  });
});

describe("flash-route native vs sidecar distinction (#4505)", () => {
  // WHY: the issue requires routes needing a sidecar to stay distinguishable
  // from native vision. The distinction must follow measured upstream behavior.
  // After the 2026-09-19 probe all four routes read images natively; the sibling
  // opencode-go deepseek-v4-flash is what still exercises the sidecar path here.
  test("the two glm-5.3-flash routes are NOT sidecar consumers (native VLM)", () => {
    expect(isModelVisionSidecarConsumer(seeded("opencode-go"), OPENCODE_GO_NATIVE)).toBe(false);
    expect(isModelVisionSidecarConsumer(seeded("command-code"), COMMAND_CODE_NATIVE)).toBe(false);
  });

  test("the reclassified opencode-go deepseek route is native; its sibling stays on the sidecar", () => {
    expect(isModelVisionSidecarConsumer(seeded("opencode-go"), OPENCODE_GO_DEEPSEEK)).toBe(false);
    expect(isModelVisionSidecarConsumer(seeded("opencode-go"), OPENCODE_GO_DEEPSEEK_TEXT_ONLY)).toBe(true);
    expect(isModelVisionSidecarConsumer(seeded("command-code"), COMMAND_CODE_DEEPSEEK)).toBe(false);
  });
});

describe("flash-route catalog advertisement (#4505)", () => {
  // WHY: the Codex app gates attachments client-side on input_modalities, so the
  // catalog row is where the combo's image capability is actually won or lost.
  // The opencode-go DeepSeek row now carries its own image declaration; the
  // command-code row carries a native one.
  test("applyProviderConfigHints advertises image for deepseek-v4.1-flash on opencode-go", () => {
    const hinted = applyProviderConfigHints("opencode-go", seeded("opencode-go"), {
      id: OPENCODE_GO_DEEPSEEK,
      provider: "opencode-go",
    });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });

  test("the text-only sibling still picks up image from the sidecar hint", () => {
    // The hint pass must keep widening a sidecar-covered row, or the app would block the
    // attachment before the sidecar can describe it.
    const hinted = applyProviderConfigHints("opencode-go", seeded("opencode-go"), {
      id: OPENCODE_GO_DEEPSEEK_TEXT_ONLY,
      provider: "opencode-go",
    });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });

  test("applyProviderConfigHints advertises image for all four routes", () => {
    const cases: Array<[string, string]> = [
      ["opencode-go", OPENCODE_GO_NATIVE],
      ["opencode-go", OPENCODE_GO_DEEPSEEK],
      ["command-code", COMMAND_CODE_NATIVE],
      ["command-code", COMMAND_CODE_DEEPSEEK],
    ];
    for (const [provider, id] of cases) {
      const hinted = applyProviderConfigHints(provider, seeded(provider), { id, provider });
      expect(hinted.inputModalities, provider + "/" + id).toEqual(["text", "image"]);
    }
  });
});

describe("flash-route combo intersection (#4505)", () => {
  // WHY: this is the exact mechanism the issue reported — the combo aggregator
  // intersects member.inputModalities, so the combo only keeps image routing
  // when every member advertises it. Members are produced through the real hint
  // pass on the real seeded configs, not hand-declared, so the test fails if
  // any of the four registry declarations regresses.
  const combo = {
    targets: [
      { provider: "opencode-go", model: OPENCODE_GO_NATIVE },
      { provider: "opencode-go", model: OPENCODE_GO_DEEPSEEK },
      { provider: "command-code", model: COMMAND_CODE_NATIVE },
      { provider: "command-code", model: COMMAND_CODE_DEEPSEEK },
    ],
    defaultEffort: "high",
  } as never;

  const hintedMember = (provider: string, id: string): CatalogModel =>
    applyProviderConfigHints(provider, seeded(provider), {
      id,
      provider,
      contextWindow: 1_000_000,
    });

  test("a combo over the four advertised-image routes keeps image input", () => {
    const members = [
      hintedMember("opencode-go", OPENCODE_GO_NATIVE),
      hintedMember("opencode-go", OPENCODE_GO_DEEPSEEK),
      hintedMember("command-code", COMMAND_CODE_NATIVE),
      hintedMember("command-code", COMMAND_CODE_DEEPSEEK),
    ];
    const derived = deriveComboCatalogModel("flash_failover", combo, members);
    expect(derived?.inputModalities).toEqual(["text", "image"]);
  });

  test("one text-only member collapses the combo to text", () => {
    // Intersection semantics are the guardrail: a member we cannot prove takes
    // images must not let the combo advertise image input, or the app would
    // accept an attachment one leg silently drops.
    const members = [
      hintedMember("opencode-go", OPENCODE_GO_NATIVE),
      hintedMember("opencode-go", OPENCODE_GO_DEEPSEEK),
      hintedMember("command-code", COMMAND_CODE_NATIVE),
      { ...hintedMember("command-code", COMMAND_CODE_DEEPSEEK), inputModalities: ["text"] },
    ];
    const derived = deriveComboCatalogModel("flash_failover", combo, members);
    expect(derived?.inputModalities).toEqual(["text"]);
  });
});

describe("custom-model combo capability alignment (#4689)", () => {
  test("combo derivation sees the explicit custom row before intersecting members", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "issue-4689-custom",
      providers: {
        "issue-4689-custom": {
          adapter: "openai-chat",
          baseUrl: "https://custom.example/v1",
          liveModels: false,
          models: ["manually-added-image-model"],
          modelContextWindows: { "manually-added-image-model": 256_000 },
        },
        "issue-4689-image": {
          adapter: "openai-chat",
          baseUrl: "https://image.example/v1",
          liveModels: false,
          models: ["image-model"],
          modelContextWindows: { "image-model": 128_000 },
          modelInputModalities: { "image-model": ["text", "image"] },
          modelReasoningEfforts: { "image-model": ["low", "high"] },
          codexToolMode: "shell",
        },
      },
      customModels: [{
        id: "custom-image-row",
        provider: "issue-4689-custom",
        modelId: "manually-added-image-model",
        contextWindow: 96_000,
        inputModalities: ["text", "image"],
        reasoningEfforts: ["low", "high"],
        codexToolMode: "shell",
      }],
      combos: {
        image_failover: {
          strategy: "failover",
          targets: [
            { provider: "issue-4689-custom", model: "manually-added-image-model" },
            { provider: "issue-4689-image", model: "image-model" },
          ],
        },
      },
    };

    const models = await gatherRoutedModels(config);
    expect(models.find(model => (
      model.provider === "issue-4689-custom" && model.id === "manually-added-image-model"
    ))?.inputModalities).toEqual(["text", "image"]);
    expect(models.find(model => (
      model.provider === "combo" && model.id === "image_failover"
    ))).toMatchObject({
      contextWindow: 96_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "high"],
      codexToolMode: "shell",
    });
  });

  test("a sparse custom native row retains native limits in an ordinary combo", async () => {
    const slug = "gpt-5.6-luna";
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      customModels: [{ id: "sparse-native-row", provider: "openai", modelId: slug }],
      combos: {
        luna_failover: {
          strategy: "failover",
          targets: [{ provider: "openai", model: slug }],
        },
      },
    };
    const limits = nativeContextLimits(config);
    const expectedContext = nativeOpenAiContextWindow(slug, limits);
    const expectedMaxInput = nativeOpenAiMaxInputTokens(slug, limits);
    const expectedAutoCompact = nativeOpenAiAutoCompactTokenLimit(slug, limits);

    const models = await gatherRoutedModels(config);
    expect(models.find(model => (
      model.provider === "combo" && model.id === "luna_failover"
    ))).toMatchObject({
      contextWindow: expectedContext,
      maxInputTokens: expectedMaxInput,
      autoCompactTokenLimit: expectedAutoCompact,
      inputModalities: ["text", "image"],
    });
  });
});
