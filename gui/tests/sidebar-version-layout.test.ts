import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/styles/sidebar-brand.css", import.meta.url)).text();
const themeEntry = await Bun.file(new URL("../src/design/theme.css", import.meta.url)).text();

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

// These source guards complement browser geometry checks: merely removing the
// ellipsis lets a long version paint over the drawer close control. The header
// must wrap the badge, and the badge must also bound unbroken build identifiers.
test("the sidebar brand rules are loaded after the shared stylesheet", () => {
  // Design system v2 loads every v1 stylesheet from design/theme.css, in one `legacy`
  // layer, so source order inside that file is what decides precedence.
  const shared = themeEntry.indexOf('@import "../styles.css" layer(legacy);');
  const sidebar = themeEntry.indexOf('@import "../styles/sidebar-brand.css" layer(legacy);');
  expect(shared).toBeGreaterThan(-1);
  expect(sidebar).toBeGreaterThan(shared);
  expect(themeEntry.match(/@import "\.\.\/styles\/sidebar-brand\.css"/g)).toHaveLength(1);
});

test("the sidebar header wraps versions rather than squeezing the badge", () => {
  const brand = block(".drawer-head .brand");
  expect(brand).toContain("flex-wrap: wrap");
  expect(brand).toContain("column-gap: var(--space-1-5)");
  expect(brand).toContain("row-gap: var(--space-1)");
  expect(block(".drawer-head .brand .ver")).toContain("flex: 0 0 auto");
});

test("the drawer brand's first row shares the close button's center line", () => {
  // 44px close button, 26px name row: (44 - 26) / 2 puts both centers on one line.
  expect(block(".drawer-head .brand")).toContain("padding-top: calc((44px - 26px) / 2)");
});

test("long prerelease and unbroken build identifiers stay inside the header", () => {
  const badge = block(".drawer-head .brand .ver");
  expect(badge).toContain("max-width: 100%");
  expect(badge).toContain("white-space: normal");
  expect(badge).toContain("overflow-wrap: anywhere");
});

test("the full-version fallback does not hide or ellipsize its text", () => {
  const badge = block(".drawer-head .brand .ver");
  expect(badge).toContain("overflow: visible");
  expect(badge).toContain("text-overflow: clip");
  expect(badge).not.toContain("overflow: hidden");
  expect(badge).not.toContain("text-overflow: ellipsis");
  expect(badge).not.toContain("white-space: nowrap");
});

test("the fix stays scoped to the drawer and leaves compact topbar policies intact", () => {
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
    .map(match => match[1].trim());
  expect(selectors).toEqual([".drawer-head .brand", ".drawer-head .brand .ver"]);
});
