import { expect, test } from "bun:test";
import { effectiveDeclaration, withoutComments } from "./helpers/css-declarations";

/**
 * WP2 (devlog/_fin/260830_models_provider_header/050_hover_affordance_and_column_gate.md).
 *
 * The user's requirement was a hover affordance. The independent audit rejected the
 * first reading of it — hover that GATES, i.e. controls hidden until the pointer
 * arrives — because that deletes the alias pencil, the alias-defaults switch and
 * custom-add from the default visual inventory and worsens the exact opacity that
 * 020 exists to fix. What survives is emphasis: the control never leaves layout,
 * tab order, or the accessibility tree, and only its resting contrast changes.
 *
 * These assertions exist to stop a later "tidy up" from quietly turning emphasis
 * back into gating, and to stop the keyboard and touch paths from being dropped
 * while the hover path survives.
 */

const read = async () => withoutComments(await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text());

/** The body of an at-rule block, which `ruleBodies` cannot reach: it matches an exact selector. */
function atRuleBody(css: string, condition: string): string {
  const at = css.indexOf(condition);
  if (at < 0) throw new Error("at-rule not found: " + condition);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) return css.slice(open + 1, i); }
  }
  throw new Error("unbalanced at-rule: " + condition);
}

test("the alias-edit control is de-emphasized at rest, not hidden", async () => {
  const css = await read();

  // 0.75, not lower: .btn:disabled is opacity 0.55, so a deeper dim reads as
  // maybe-disabled rather than secondary.
  //
  // Read the RESTING rule only. `effectiveDeclaration` takes the last textual match
  // across every body of an exact selector and does not model @-rules, so run against
  // the whole file it would report the `(hover: none)` override's `opacity: 1` and
  // pass whatever the resting value happened to be.
  const restingOnly = css.slice(0, css.indexOf("@media (hover: none)"));
  expect(effectiveDeclaration(restingOnly, ".models-provider-actions .btn-ghost.models-alias-edit", "opacity")).toBe("0.75");

  // Gating, in any of its spellings, would remove the control from the resting
  // layout — the design 011 rejected and 030 re-rejected.
  const rule = css.slice(css.indexOf(".models-alias-edit"));
  const block = rule.slice(0, rule.indexOf("@media") < 0 ? rule.length : rule.indexOf("@media"));
  expect(block).not.toContain("display: none");
  expect(block).not.toContain("visibility: hidden");
  expect(block).not.toContain("content-visibility: hidden");
});

/**
 * The audit's blocker: the first draft wrote every override at 0,2,0 against a 0,3,0
 * resting rule. Same origin, lower specificity — so `(hover: none)` never won and the
 * dim was permanent on touch, and `:focus-visible` was a silent no-op. A rule that
 * exists but cannot win is worse than a missing one, because it reads as covered.
 */
test("every emphasis state is written at the resting rule's specificity", async () => {
  const css = await read();
  const REST = ".models-provider-actions .btn-ghost.models-alias-edit";

  // Each state must carry the full .btn-ghost + descendant chain, not a shorter one.
  expect(css).toContain(`.models-provider-head:hover ${REST}`);
  expect(css).toContain(`.models-provider-head:focus-within ${REST}`);
  expect(css).toContain(`${REST}:focus-visible`);

  // And the at-rule overrides must use the same chain.
  expect(atRuleBody(css, "@media (hover: none)")).toContain(REST);
  expect(atRuleBody(css, "@media (prefers-reduced-motion: reduce)")).toContain(REST);

  // A bare .models-alias-edit override would be 0,1,0 or 0,2,0 and could not win.
  expect(css).not.toMatch(/(^|[\n,])\s*\.models-alias-edit\s*\{/);
});

test("emphasis has a keyboard path, not only a pointer one", async () => {
  const css = await read();

  // :hover alone would mean a keyboard user reaching the pencil by Tab never sees
  // the emphasis a mouse user gets by proximity.
  expect(css).toContain(".models-provider-head:focus-within");
  expect(css).toContain(":focus-visible");

  const emphasized = css.slice(css.indexOf(".models-provider-head:hover .models-provider-actions"));
  expect(emphasized.slice(0, emphasized.indexOf("}"))).toContain("opacity: 1");
});

test("a pointer that cannot hover gets full contrast permanently", async () => {
  const css = await read();
  // Without this the resting dim is permanent on touch: no pointer ever arrives to
  // trigger the emphasis rule.
  const body = atRuleBody(css, "@media (hover: none)");
  expect(body).toContain(".models-alias-edit");
  expect(body).toContain("opacity: 1");
});

test("reduced motion removes the transition rather than the emphasis", async () => {
  const css = await read();
  const body = atRuleBody(css, "@media (prefers-reduced-motion: reduce)");
  expect(body).toContain(".models-alias-edit");
  expect(body).toContain("transition: none");
  // The emphasis itself must survive: reduced motion is about animation, not contrast.
  expect(body).not.toContain("opacity: 1");
});
