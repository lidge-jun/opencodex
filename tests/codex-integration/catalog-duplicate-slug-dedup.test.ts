import { describe, expect, test } from "bun:test";
import { dedupeCatalogEntriesBySlug } from "../../src/codex/catalog/retained-sync";
import type { RawEntry } from "../../src/codex/catalog/parsing";

/**
 * #4730: one sync on 2.56.0 wrote 507 catalog rows for 72 unique slugs — the aliased
 * (`CC-x`) and canonical (`command-code/x`) emit paths of the same provider model both
 * survived the equivalence-key merge as byte-identical rows. The written catalog must
 * carry every slug exactly once, and the guard must be inert for catalogs that are
 * already unique.
 */

const row = (slug: string, display?: string): RawEntry => ({
  slug,
  ...(display ? { display_name: display } : {}),
} as RawEntry);

describe("dedupeCatalogEntriesBySlug", () => {
  test("keeps the first occurrence and drops later byte-identical rows", () => {
    const models = [row("CC-MiniMaxAI-MiniMax-M3", "first"), row("CC-MiniMaxAI-MiniMax-M3", "first"), row("CC-MiniMaxAI-MiniMax-M3", "first")];
    const out = dedupeCatalogEntriesBySlug(models);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(models[0]);
  });

  test("never drops distinct slugs, including alias/canonical pairs", () => {
    const models = [
      row("CC-MiniMaxAI-MiniMax-M3"),
      row("command-code/MiniMaxAI-MiniMax-M3"),
      row("gpt-5.6-luna"),
    ];
    expect(dedupeCatalogEntriesBySlug(models)).toHaveLength(3);
  });

  test("preserves row order", () => {
    const models = [row("b"), row("a"), row("b"), row("c"), row("a")];
    expect(dedupeCatalogEntriesBySlug(models).map(entry => entry.slug)).toEqual(["b", "a", "c"]);
  });

  test("passes through rows without a string slug untouched", () => {
    const odd = { display_name: "no slug" } as unknown as RawEntry;
    const models = [odd, row("x"), odd];
    const out = dedupeCatalogEntriesBySlug(models);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(odd);
    expect(out[1]).toBe(models[1]);
    expect(out[2]).toBe(odd);
  });

  test("is inert for an already-unique catalog", () => {
    const models = [row("a"), row("b"), row("c")];
    const out = dedupeCatalogEntriesBySlug(models);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(models[0]);
  });
});
