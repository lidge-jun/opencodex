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
  // The Codex picker displays a slash-bearing native id in its ENCODED form, and
  // `ocx models remove` accepts that form too, so an allowlist is routinely written
  // with slugs the provider never published. A bare `Set(selectedModels)` matched
  // only the native spelling and hid every model it was meant to keep.
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

  // The encoding is lossy: `a/b` and `a-b` share one encoded form, so a provider that
  // publishes both spellings has them selected TOGETHER. These tests pin that as known
  // behavior rather than leaving it undiscovered.
  //
  // It is not fixed here, and the obvious alternative does not work. Resolving each
  // selection against the provider's current rows was tried: the roster is an
  // incomplete dictionary — live discovery can omit a published id — so an exact
  // `a-b` selection still resolves onto `a/b` whenever `a-b` is missing from that
  // snapshot, producing the same over-grant. It would additionally disagree with the
  // `slugEquivalenceKey` relation `sync.ts` applies when merging the persisted
  // catalog, and two catalog stages using different equivalence rules is the bug
  // class this change removes. A real fix needs ONE selection resolver shared by
  // filtering, persisted sync, and routing, against a complete known-id set.
  describe("a provider publishing both spellings (known lossy case)", () => {
    const both = [m("p", "a/b"), m("p", "a-b")];

    test("selecting either spelling selects both", () => {
      const viaSlash = filterCatalogVisibleModels(both, cfg({ p: { selectedModels: ["a/b"] } }));
      expect(viaSlash.map(v => v.id).sort()).toEqual(["a-b", "a/b"]);
      const viaDash = filterCatalogVisibleModels(both, cfg({ p: { selectedModels: ["a-b"] } }));
      expect(viaDash.map(v => v.id).sort()).toEqual(["a-b", "a/b"]);
    });

    test("an unrelated model is still hidden, so the allowlist has not collapsed", () => {
      const rows = [...both, m("p", "unrelated")];
      const visible = filterCatalogVisibleModels(rows, cfg({ p: { selectedModels: ["a-b"] } }));
      expect(visible.map(v => v.id)).not.toContain("unrelated");
    });
  });

  test("a nested-slash id is kept by its fully encoded slug", () => {
    const nested = [m("p", "x/y/z"), m("p", "other")];
    const visible = filterCatalogVisibleModels(nested, cfg({ p: { selectedModels: ["x-y-z"] } }));
    expect(visible.map(v => v.id)).toEqual(["x/y/z"]);
  });
});
