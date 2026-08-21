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

/** Declaration body of the first top-level `.select-dropdown { … }` rule. */
function baseSelectDropdownBody(css: string): string {
  const match = css.match(/(?:^|\n)\.select-dropdown\s*\{([^}]*)\}/);
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

test("select-dropdown fill is opaque surface, not a translucent canvas mix", async () => {
  const body = baseSelectDropdownBody(await styles());
  expect(body).toMatch(/background:\s*var\(--surface\)/);
  expect(body).not.toMatch(/color-mix\s*\(/);
  expect(body).not.toMatch(/transparent/);
});

test("select-dropdown keeps solid fallbacks when blur is missing or unwanted", async () => {
  const css = await styles();
  const noBlur = supportsNoBlurBlock(css);
  // Unscoped `.select-dropdown`, not only the lang-toggle override.
  expect(noBlur).toMatch(/(?:^|\n)\s*\.select-dropdown\s*\{[^}]*background:\s*var\(--surface\)/);

  const reduced = reducedTransparencyBlock(css);
  expect(reduced).toMatch(
    /(?:^|\n)\s*\.select-dropdown\s*\{[^}]*background:\s*var\(--surface\)[^}]*backdrop-filter:\s*none/,
  );
});
