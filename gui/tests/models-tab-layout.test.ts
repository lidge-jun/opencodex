import { expect, test } from "bun:test";
import { effectiveDeclaration, ruleBodies, withoutComments } from "./helpers/css-declarations";

async function readStylesheet(path: string): Promise<string> {
  return withoutComments(await Bun.file(new URL(path, import.meta.url)).text());
}

test("Models tab strips keep their full-bleed container borders aligned", async () => {
  const baseStyles = await readStylesheet("../src/styles.css");
  const workspaceStyles = await readStylesheet("../src/styles-models-workspace.css");
  const compatibilityStyles = await readStylesheet("../src/styles-compatibility-matrix.css");

  // The Combos workspace removes the outer container padding. Replacing the tab strip's
  // padding with an equal inline margin keeps its border aligned with the tab buttons.
  const tabStripSelector = ".main-inner.main-inner--combos > .page-tabs";
  const tabStripBodies = ruleBodies(baseStyles, tabStripSelector);
  expect(tabStripBodies[0]).toMatch(/margin-inline:\s*36px/);
  expect(effectiveDeclaration(baseStyles, tabStripSelector, "margin-inline")).toBe("18px");
  expect(effectiveDeclaration(
    baseStyles,
    tabStripSelector,
    "padding-inline",
  )).toBe("0");
  expect(tabStripBodies.at(-1)).toMatch(/padding-inline:\s*0/);

  // Loading, empty, and error fallbacks do not render the workspace shell. Keep those
  // shell-free states boxed instead of allowing the full-bleed Combos container to stretch
  // their notice and retry controls edge to edge.
  const shellFreeContainer = ".main-inner.main-inner--combos:not(:has(.combos-workspace-shell))";
  expect(effectiveDeclaration(baseStyles, shellFreeContainer, "max-width")).toBe("1200px");
  expect(effectiveDeclaration(baseStyles, shellFreeContainer, "margin")).toBe("0 auto");
  expect(ruleBodies(baseStyles, shellFreeContainer)[0]).toMatch(/padding:\s*32px 0 64px/);
  expect(effectiveDeclaration(baseStyles, shellFreeContainer, "padding")).toBe("22px 18px 48px");

  const shellFreePanel = `${shellFreeContainer} > .models-tab-panel--fill:not([hidden])`;
  expect(effectiveDeclaration(baseStyles, shellFreePanel, "display")).toBe("block");
  expect(ruleBodies(baseStyles, shellFreePanel)[0]).toMatch(/padding-inline:\s*36px/);
  expect(effectiveDeclaration(baseStyles, shellFreePanel, "padding-inline")).toBe("0");

  for (const selector of [
    `${shellFreeContainer} > .page-head`,
    `${shellFreeContainer} > .page-tabs`,
    `${shellFreeContainer} > .page-sub`,
  ]) {
    expect(effectiveDeclaration(baseStyles, selector, "padding-inline")).toBe("0");
  }
  expect(effectiveDeclaration(baseStyles, `${shellFreeContainer} > .page-tabs`, "margin-inline")).toBe("0");

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
