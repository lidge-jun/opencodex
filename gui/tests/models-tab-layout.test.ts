import { expect, test } from "bun:test";
import { effectiveDeclaration, withoutComments } from "./helpers/css-declarations";

async function readStylesheet(path: string): Promise<string> {
  return withoutComments(await Bun.file(new URL(path, import.meta.url)).text());
}

test("Models tab strips keep their full-bleed container borders aligned", async () => {
  const baseStyles = await readStylesheet("../src/styles.css");
  const workspaceStyles = await readStylesheet("../src/styles-models-workspace.css");
  const compatibilityStyles = await readStylesheet("../src/styles-compatibility-matrix.css");

  // The Combos workspace removes the outer container padding. Replacing the tab strip's
  // padding with an equal inline margin keeps its border aligned with the tab buttons.
  expect(effectiveDeclaration(
    baseStyles,
    ".main-inner.main-inner--combos > .page-tabs",
    "margin-inline",
  )).toBe("36px");
  expect(effectiveDeclaration(
    baseStyles,
    ".main-inner.main-inner--combos > .page-tabs",
    "padding-inline",
  )).toBe("0");

  // Every Models workspace tab uses the same column width, including loading/error states
  // where the panel content itself may not have mounted yet.
  for (const selector of [
    ".main-inner:has(#models-panel-catalog:not([hidden]))",
    ".main-inner:has(#models-panel-routing:not([hidden]))",
  ]) {
    expect(effectiveDeclaration(workspaceStyles, selector, "max-width")).toBe("1200px");
  }
  expect(effectiveDeclaration(
    compatibilityStyles,
    ".main-inner:has(#models-panel-compatibility:not([hidden]))",
    "max-width",
  )).toBe("1200px");
});
