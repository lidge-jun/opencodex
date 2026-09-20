/**
 * An explicit custom row outranks the provider-level vision hints.
 *
 * The reported defect: a model the operator had added as a manual custom row with
 * `inputModalities: ["text", "image"]` still had every attachment replaced by the omission
 * marker. The catalog half was already correct — `src/codex/catalog/routed-gather.ts` copies
 * `customModels[].inputModalities` onto the advertised row, which is why the dashboard showed
 * "text, image" — while the request path consulted only `providers[].noVisionModels` and
 * `modelInputModalities` and concluded text-only. One config, two answers.
 *
 * These tests pin the precedence at the request-path seam (`requiresVisionPreprocessing`) and at
 * the shared capability predicate (`modelAcceptsImageInput` / `isVisionSidecarConsumer`), which
 * is what the sidecar picker and the web-search verbalizer read.
 */
import { describe, expect, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import {
  isVisionSidecarConsumer,
  modelAcceptsImageInput,
} from "../../src/vision/eligibility";
import { planVisionSidecar, requiresVisionPreprocessing } from "../../src/vision/plan";
import { parseRequest } from "../../src/responses/parser";

const PROVIDER = "zen-go";
const MODEL = "deepseek-v4.1-flash";

/** The reported shape: the provider lists the model as text-only, the custom row says otherwise. */
const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://opencode.ai/zen/go/v1",
  noVisionModels: [MODEL],
  modelInputModalities: { [MODEL]: ["text"] },
};

function configWith(
  customModels?: OcxConfig["customModels"],
  providerOverrides: Partial<OcxProviderConfig> = {},
): OcxConfig {
  return {
    port: 10100,
    defaultProvider: PROVIDER,
    providers: { [PROVIDER]: { ...provider, ...providerOverrides } },
    ...(customModels ? { customModels } : {}),
  } as OcxConfig;
}

const imageRow: NonNullable<OcxConfig["customModels"]>[number] = {
  id: "custom-image-row",
  provider: PROVIDER,
  modelId: MODEL,
  inputModalities: ["text", "image"],
};

describe("custom row outranks provider vision hints", () => {
  test("the provider hints alone are what strip the image (the reported defect)", () => {
    const config = configWith();
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(false);
  });

  test("an explicit image declaration on the custom row turns preprocessing off", () => {
    const config = configWith([imageRow]);
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(false);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(true);
  });

  test("the shared consumer predicate agrees, so the picker and verbalizer follow", () => {
    expect(isVisionSidecarConsumer(configWith([imageRow]), PROVIDER, MODEL)).toBe(false);
    expect(isVisionSidecarConsumer(configWith(), PROVIDER, MODEL)).toBe(true);
  });

  test("an explicit text-only custom row outranks provider hints that advertise image", () => {
    // The mirror direction: the row must be able to declare text-only for a model the provider
    // row happens to describe as image-capable, or the override would only work one way.
    const config = configWith(
      [{ ...imageRow, inputModalities: ["text"] }],
      { noVisionModels: [], modelInputModalities: { [MODEL]: ["text", "image"] } },
    );
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(false);
  });

  test("a custom row without a modality declaration stays silent instead of claiming text-only", () => {
    const config = configWith(
      [{ id: "custom-row", provider: PROVIDER, modelId: MODEL, contextWindow: 1_048_576 }],
      { noVisionModels: [], modelInputModalities: { [MODEL]: ["text", "image"] } },
    );
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(false);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(true);
  });

  test("an audio-only custom row is image-incapable in both predicates", () => {
    // The declaration answers "can this model take an image", not "is it a text model". A row
    // that lists only audio excludes image input exactly as `["text"]` does, so the wider
    // `includes("text")` test this branch used to apply made the two predicates disagree and
    // sent the attachment to a model that cannot read it.
    const config = configWith([{ ...imageRow, inputModalities: ["audio"] }]);
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(false);
  });

  test("a custom row lets a provider-declared text-only model serve as the routed describer", () => {
    // `usableRoutedVisionModel` used to AND a provider-only `isModelTextOnly` on top of
    // `modelAcceptsImageInput`. That second check never saw a custom row, so a describer the
    // operator had declared image-capable was refused for the very provider hint the row overrides.
    const request = parseRequest({
      model: "main/blind",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8taW1hZ2U=" }] }],
    });
    const build = (customModels?: OcxConfig["customModels"]): OcxConfig => ({
      port: 10100,
      defaultProvider: "main",
      providers: {
        main: { adapter: "openai-chat", baseUrl: "https://main.test/v1", noVisionModels: ["blind"] },
        [PROVIDER]: { ...provider },
      },
      visionSidecar: { enabled: true, backend: "routed", model: `${PROVIDER}/${MODEL}` },
      ...(customModels ? { customModels } : {}),
    } as OcxConfig);

    const withRow = build([imageRow]);
    const plan = planVisionSidecar(withRow, withRow.providers["main"]!, "blind", request, undefined, { providerName: "main" });
    expect(plan?.backend).toBe("routed");
    expect(plan?.routedModel).toBe(`${PROVIDER}/${MODEL}`);

    // Without the row the provider hint stands, the describer is refused, and nothing else can
    // describe the image on this config — so the whole plan is absent.
    const withoutRow = build();
    expect(planVisionSidecar(withoutRow, withoutRow.providers["main"]!, "blind", request, undefined, { providerName: "main" })).toBeUndefined();
  });

  test("modelCapabilities remains the top slot when it contradicts the custom row", () => {
    // `modelCapabilities` is the dedicated capability axis and what `ocx provider edit --text-only`
    // writes. Two explicit declarations that disagree resolve to the more specific axis.
    const config = configWith([imageRow]);
    config.providers[PROVIDER]!.modelCapabilities = { [MODEL]: { inputModalities: ["text"] } };
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(false);
  });

  test("the shared consumer predicate reads modelCapabilities ahead of the custom row", () => {
    // The precedence is one contract, not one per predicate: a reader that consults the custom
    // row first would answer the opposite of `modelAcceptsImageInput` for the same config.
    const config = configWith([imageRow]);
    config.providers[PROVIDER]!.modelCapabilities = { [MODEL]: { inputModalities: ["text"] } };
    expect(isVisionSidecarConsumer(config, PROVIDER, MODEL)).toBe(true);
  });

  test("an explicit custom row outranks a noVisionModels listing on a native candidate", () => {
    // The native arm used to check the sidecar hints before the custom row, so a listing the
    // catalog had already overridden still forced text-only on the request path.
    const config = configWith([imageRow]);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL, native: true })).toBe(true);
  });

  test("a custom row for a different provider or model id does not leak", () => {
    const otherProvider = configWith([{ ...imageRow, provider: "other-provider" }]);
    expect(requiresVisionPreprocessing(otherProvider, otherProvider.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
    const otherModel = configWith([{ ...imageRow, modelId: "another-model" }]);
    expect(requiresVisionPreprocessing(otherModel, otherModel.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
  });

  test("without a providerName the custom row is not consulted, preserving legacy callers", () => {
    // The provider-only fallback exists for unit callers that never resolved a route. It must not
    // start guessing which provider a bare model id belongs to.
    const config = configWith([imageRow]);
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL)).toBe(true);
  });
});
