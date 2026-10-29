import { expect, test } from "bun:test";
import { providerConfigSchema } from "../../src/config/schema/leaf-validators";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { routedProviderConfig } from "../../src/providers/routed-config";
import { parseProviderEditorConfigDTO, providerEditorConfigDTO } from "../../src/server/auth-cors";
import { applyProviderCompatPatchFields, carryProviderCompatFields, providerCompatFieldConfigError, sampleProviderOverwrite } from "../../src/server/management/provider-overwrite-carry";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const local: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "http://localhost:1234/v1", authMode: "local" };

test("LM Studio backfills old canonical configs at load and route time, while false wins", () => {
  const loaded = { ...local };
  enrichProviderFromRegistry("lm-studio", loaded);
  expect(loaded.singleLeadingSystemMessage).toBe(true);
  expect(routedProviderConfig("lm-studio", local).singleLeadingSystemMessage).toBe(true);
  expect(routedProviderConfig("lm-studio", { ...local, singleLeadingSystemMessage: false }).singleLeadingSystemMessage).toBe(false);
  expect(providerConfigSeed(getProviderRegistryEntry("ollama")!).singleLeadingSystemMessage).toBeUndefined();
});

test.each([true, false])("schema, editor DTO and PATCH retain boolean %s", value => {
  const provider = { ...local, singleLeadingSystemMessage: value };
  expect(providerConfigSchema.parse(provider).singleLeadingSystemMessage).toBe(value);
  const editor = providerEditorConfigDTO({ defaultProvider: "local", providers: { local: provider } } as unknown as OcxConfig);
  expect(editor.providers.local.singleLeadingSystemMessage).toBe(value);
  expect(parseProviderEditorConfigDTO(editor).ok).toBe(true);
  const next = { ...local };
  expect(applyProviderCompatPatchFields({ singleLeadingSystemMessage: value }, next)).toEqual({ touched: true });
  expect(next.singleLeadingSystemMessage).toBe(value);
});

test("invalid schema and management values are rejected; null clears PATCH", () => {
  for (const value of ["true", 1, {}, []]) {
    expect(providerConfigSchema.safeParse({ ...local, singleLeadingSystemMessage: value }).success).toBe(false);
    expect(providerCompatFieldConfigError({ singleLeadingSystemMessage: value })).toBe("singleLeadingSystemMessage must be a boolean");
    expect(applyProviderCompatPatchFields({ singleLeadingSystemMessage: value }, { ...local })).toEqual({ error: "singleLeadingSystemMessage must be a boolean" });
  }
  const next = { ...local, singleLeadingSystemMessage: false };
  expect(applyProviderCompatPatchFields({ singleLeadingSystemMessage: null }, next)).toEqual({ touched: true });
  expect(next.singleLeadingSystemMessage).toBeUndefined();
});

test("a same-destination save keeps an explicit false over a newly seeded true", () => {
  const stored = { ...local, singleLeadingSystemMessage: false };
  const candidate = { ...local };
  const sample = sampleProviderOverwrite(candidate);
  enrichProviderFromRegistry("lm-studio", candidate);
  carryProviderCompatFields(candidate, stored, sample);
  expect(candidate.singleLeadingSystemMessage).toBe(false);
  const moved = { ...local, baseUrl: "http://other.lan:4321/v1" };
  carryProviderCompatFields(moved, stored, sampleProviderOverwrite(moved));
  expect(moved.singleLeadingSystemMessage).toBeUndefined();
});
