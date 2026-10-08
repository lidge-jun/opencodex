import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../../src/codex/catalog";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";
import { azureVendorContextWindow } from "../../src/providers/derive";
import { getModelMetadata } from "../../src/generated/model-metadata";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { CatalogModel } from "../../src/codex/catalog/parsing";
import type { OcxProviderConfig } from "../../src/types";

const AZURE: OcxProviderConfig = {
  adapter: "azure-openai",
  baseUrl: "https://resource.openai.azure.com/openai",
  apiKey: "sk-test",
};
const discovered = (id = "gpt-5.6-terra"): CatalogModel => ({
  provider: "custom-azure", id, owned_by: "custom-azure",
});
const hint = (model = discovered(), provider = AZURE, cap?: number) =>
  applyProviderConfigHints("custom-azure", provider, model, cap);

describe("Azure destination vendor context windows", () => {
  test("known vendor ids resolve independently of the configured provider name", () => {
    expect(azureVendorContextWindow(AZURE.baseUrl, "gpt-6-sol")).toBe(1_050_000);
    expect(azureVendorContextWindow(AZURE.baseUrl, "DeepSeek-V4-Flash")).toBe(1_048_576);
    expect(azureVendorContextWindow(AZURE.baseUrl, "glm-5.3")).toBe(1_000_000);
  });

  test("unrecognized destinations and deployment aliases receive no guessed limit", () => {
    for (const baseUrl of [
      undefined, "not a url", "https://openrouter.test/api/v1",
      "https://api.example.com/resource.openai.azure.com",
      "https://openai.azure.com.example.test/openai",
    ]) {
      expect(azureVendorContextWindow(baseUrl, "gpt-5.6-terra")).toBeUndefined();
    }
    expect(hint(discovered("my-deployment")).contextWindow).toBeUndefined();
  });

  test("an Azure row without upstream limits reaches the serialized Codex catalog", () => {
    const model = hint();
    expect(model.contextWindow).toBe(1_050_000);
    const entry = buildCatalogEntries(null, [], [model])
      .find(row => row.slug === "custom-azure/gpt-5.6-terra");
    expect(entry?.context_window).toBe(1_050_000);
    expect(entry?.max_context_window).toBe(1_050_000);
    expect(entry?.auto_compact_token_limit).toBe(945_000);
  });

  test("reported and configured limits retain precedence", () => {
    expect(hint({ ...discovered(), contextWindow: 262_144 }).contextWindow).toBe(262_144);
    expect(hint(discovered(), { ...AZURE, contextWindow: 96_000 }).contextWindow).toBe(96_000);
    expect(hint(discovered(), {
      ...AZURE, modelContextWindows: { "gpt-5.6-terra": 64_000 },
    }).contextWindow).toBe(64_000);
  });

  test("providerContextCaps still clamps the vendor window", () => {
    expect(hint(discovered(), AZURE, 350_000)).toMatchObject({
      contextWindow: 350_000, contextCap: 350_000, contextCapped: true,
    });
  });

  test("refreshed OpenAI metadata matches the canonical API context seeds", () => {
    const declared = getProviderRegistryEntry("openai-apikey")!.modelContextWindows!;
    for (const id of [
      "gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
      "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol",
    ]) {
      expect(declared[id], id).toBe(1_050_000);
      expect(getModelMetadata("openai", id)?.contextWindow, id).toBe(declared[id]);
    }
  });
});
