import { describe, expect, test } from "bun:test";
import { filterCatalogVisibleModels, type CatalogModel } from "../src/codex/catalog";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

function m(provider: string, id: string): CatalogModel {
  return { provider, id, owned_by: provider };
}

function cfg(providers: Record<string, Partial<OcxProviderConfig>>, disabledModels?: string[]): Pick<OcxConfig, "disabledModels" | "providers"> {
  const full: Record<string, OcxProviderConfig> = {};
  for (const [name, p] of Object.entries(providers)) full[name] = { adapter: "openai-chat", baseUrl: "https://x", ...p };
  return { providers: full, ...(disabledModels ? { disabledModels } : {}) };
}

describe("filterCatalogVisibleModels — per-provider allowlist", () => {
  const models = [m("proxy", "a"), m("proxy", "b"), m("proxy", "c"), m("openai", "gpt-5.5")];

  test("no selectedModels → all models pass", () => {
    const out = filterCatalogVisibleModels(models, cfg({ proxy: {}, openai: {} }));
    expect(out.map(x => x.id).sort()).toEqual(["a", "b", "c", "gpt-5.5"]);
  });

  test("empty selectedModels array → treated as all", () => {
    const out = filterCatalogVisibleModels(models, cfg({ proxy: { selectedModels: [] }, openai: {} }));
    expect(out.map(x => x.id).sort()).toEqual(["a", "b", "c", "gpt-5.5"]);
  });

  test("non-empty allowlist keeps only listed ids for that provider, others untouched", () => {
    const out = filterCatalogVisibleModels(models, cfg({ proxy: { selectedModels: ["a", "c"] }, openai: {} }));
    expect(out.map(x => `${x.provider}/${x.id}`).sort()).toEqual(["openai/gpt-5.5", "proxy/a", "proxy/c"]);
  });

  test("allowlist is per-provider — an id present under another provider is not leaked", () => {
    const withDup = [...models, m("openai", "a")];
    const out = filterCatalogVisibleModels(withDup, cfg({ proxy: { selectedModels: ["a"] }, openai: {} }));
    expect(out.map(x => `${x.provider}/${x.id}`).sort()).toEqual(["openai/a", "openai/gpt-5.5", "proxy/a"]);
  });

  test("disabledModels blocklist still applies alongside the allowlist", () => {
    const out = filterCatalogVisibleModels(models, cfg({ proxy: { selectedModels: ["a", "b"] }, openai: {} }, ["proxy/b"]));
    expect(out.map(x => `${x.provider}/${x.id}`).sort()).toEqual(["openai/gpt-5.5", "proxy/a"]);
  });

  test("large list collapses to the few selected (the issue #52 shape)", () => {
    const big = Array.from({ length: 2000 }, (_, i) => m("proxy", `model-${i}`));
    const out = filterCatalogVisibleModels(big, cfg({ proxy: { selectedModels: ["model-7", "model-1999"] } }));
    expect(out.map(x => x.id).sort()).toEqual(["model-1999", "model-7"]);
  });
});
