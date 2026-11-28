import { afterEach, expect, test } from "bun:test";
import { nativeOpenAiMaxOutputTokens } from "../../src/codex/catalog/metadata";
import { nativeOpenAiCapabilitySourceSlug, setConfiguredNativeOpenAiModels } from "../../src/codex/catalog/native-models";
import { getModelMetadata } from "../../src/generated/model-metadata";
import { resolveOutputCeiling } from "../../src/server/responses/input-admission";
import type { OcxProviderConfig } from "../../src/types";

const CANONICAL_NATIVE: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};
const CONFIGURED = "gpt-7-nova";

afterEach(() => setConfiguredNativeOpenAiModels([]));

test.each(["gpt-6.2-sol", "gpt-6.2-astra"])("%s carries the 128K output ceiling into native admission", slug => {
  expect(getModelMetadata("openai", slug)?.maxTokens).toBe(128_000);
  expect(getModelMetadata("openrouter", `openai/${slug}`)?.maxTokens).toBe(128_000);
  expect(nativeOpenAiMaxOutputTokens(slug)).toBe(128_000);
  expect(resolveOutputCeiling(CANONICAL_NATIVE, "openai", slug)).toBe(128_000);
});

test("a configured native model inherits the GPT-6.2 Sol output ceiling", () => {
  setConfiguredNativeOpenAiModels([CONFIGURED]);
  expect(nativeOpenAiCapabilitySourceSlug(CONFIGURED)).toBe("gpt-6.2-sol");
  expect(nativeOpenAiMaxOutputTokens(CONFIGURED)).toBe(128_000);
  expect(resolveOutputCeiling(CANONICAL_NATIVE, "openai", CONFIGURED)).toBe(128_000);
});
