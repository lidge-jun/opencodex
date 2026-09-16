/**
 * Flash-route image modality declarations (#4505).
 *
 * opencode-go and command-code each serve a GLM-5.3-Flash route (native VLM) and a
 * DeepSeek V4.1-Flash route (text-only upstream, covered by the vision sidecar).
 * None of the four declared input modalities, so a failover combo over them
 * intersected to ["text"] in deriveComboCatalogModel and the Codex app refused
 * image attachments for the whole combo — combo image routing was silently
 * disabled even though every member can accept an image (two natively, two
 * through the sidecar).
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
const OPENCODE_GO_SIDECAR = "deepseek-v4.1-flash";
const COMMAND_CODE_NATIVE = "z-ai/glm-5.3-flash";
const COMMAND_CODE_SIDECAR = "deepseek/deepseek-v4.1-flash";

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
  test("opencode-go declares glm-5.3-flash native vision and deepseek-v4.1-flash text-only", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    expect(entry?.modelInputModalities?.[OPENCODE_GO_NATIVE]).toEqual(["text", "image"]);
    expect(entry?.modelInputModalities?.[OPENCODE_GO_SIDECAR]).toEqual(["text"]);
  });

  test("command-code declares z-ai/glm-5.3-flash in the image set and deepseek/deepseek-v4.1-flash text-only", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "command-code");
    expect(entry?.modelInputModalities?.[COMMAND_CODE_NATIVE]).toEqual(["text", "image"]);
    // The text-only declaration must NOT come from the image allowlist: putting
    // a DeepSeek route in COMMAND_CODE_IMAGE_MODELS would advertise native
    // vision for a model that drops the image upstream.
    expect(entry?.modelInputModalities?.[COMMAND_CODE_SIDECAR]).toEqual(["text"]);
  });
});

describe("flash-route native vs sidecar distinction (#4505)", () => {
  // WHY: the issue requires routes needing a sidecar to stay distinguishable
  // from native vision. A wrong fix that declares DeepSeek ["text","image"]
  // passes an "everything says image" test while the upstream model silently
  // drops the picture — the sidecar distinction is what keeps the image on a
  // path that actually reads it.
  test("the two glm-5.3-flash routes are NOT sidecar consumers (native VLM)", () => {
    expect(isModelVisionSidecarConsumer(seeded("opencode-go"), OPENCODE_GO_NATIVE)).toBe(false);
    expect(isModelVisionSidecarConsumer(seeded("command-code"), COMMAND_CODE_NATIVE)).toBe(false);
  });

  test("the two deepseek-v4.1-flash routes ARE sidecar consumers (text-only upstream)", () => {
    expect(isModelVisionSidecarConsumer(seeded("opencode-go"), OPENCODE_GO_SIDECAR)).toBe(true);
    expect(isModelVisionSidecarConsumer(seeded("command-code"), COMMAND_CODE_SIDECAR)).toBe(true);
  });
});

describe("flash-route catalog advertisement (#4505)", () => {
  // WHY: the Codex app gates attachments client-side on input_modalities, so the
  // catalog row is where the combo's image capability is actually won or lost.
  // The DeepSeek rows must pick up "image" from the sidecar hint, not from a
  // native claim.
  test("applyProviderConfigHints advertises image for sidecar-covered deepseek-v4.1-flash on opencode-go", () => {
    const hinted = applyProviderConfigHints("opencode-go", seeded("opencode-go"), {
      id: OPENCODE_GO_SIDECAR,
      provider: "opencode-go",
    });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });

  test("applyProviderConfigHints advertises image for all four routes", () => {
    const cases: Array<[string, string]> = [
      ["opencode-go", OPENCODE_GO_NATIVE],
      ["opencode-go", OPENCODE_GO_SIDECAR],
      ["command-code", COMMAND_CODE_NATIVE],
      ["command-code", COMMAND_CODE_SIDECAR],
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
      { provider: "opencode-go", model: OPENCODE_GO_SIDECAR },
      { provider: "command-code", model: COMMAND_CODE_NATIVE },
      { provider: "command-code", model: COMMAND_CODE_SIDECAR },
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
      hintedMember("opencode-go", OPENCODE_GO_SIDECAR),
      hintedMember("command-code", COMMAND_CODE_NATIVE),
      hintedMember("command-code", COMMAND_CODE_SIDECAR),
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
      hintedMember("opencode-go", OPENCODE_GO_SIDECAR),
      hintedMember("command-code", COMMAND_CODE_NATIVE),
      { ...hintedMember("command-code", COMMAND_CODE_SIDECAR), inputModalities: ["text"] },
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
