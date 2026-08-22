import { expect, test } from "bun:test";

/**
 * Portaled Select menus open over rows beneath their trigger. A translucent
 * `color-mix(… canvas 84%, transparent)` fill let those rows (and their
 * switches) show through — Subagents → Settings made the Tell Codex switch
 * look like it floated above the Preferred-model list. The fill must stay
 * opaque; blur is optional refraction only.
 */

async function styles(): Promise<string> {
  return Bun.file(new URL("../src/styles.css", import.meta.url)).text();
}

/** Declaration body of the first unscoped `.select-dropdown { … }` rule. */
function selectDropdownBody(css: string): string {
  const match = css.match(/(?:^|\n)\s*\.select-dropdown\s*\{([^}]*)\}/);
  expect(match).toBeTruthy();
  return match![1]!;
}

/** Slice from `@supports not ((backdrop-filter…` through its closing `}`. */
function supportsNoBlurBlock(css: string): string {
  const start = css.indexOf("@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error("unclosed @supports not (backdrop-filter) block");
}

/** Slice from `@media (prefers-reduced-transparency: reduce)` through its closing `}`. */
function reducedTransparencyBlock(css: string): string {
  const start = css.indexOf("@media (prefers-reduced-transparency: reduce)");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error("unclosed prefers-reduced-transparency block");
}

/** Every `background` / `background-color` value in the rule, in source order. */
function backgroundDeclarations(body: string): string[] {
  // Lookbehind (not `^|;`) so a comment between declarations still counts.
  return [...body.matchAll(/(?<![\w-])(?:background-color|background)\s*:\s*([^;]+)/g)].map(
    (match) => match[1]!.trim(),
  );
}

/**
 * The winning fill must stay `var(--surface)`. Checking the complete set
 * rejects a later translucent override (`rgb(… / a)`, `rgba()`, `hsl()`,
 * `hsla()`, `transparent`, `color-mix(…)`) that would still match an earlier
 * `background: var(--surface)`.
 */
function expectOpaqueSurfaceBackgrounds(body: string): void {
  const backgrounds = backgroundDeclarations(body);
  expect(backgrounds.length).toBeGreaterThan(0);
  for (const value of backgrounds) {
    expect(value).toBe("var(--surface)");
  }
}

test("select-dropdown fill is opaque surface, not a translucent canvas mix", async () => {
  const body = selectDropdownBody(await styles());
  expectOpaqueSurfaceBackgrounds(body);
  expect(body).not.toMatch(/color-mix\s*\(/);
  expect(body).not.toMatch(/transparent/);
});

test("select-dropdown keeps solid fallbacks when blur is missing or unwanted", async () => {
  const css = await styles();
  const noBlur = selectDropdownBody(supportsNoBlurBlock(css));
  expectOpaqueSurfaceBackgrounds(noBlur);

  const reduced = selectDropdownBody(reducedTransparencyBlock(css));
  expectOpaqueSurfaceBackgrounds(reduced);
  // Declaration boundary so `-webkit-backdrop-filter` cannot satisfy this.
  expect(reduced).toMatch(/(?:^|;)\s*backdrop-filter:\s*none\s*;/);
  expect(reduced).toMatch(/(?:^|;)\s*-webkit-backdrop-filter:\s*none\s*;/);
});
