import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { enforceCatalogSlugUniqueness } from "../../src/codex/catalog/aggregation";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import { repoPath } from "../helpers/repo-root";

/**
 * #4730 is a property of the FILE, not of one code path: a slug-unique validating consumer
 * refuses the whole catalog, so a single doubled row costs the operator every model. Two
 * functions in this tree serialize a merged catalog and hand it to `replaceActiveCodexCatalog`
 * — `writeRetainedCatalogSync` (`ocx sync`) and `buildConvergedCatalog` (every dashboard model
 * toggle, combo edit, and Codex account login, via `convergeCodexCatalog`). A guard on only the
 * first leaves the same rejection reachable through the management API.
 */

const row = (slug: string, extra: Record<string, unknown> = {}): RawEntry =>
  ({ slug, ...extra }) as unknown as RawEntry;

describe("catalog slug uniqueness at the write boundary (#4730)", () => {
  test("an already-unique list is returned unchanged, so an unchanged catalog stays a no-op write", () => {
    const models = [row("a"), row("b"), row("c")];
    expect(enforceCatalogSlugUniqueness(models, true)).toBe(models);
  });

  test("first occurrence wins, order is preserved, and distinct slugs are never collapsed", () => {
    const models = [
      row("CC-MiniMaxAI-MiniMax-M3", { display_name: "first" }),
      row("command-code/MiniMaxAI-MiniMax-M3"),
      row("CC-MiniMaxAI-MiniMax-M3", { display_name: "second" }),
    ];
    const out = enforceCatalogSlugUniqueness(models, false);
    expect(out.map(entry => entry.slug)).toEqual([
      "CC-MiniMaxAI-MiniMax-M3",
      "command-code/MiniMaxAI-MiniMax-M3",
    ]);
    expect(out[0]).toBe(models[0]);
  });

  test("rows without a string slug are carried through rather than deduped against each other", () => {
    const odd = { display_name: "no slug" } as unknown as RawEntry;
    const out = enforceCatalogSlugUniqueness([odd, row("x"), odd, row("x")], false);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(odd);
    expect(out[2]).toBe(odd);
  });

  test("the silent mode really is silent, and the loud mode names the divergent slug", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      enforceCatalogSlugUniqueness([row("dup", { display_name: "a" }), row("dup", { display_name: "a" })], false);
      expect(warnings).toEqual([]);
      enforceCatalogSlugUniqueness([row("dup", { display_name: "a" }), row("dup", { display_name: "b" })], true);
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("#4730");
    expect(warnings[0]).toContain("divergent content on: dup");
  });

  test("both catalog writers apply the guard as their last mutation before serialization", () => {
    // Source oracle rather than a second real-sync spawn: the management convergence commit needs
    // an admission snapshot, a gather session, and a write permit to reach its serialization, and
    // a test that stubbed all three would assert the stub rather than the boundary.
    const retained = readFileSync(repoPath("src", "codex", "catalog", "retained-sync.ts"), "utf8");
    const convergence = readFileSync(repoPath("src", "codex", "convergence.ts"), "utf8");
    // Both writers must call the guard; a miss here is the #4730 rejection returning by the
    // other route rather than a style violation.
    expect(retained).toContain("enforceCatalogSlugUniqueness(");
    expect(convergence).toContain("enforceCatalogSlugUniqueness(");
    // Ordering is load-bearing: the effort clamp splices whole rows out, so deduping first can
    // drop the row the clamp would have kept and then lose the slug entirely.
    const guardAt = retained.indexOf("enforceCatalogSlugUniqueness(");
    const clampAt = retained.indexOf("clampCatalogModelsToCodexSupport(catalog.models)");
    const serializeAt = retained.indexOf("JSON.stringify(catalog, null, 2)");
    expect(clampAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(clampAt);
    expect(serializeAt).toBeGreaterThan(guardAt);
  });
});
