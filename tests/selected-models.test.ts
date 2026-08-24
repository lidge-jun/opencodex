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

describe("filterCatalogVisibleModels — slash-bearing ids", () => {
  // `sync.ts` keys this same list through `slugEquivalenceKey(routedSlug(...))`, so
  // the native id and the encoded slug the Codex picker displays are one entry there.
  // A bare `Set(selectedModels)` here matched only the native form, so an allowlist
  // written from the displayed slug — which `ocx models remove` also accepts — hid
  // every model it was meant to keep.
  const native = "moonshotai/kimi-k3-free";
  const encoded = "moonshotai-kimi-k3-free";
  const rows = [m("zenmux", native), m("zenmux", "openai/gpt-5.5")];

  test("an allowlist written with the encoded slug keeps the model", () => {
    const visible = filterCatalogVisibleModels(rows, cfg({
      zenmux: { selectedModels: [encoded] },
    }));
    expect(visible.map(v => v.id)).toEqual([native]);
  });

  test("the native form keeps working", () => {
    const visible = filterCatalogVisibleModels(rows, cfg({
      zenmux: { selectedModels: [native] },
    }));
    expect(visible.map(v => v.id)).toEqual([native]);
  });

  test("a mixed allowlist keeps both, without duplicating either", () => {
    const visible = filterCatalogVisibleModels(rows, cfg({
      zenmux: { selectedModels: [encoded, "openai/gpt-5.5"] },
    }));
    expect(visible.map(v => v.id).sort()).toEqual([native, "openai/gpt-5.5"].sort());
  });

  test("a model outside the allowlist is still hidden", () => {
    const visible = filterCatalogVisibleModels(rows, cfg({
      zenmux: { selectedModels: [encoded] },
    }));
    expect(visible.map(v => v.id)).not.toContain("openai/gpt-5.5");
  });
});
