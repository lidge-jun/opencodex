import { describe, expect, test } from "bun:test";
import { AUTO_CONTEXT_OFF } from "../src/claude/context-windows";
import { desktop3pAlias } from "../src/claude/desktop-3p";
import { buildAnthropicModelInfos } from "../src/claude/model-info";
import type { CatalogModel } from "../src/codex/catalog";

/**
 * Fast rows on Claude Code discovery (devlog 260904_external_fast_wire/020).
 *
 * The predicate's PRESENCE is the feature gate: the server passes undefined when `fastRows`
 * is off, so a default install publishes nothing. These tests pin that, plus the two
 * properties review found missing from an earlier draft — both loops publish, and a real
 * model always wins its own id.
 */

function routed(id: string, provider = "fixture"): CatalogModel {
  return { provider, id, contextWindow: 200_000, reasoningEfforts: ["low", "high"] } as CatalogModel;
}

const build = (
  natives: string[],
  models: CatalogModel[],
  fastRows?: (m: { provider: string; id: string }) => boolean,
  idStyle: "readable" | "desktop3p" = "readable",
) => buildAnthropicModelInfos(
  natives, models, AUTO_CONTEXT_OFF, idStyle, desktop3pAlias, undefined, undefined, fastRows,
).map(info => info.id);

describe("fast rows on Claude discovery", () => {
  test("no predicate means no fast rows, whatever the models support", () => {
    const ids = build(["gpt-5.6-sol"], [routed("m")]);
    expect(ids.some(id => id.endsWith("--fast"))).toBe(false);
  });

  test("a routed row gains a fast sibling and KEEPS its base row", () => {
    // Additive, unlike the fastMode rewrite: a selector has to leave the default pickable.
    const ids = build([], [routed("m")], () => true);
    const base = ids.find(id => id.includes("m") && !id.endsWith("--fast"));
    expect(base).toBeDefined();
    expect(ids).toContain(`${base}--fast`);
  });

  test("a NATIVE slug gains one too", () => {
    // The regression an earlier draft shipped: it patched only the routed loop, which would
    // have left gpt-5.6-sol - the flagship Fast model - off this surface entirely.
    const ids = build(["gpt-5.6-sol"], [], m => m.provider === "native");
    const base = ids.find(id => !id.endsWith("--fast"));
    expect(base).toBeDefined();
    expect(ids).toContain(`${base}--fast`);
  });

  test("an ineligible row gains nothing", () => {
    const ids = build([], [routed("yes"), routed("no")], m => m.id === "yes");
    expect(ids.filter(id => id.endsWith("--fast"))).toHaveLength(1);
    expect(ids.some(id => id.includes("no") && id.endsWith("--fast"))).toBe(false);
  });

  test("the Desktop 3P hashed style publishes too", () => {
    // fastMode excludes this style because it REWRITES a hash and strands a saved
    // selection. An added row strands nothing, so the exclusion does not apply.
    const ids = build([], [routed("m")], () => true, "desktop3p");
    expect(ids.some(id => id.endsWith("--fast"))).toBe(true);
  });

  test("a real model always wins its own id, in either roster order", () => {
    // With both `foo` and a real `foo--fast` present, the synthetic id for `foo` IS the real
    // model's id. The dedupe set alone would let whichever ran first own the row, so the
    // outcome must not depend on ordering.
    const forward = build([], [routed("foo"), routed("foo--fast")], () => true);
    const reverse = build([], [routed("foo--fast"), routed("foo")], () => true);
    const count = (ids: string[]) => ids.filter(id => id.endsWith("--fast")).length;
    expect(count(forward)).toBe(count(reverse));
    // And the real model's own row is present either way.
    expect(forward.some(id => id.endsWith("foo--fast"))).toBe(true);
    expect(reverse.some(id => id.endsWith("foo--fast"))).toBe(true);
  });

  test("a combo row is classified by its aggregated capability, not a provider lookup", () => {
    // A combo has no config.providers entry - declaring a provider named `combo` is
    // rejected outright - so a (provider, id) lookup can never classify it. The predicate
    // receives the whole row for exactly this reason.
    const combo = { provider: "combo", id: "c1", contextWindow: 200_000, supportsServiceTier: true } as CatalogModel;
    const ids = build([], [combo], m => (m as { supportsServiceTier?: boolean }).supportsServiceTier === true);
    expect(ids.some(id => id.endsWith("--fast"))).toBe(true);
  });
});

