import { expect, test } from "bun:test";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import { parseProviderEditorConfigDTO, providerEditorConfigDTO, providerManagementConfigError } from "../../src/server/auth-cors";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { providerConfigSeed } from "../../src/providers/derive";
import type { OcxProviderConfig } from "../../src/types";

const provider: OcxProviderConfig = { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" };
const candidate = (value: unknown) => ({ ...getDefaultConfig(), providers: { openai: value } });

test("ordinary Lite hosted-search projection is absent from defaults and the canonical provider seed", () => {
  expect(getDefaultConfig().providers.openai?.projectResponsesLiteHostedSearchHistory).not.toBe(true);
  expect(providerConfigSeed(getProviderRegistryEntry("openai")!).projectResponsesLiteHostedSearchHistory).toBeUndefined();
  expect(validateConfigCandidate(candidate(provider)).ok).toBe(true);
});

test.each([true, false])("provider configuration accepts literal hosted projection opt-in %s", enabled => {
  const result = validateConfigCandidate(candidate({ ...provider, projectResponsesLiteHostedSearchHistory: enabled }));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.config.providers.openai?.projectResponsesLiteHostedSearchHistory).toBe(enabled);
});

test.each(["true", "false", 1, 0, null, {}, []].map(value => ({ value })))("provider writes reject invalid hosted projection opt-in $value", ({ value }) => {
  const result = validateConfigCandidate(candidate({ ...provider, projectResponsesLiteHostedSearchHistory: value }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(JSON.stringify(result)).toContain("projectResponsesLiteHostedSearchHistory");
});

test.each([true, false])("canonical config load and management editor preserve hosted projection opt-in %s", enabled => {
  const seed = { ...providerConfigSeed(getProviderRegistryEntry("openai")!), codexAccountMode: "direct" as const, projectResponsesLiteHostedSearchHistory: enabled };
  const config = { ...getDefaultConfig(), providers: { openai: seed } };
  const loaded = configDiagnosticsFromRaw(JSON.stringify(config));
  expect(loaded.source).toBe("file");
  expect(loaded.config.providers.openai?.projectResponsesLiteHostedSearchHistory).toBe(enabled);
  expect(providerManagementConfigError("openai", seed)).toBeNull();
  const dto = providerEditorConfigDTO(config);
  expect(dto.providers.openai?.projectResponsesLiteHostedSearchHistory).toBe(enabled);
  const parsed = parseProviderEditorConfigDTO(dto);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.providers.openai?.projectResponsesLiteHostedSearchHistory).toBe(enabled);
});

test("management writes reject malformed hosted projection settings and preserve canonical transport protection", () => {
  const seed = { ...providerConfigSeed(getProviderRegistryEntry("openai")!), codexAccountMode: "direct" as const };
  for (const value of ["true", "false", 1, 0, null, {}, []]) {
    expect(providerManagementConfigError("openai", { ...seed, projectResponsesLiteHostedSearchHistory: value })).toContain("projectResponsesLiteHostedSearchHistory");
  }
  expect(providerManagementConfigError("openai", { ...seed, projectResponsesLiteHostedSearchHistory: true, baseUrl: "https://other.example.test/v1" })).toContain("canonical built-in provider seed");
});
