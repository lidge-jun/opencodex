import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../src/codex/catalog";
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
