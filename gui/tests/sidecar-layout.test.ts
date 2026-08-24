import { expect, test } from "bun:test";

/**
 * Sidecar card layout contract.
 *
 * Source-text assertions, not rendered measurements: happy-dom performs no layout, so
 * `offsetHeight` here would prove nothing (see the note in
 * codex-auto-switch-controller.test.tsx). Rendered proof was captured in a real browser
 * during the fix; this file's job is to make the specific CSS shape that caused the bug
 * impossible to reintroduce silently.
 *
 * The bug (ko, 1125px viewport): the "웹 검색 사이드카" card rendered its title 17px wide
 * and 147px tall — one glyph per line — and the card grew from 157px to 618px. Separately,
 * the two cards' Select triggers were never on the same baseline (Δ 16px at 2000px, worse
 * as the cards narrowed).
 */

const cssUrl = new URL("../src/styles-dashboard-workspace.css", import.meta.url);

/** Slice one rule body by exact selector. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[2];
}

/** All bodies for a selector that is declared more than once. */
function allRuleBodies(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  if (matches.length === 0) throw new Error(`rule not found: ${selector}`);
  return matches.map(m => m[2]).join("\n");
}

/** Strip comments so no assertion can pass on prose that quotes an old value. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the copy block has a width floor and never breaks per glyph", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const copy = allRuleBodies(css, ".dash-sidecar-row-card .dash-sidecar-copy");

  // `overflow-wrap: anywhere` on a zero-width CJK box is what produced the one-glyph
  // column. On a box that can no longer reach zero width it is unnecessary, and if the
  // floor is ever removed it is what turns a squeeze back into a stripe.
  expect(copy).not.toContain("anywhere");

  // The floor itself. `flex: 1 1 0` makes copy the only item that yields, so without a
  // min-width its used width goes to zero as soon as the control row outgrows the track.
  const floor = copy.match(/min-width:\s*min\(\s*100%\s*,\s*([\d.]+)rem\s*\)/);
  expect(floor).not.toBeNull();
  expect(Number(floor![1])).toBeGreaterThanOrEqual(14);
});

test("both cards reserve the same copy band, so their control lines start together", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const copy = allRuleBodies(css, ".dash-sidecar-row-card .dash-sidecar-copy");

  // Both cards wrap their control group onto a second flex line, and that line follows
  // its own card's copy height. The two hints are different lengths in every locale
  // (ko: 30 vs 41 chars), so without a shared band the two Selects drift by a line.
  const band = copy.match(/min-height:\s*([\d.]+)rem/);
  expect(band).not.toBeNull();
  // 21px title + 3px hint margin + two 19.5px hint lines = 63px = 3.9375rem.
  expect(Number(band![1])).toBeGreaterThanOrEqual(3.9);
});

test("both control groups reserve the same band and pack from its top", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const controls = allRuleBodies(css, ".dash-sidecar-row-card .dash-delegation-controls");

  // The web-search group is one 34px select row; the vision group is a 59px column
  // (select row + 12px gap + the "advanced" disclosure). Equal bands are what let the
  // shared row shell place them identically.
  expect(controls).toMatch(/min-height:\s*[\d.]+rem/);

  // `align-items`, not `align-content`: the web-search group is a single flex line and
  // `align-content` does nothing there — it silently left the Select 13.5px low.
  expect(controls).toMatch(/align-items:\s*flex-start/);
});

test("both cards wrap, so neither resolves its control group differently", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const card = allRuleBodies(css, ".dash-sidecar-row-card");
  expect(card).toMatch(/flex-wrap:\s*wrap/);

  // Wrapping only the vision card put its control group on a second line while the
  // web-search group stayed on the first — a guaranteed baseline mismatch. Likewise
  // `align-items: flex-start` on one card only: the two must resolve by the same rules.
  const vision = css.match(/(^|\n)\s*\.dash-vision-sidecar-card\s*\{([^}]*)\}/);
  if (vision) {
    expect(vision[2]).not.toMatch(/align-items:\s*flex-start/);
    expect(vision[2]).not.toMatch(/flex-wrap:\s*wrap/);
  }
});

test("the grid drops to one column before a card is too narrow for its control row", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const grid = ruleBody(css, ".dash-sidecar-grid");

  // Parsed numerically: a toContain("21rem") would pass on a comment.
  const floor = grid.match(/minmax\(\s*min\(\s*100%\s*,\s*([\d.]+)rem/);
  expect(floor).not.toBeNull();
  // The copy floor is 14rem and the ko control row needs ~20.4rem, so the track cannot
  // usefully go below the copy floor itself.
  expect(Number(floor![1])).toBeGreaterThanOrEqual(14);
});

test("the responsive axis is the card, not the viewport", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const card = allRuleBodies(css, ".dash-sidecar-row-card");

  // This grid is repeat(auto-fit, ...), so a 336px card exists inside a 992px window.
  // A viewport media query on these cards fires at the wrong time or never.
  expect(card).toContain("container-type: inline-size");
  expect(card).toContain("container-name: sidecar-card");

  // Wrong-axis guard: no @media block may target the sidecar cards.
  for (const block of css.match(/@media[^{]*\{[\s\S]*?\n\}/g) ?? []) {
    expect(block).not.toContain(".dash-sidecar-row-card");
    expect(block).not.toContain(".dash-vision-sidecar-card");
    expect(block).not.toContain(".dash-sidecar-copy");
  }
});

test("container-query rules are specific enough to win the cascade", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const queries = css.match(/@container[^{]*\{[\s\S]*?\n\}/g) ?? [];
  expect(queries.length).toBeGreaterThan(0);

  for (const query of queries) {
    for (const match of query.matchAll(/\n\s{2}([^{@}]+)\{/g)) {
      const selector = match[1].trim();
      if (!/dash-sidecar-copy|dash-delegation-controls/.test(selector)) continue;
      // A bare .dash-sidecar-copy is 0,1,0 and silently loses to the 0,2,0 base rules,
      // leaving a query that reads as correct in review but does nothing.
      for (const part of selector.split(",")) {
        expect(part.split(".").length - 1).toBeGreaterThanOrEqual(2);
      }
    }
  }
});

test("narrow-card rules apply to both cards, never one of them", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const queries = css.match(/@container[^{]*\{[\s\S]*?\n\}/g) ?? [];

  // Stacking one card's control group while the other keeps a different basis is the
  // asymmetry that broke the shared baseline; it measured 1.19px when the 36rem query
  // was vision-only.
  for (const query of queries) {
    for (const match of query.matchAll(/\n\s{2}([^{@}]+)\{([^}]*)\}/g)) {
      const [, selector, body] = match;
      if (!/flex-basis|align-items/.test(body)) continue;
      if (!/dash-delegation-controls|dash-sidecar-copy/.test(selector)) continue;
      // A vision-only selector may only carry vision-specific concerns (its select row),
      // never the shared copy/control basis.
      if (selector.includes("dash-vision-sidecar-card")) {
        expect(selector).toContain("dash-vision-select-row");
      }
    }
  }
});

