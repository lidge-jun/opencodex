/**
 * Combos page: content above the workspace grid must not push the grid's bottom out of reach.
 *
 * Suggested combos (and their notices) render inside `.combos-workspace-shell-body`, above
 * `.combos-workspace-root`. The grid keeps the body's full height, so with anything above it
 * the grid ends below the viewport. The body used to clip (`overflow: hidden`), leaving the
 * lower detail fields and the Save / Remove bar unreachable (#9101). A sibling rule meant to
 * shrink the grid never matched, because the suggestions are wrapped in a fieldset, and would
 * have squeezed the grid to nothing once "Show all" expanded the list.
 *
 * Source-text assertions; the rendered geometry was measured in Chromium while fixing this.
 */
import { expect, test } from "bun:test";
import { effectiveDeclaration, withoutComments } from "./helpers/css-declarations";

const css = withoutComments(
  await Bun.file(new URL("../src/styles-combos-workspace.css", import.meta.url)).text(),
);

test("the shell body scrolls, so content above the workspace can scroll out of the way", () => {
  expect(effectiveDeclaration(css, ".combos-workspace-shell-body", "overflow-y")).toBe("auto");
  expect(() => effectiveDeclaration(css, ".combos-workspace-shell-body", "overflow")).toThrow("property not found");
});

test("the workspace grid keeps its full height instead of shrinking under the suggestions", () => {
  expect(effectiveDeclaration(css, ".combos-workspace-shell-body > .combos-workspace-root", "flex")).toBe("0 0 auto");
  expect(css).not.toMatch(/\.rb-suggest\s*\+\s*\.combos-workspace-root/);
});
