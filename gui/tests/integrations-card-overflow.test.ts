import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/styles-integrations.css", import.meta.url)).text();

function rule(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error("selector not found: " + selector);
  return css.slice(start, css.indexOf("}", start));
}

// Measured with CDP at 320px, 375px and 736px before this test existed: the
// "Settings" button in .integration-card-actions rendered at left=326,
// right=409 on a 320px viewport - 89px outside the page. The chain was
// button.btn-ghost > .integration-card-actions > .integration-card >
// .integration-cards, and .integration-cards used
// repeat(auto-fill, minmax(260px, 1fr)).
//
// A fixed 260px minimum is wider than the content box of a 320px viewport once
// the page padding is taken out, so the track could not shrink and the card
// overflowed with it. min() lets the track fall back to the available width.
test("integration cards cannot force a track wider than the viewport", () => {
  const grid = rule(".integration-cards {");
  expect(grid).toContain("auto-fill");
  // The floor has to be viewport-relative, not a bare pixel value.
  expect(grid).toMatch(/minmax\(\s*min\(/);
});

// The actions row is what carried the overflow outward. Wrapping keeps a long
// label from pushing the row past the card edge.
test("card actions wrap instead of pushing past the card", () => {
  const actions = rule(".integration-card-actions {");
  expect(actions).toContain("flex-wrap: wrap");
  expect(actions).toContain("min-width: 0");
});

