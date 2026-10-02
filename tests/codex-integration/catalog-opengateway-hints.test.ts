import { describe, expect, test } from "bun:test";
import { catalogHintsFromModelsApiItem } from "../../src/codex/catalog/provider-fetch";

const OPENGATEWAY_ITEM = {
  id: "openai/o4-mini",
  owned_by: "openai",
  status: "active",
  modalities: { input: ["text", "image"], output: ["text"] },
  endpoints: ["chat_completions", "responses"],
  providers: [{ id: "azure", region: "eastus2" }],
  context_window: 200000,
  max_output_tokens: 100000,
};

describe("OpenGateway catalog capability fallbacks", () => {
  test("reads top-level context_window and object-shaped input modalities", () => {
    const hints = catalogHintsFromModelsApiItem("opengateway", OPENGATEWAY_ITEM);
    expect(hints.contextWindow).toBe(200000);
    expect(hints.inputModalities).toEqual(["text", "image"]);
    expect(hints.maxOutputTokens).toBe(100000);
  });

  test("nested modalities retain the closed enum and never infer from output", () => {
    const hints = catalogHintsFromModelsApiItem("opengateway", {
      ...OPENGATEWAY_ITEM,
      modalities: { input: ["TEXT", "image", "audio", "video", "image"], output: ["video"] },
    });
    expect(hints.inputModalities).toEqual(["text", "image", "audio"]);
    expect(catalogHintsFromModelsApiItem("opengateway", {
      id: "output-only", modalities: { output: ["image"] },
    }).inputModalities).toBeUndefined();
  });

  test.each([0, -1, 1.5, "200000", Number.MAX_SAFE_INTEGER + 1])(
    "ignores invalid context_window %s", context_window => {
      expect(catalogHintsFromModelsApiItem("opengateway", {
        ...OPENGATEWAY_ITEM, context_window,
      }).contextWindow).toBeUndefined();
    },
  );

  test("existing hub fixture resolves unchanged when the new fields conflict", () => {
    const hub = {
      id: "anthropic/claude-opus-5",
      owned_by: "opencodex-hub",
      capabilities: { context_length: 922000, max_output_tokens: 64000, vision: false },
    };
    const before = catalogHintsFromModelsApiItem("hub", hub);
    expect(before.contextWindow).toBe(922000);
    expect(before.inputModalities).toEqual(["text"]);
    expect(catalogHintsFromModelsApiItem("hub", {
      ...hub, context_window: 200000, modalities: OPENGATEWAY_ITEM.modalities,
    })).toEqual(before);
  });

  test("existing explicit arrays, architecture and vision signals retain precedence", () => {
    for (const fields of [
      { input_modalities: ["audio"] },
      { architecture: { modality: "text+audio->text" } },
      { capabilities: ["multimodal"] },
    ]) {
      const original = { id: "existing", ...fields };
      expect(catalogHintsFromModelsApiItem("existing", {
        ...original, modalities: { input: ["text"], output: ["image"] },
      })).toEqual(catalogHintsFromModelsApiItem("existing", original));
    }
    expect(catalogHintsFromModelsApiItem("existing", {
      id: "array", modalities: ["audio"],
    }).inputModalities).toEqual(["audio"]);
  });
});
