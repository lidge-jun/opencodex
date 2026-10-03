import { describe, expect, test } from "bun:test";

import {
  CATALOG_HEAL_MAX_HEALS,
  CATALOG_HEAL_RECHECK_MS,
  CATALOG_HEAL_WINDOW_MS,
  startCodexCatalogSelfHeal,
  type CatalogObservation,
  type CatalogSelfHealGates,
} from "../../src/codex/catalog-self-heal";
import type { RawCatalog } from "../../src/codex/catalog/parsing";
import type { OcxConfig } from "../../src/types";

const routed = (slug: string) => ({ slug, description: `Routed via opencodex → ${slug} (owner).` });
const native = { slug: "gpt-5.5", description: "native" };
const provider = { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" };

function harness(options: { config?: Partial<OcxConfig>; gates?: Partial<CatalogSelfHealGates>; republish?: RawCatalog } = {}) {
  let clock = 0;
  let version = 0;
  let catalog: RawCatalog = { models: [native, routed("ark/a"), routed("tx/b")] };
  const converges: OcxConfig[] = [];
  const warnings: string[] = [];
  const config = {
    port: 10100,
    defaultProvider: "openai",
    providers: { ark: provider, tx: provider },
    ...options.config,
  } as OcxConfig;
  const handle = startCodexCatalogSelfHeal({
    deps: {
      scheduleFn: () => ({ cancel: () => {} }),
      now: () => clock,
      catalogPath: () => "/codex/opencodex-catalog.json",
      observe: (_path, readContent): CatalogObservation => ({
        signature: `v${version}`,
        catalog: readContent ? structuredClone(catalog) : null,
      }),
      converge: async (driving) => {
        converges.push(driving);
        catalog = structuredClone(options.republish ?? { models: [native, routed("ark/a"), routed("tx/b")] });
        version += 1;
        return { committed: true };
      },
      gates: {
        siblingOfLivePort: () => null,
        exiting: () => false,
        loadConfig: () => config,
        ownsCodexHome: () => true,
        clientConnected: () => false,
        ...options.gates,
      },
      log: { warn: (line: string) => warnings.push(line) },
    },
  });
  return {
    handle,
    converges,
    warnings,
    advance(ms: number) { clock += ms; },
    rewrite(next: RawCatalog) { catalog = next; version += 1; },
    catalog: () => catalog,
  };
}

describe("Codex catalog self-heal (#6529)", () => {
  test("the first look is the baseline; an unchanged file is not read again", async () => {
    const h = harness();
    await h.handle.tickForTests();
    await h.handle.tickForTests();
    expect(h.converges).toEqual([]);
  });

  test("republishes once when routed namespaces the config enables disappear", async () => {
    const h = harness();
    await h.handle.tickForTests();
    h.rewrite({ models: [native] });
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
    expect(h.catalog().models?.map(model => model.slug)).toContain("ark/a");
    expect(h.handle.lastHeal()).toMatchObject({ lostNamespaces: 2, committed: true });
    // Counts only: the warning names no provider.
    expect(h.warnings).toEqual([expect.stringContaining("2 provider namespaces")]);
    expect(h.warnings[0]).not.toContain("ark");
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("a namespace the owner's config dropped is a removal, not a loss", async () => {
    const h = harness({ config: { providers: { ark: provider, tx: { ...provider, disabled: true } } as OcxConfig["providers"] } });
    await h.handle.tickForTests();
    h.rewrite({ models: [native, routed("ark/a")] });
    await h.handle.tickForTests();
    expect(h.converges).toEqual([]);
  });

  test("a namespace the owner's own convergence leaves empty is looked at once, not fought", async () => {
    const h = harness({ republish: { models: [native, routed("ark/a")] } });
    await h.handle.tickForTests();
    h.rewrite({ models: [native, routed("ark/a")] });
    await h.handle.tickForTests();
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("a closed gate defers the heal until it opens", async () => {
    let owner = false;
    const h = harness({ gates: { ownsCodexHome: () => owner } });
    await h.handle.tickForTests();
    h.rewrite({ models: [native] });
    await h.handle.tickForTests();
    expect(h.converges).toEqual([]);
    owner = true;
    await h.handle.tickForTests();
    expect(h.converges).toEqual([]);
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("a writer that keeps rewriting the catalog trips the flap cap for the window", async () => {
    const h = harness();
    await h.handle.tickForTests();
    for (let round = 0; round < CATALOG_HEAL_MAX_HEALS + 2; round += 1) {
      h.rewrite({ models: [native] });
      await h.handle.tickForTests();
      h.advance(1_000);
    }
    expect(h.converges).toHaveLength(CATALOG_HEAL_MAX_HEALS);
    h.advance(CATALOG_HEAL_WINDOW_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(CATALOG_HEAL_MAX_HEALS + 1);
  });

  test("stop cancels the loop", async () => {
    const h = harness();
    await h.handle.tickForTests();
    h.handle.stop();
    h.rewrite({ models: [native] });
    await h.handle.tickForTests();
    expect(h.converges).toEqual([]);
  });
});
