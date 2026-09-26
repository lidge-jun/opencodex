import { describe, expect, test } from "bun:test";
import { outputBudgetFor } from "../../src/clients/config-export/model-metadata";
import { toExportModel } from "../../src/server/management/model-rows";
import { opencodeCatalogFromProxyRows } from "../../src/cli/opencode";
import type { OcxConfig } from "../../src/types";

// A catalog row's own maxOutputTokens is the authoritative output limit for client exports.
// Generated metadata and the 32000 stand-in are only fallbacks when the catalog says nothing.
describe("client export output limit comes from the catalog row first", () => {
  test("toExportModel carries maxOutputTokens as maxTokens", () => {
    const model = toExportModel({
      namespaced: "acme/writer", provider: "acme", id: "writer", contextWindow: 400_000, maxOutputTokens: 64_000,
    });
    expect(model.maxTokens).toBe(64_000);
    expect(outputBudgetFor(400_000, model)).toBe(64_000);
    expect(toExportModel({ namespaced: "acme/plain", provider: "acme", id: "plain" })).not.toHaveProperty("maxTokens");
  });

  test("the opencode launcher catalog carries maxOutputTokens from /api/models", () => {
    const config = { providers: { acme: { adapter: "openai-chat", baseUrl: "https://acme.example/v1" } } } as unknown as OcxConfig;
    const [model] = opencodeCatalogFromProxyRows([
      { namespaced: "acme/writer", provider: "acme", id: "writer", contextWindow: 400_000, maxOutputTokens: 64_000 },
    ], config);
    expect(model?.maxTokens).toBe(64_000);
  });

  test("a catalog limit above the context window is still clamped", () => {
    expect(outputBudgetFor(8_000, { provider: "acme", id: "tiny", maxTokens: 64_000 })).toBe(8_000);
  });
});
