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

/**
 * Drop every `@container` block, leaving the unconditional cascade.
 *
 * `allRuleBodies` matches a selector wherever it appears, including inside a container
 * query, so a base-rule assertion silently reads the narrow-card overrides too. That is
 * not a hypothetical: the stacked regime legitimately sets `flex: 0 1 auto` on the control
 * group, which made an "the band never shrinks" assertion fail against a correct
 * stylesheet. The row-regime invariants below are about the base rule only.
 */
function baseCascade(css: string): string {
  return css.replace(/@container[^{]*\{[\s\S]*?\n\}/g, "");
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

test("the hint reserves the same LINE COUNT in both cards, not a pixel band", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());

  // Both cards wrap their control group onto a second flex line, and that line follows its
  // own card's copy height, so the copy row has to be equal in both cards.
  //
  // The old form of this rule was `min-height: 3.9375rem` on the COPY BLOCK — 63px, derived
  // as "21px title + 3px margin + two 19.5px hint lines". Two problems, both measured:
  // it assumed the hint wraps to two lines, and it hard-coded a line-height. At ru and fr
  // the vision hint takes a third line at a two-up card (82.5px of copy against 63px), and
  // the pair drifted 19.5px while en/ko/ja/zh/de/tr still measured clean.
  //
  // The floor now lives on the HINT and is expressed in `lh`, so it scales with the hint's
  // own line-height and states the real constraint: reserve N lines.
  const hint = allRuleBodies(css, ".dash-sidecar-row-card .dash-sidecar-copy .setting-hint");
  const floor = hint.match(/min-height:\s*([\d.]+)lh/);
  expect(floor).not.toBeNull();
  // Three lines is the longest shipped hint at the narrowest two-up card. Fewer than three
  // re-opens the ru/fr drift; the number is a measurement, not a preference.
  expect(Number(floor![1])).toBeGreaterThanOrEqual(3);

  // The pixel band must be gone from the copy block: leaving both would make it ambiguous
  // which one is load-bearing, and the pixel one is the one that was wrong.
  const copy = allRuleBodies(css, ".dash-sidecar-row-card .dash-sidecar-copy");
  expect(copy).not.toMatch(/min-height:\s*[\d.]+rem/);
});

test("both control groups reserve the same band and pack from its top", async () => {
  const css = baseCascade(withoutComments(await Bun.file(cssUrl).text()));
  const controls = allRuleBodies(css, ".dash-sidecar-row-card .dash-delegation-controls");

  // Equal bands are what let the shared row shell place the two groups identically, even
  // though their trailing rows differ in height (a label + switch against a single button).
  expect(controls).toMatch(/min-height:\s*[\d.]+rem/);

  // Both groups are COLUMNS of the same two rows: the select row, then the trailing row.
  // This replaced a single-line web-search group whose streaming label sat beside the
  // select and wrapped to three lines inside the band at ko/ja/tr.
  expect(controls).toMatch(/flex-direction:\s*column/);

  // Main axis is vertical, so packing the rows toward the band's top is `justify-content`.
  // `align-items: flex-start` would be the CROSS axis here and would shrink both rows to
  // their content width, un-aligning the trailing row's right edge from the card's.
  expect(controls).toMatch(/justify-content:\s*flex-start/);
  expect(controls).toMatch(/align-items:\s*stretch/);
});

test("both control groups start at the same x: one definite, unshrinkable band", async () => {
  const css = baseCascade(withoutComments(await Bun.file(cssUrl).text()));
  const controls = allRuleBodies(css, ".dash-sidecar-row-card .dash-delegation-controls");

  // The two groups hold different controls — web search is one select + label + switch
  // (268px at ja, 344px at fr), vision is two selects (408px) — so an intrinsic width
  // (`flex: 0 0 auto`) gives them different widths. Both pack toward the card's right
  // edge, and equal right edges with unequal widths means unequal LEFT edges: measured
  // 225-302px of divergence between the two model selects, locale-dependent. A definite
  // basis is what makes the start position structural instead of a text-width accident.
  const basis = controls.match(/flex:\s*0\s+0\s+min\(\s*100%\s*,\s*([\d.]+)rem\s*\)/);
  expect(basis).not.toBeNull();
  // The band must fit the widest content: the vision select row at full size is
  // 14rem + 8px + 9rem = 408px. Below that the selects shrink instead of aligning.
  expect(Number(basis![1])).toBeGreaterThanOrEqual(25.5);

  // The band must not shrink in the ROW regime: `flex-shrink` above 0 reintroduces
  // per-card widths, the same defect expressed as a shrink factor rather than an
  // intrinsic size. The stacked regime is excluded on purpose — there the card is one
  // column and `flex: 0 1 auto` with `flex-basis: 100%` is the correct shape.
  expect(controls).not.toMatch(/flex:\s*0\s+[1-9]/);
  expect(controls).not.toMatch(/flex-shrink:\s*[1-9]/);

  // The rows must span the band, not shrink to their content. `align-items: stretch` is
  // what makes the select row start at the band's left edge in both cards; the base
  // `.dash-delegation-controls` rule's `flex-end` would otherwise float a narrower row to
  // the band's right and start it late, which is the original bug scoped down to the band.
  expect(controls).toMatch(/align-items:\s*stretch/);
  expect(controls).not.toMatch(/align-items:\s*flex-end/);

  // And the band must be identical in BOTH cards, so the vision card may not override the
  // width. Overriding `flex` here is precisely what made the groups different sizes.
  const visionControls = allRuleBodies(css, ".dash-vision-sidecar-card .dash-delegation-controls");
  expect(visionControls).not.toMatch(/flex:\s/);
  expect(visionControls).not.toMatch(/flex-basis:/);

  // Copy is the item that absorbs leftover width, so a per-card copy basis moves the
  // band's left edge by the difference. It must resolve from the shared rule too.
  const visionCopy = allRuleBodies(css, ".dash-vision-sidecar-card .dash-sidecar-copy");
  expect(visionCopy).not.toMatch(/flex:\s/);
  expect(visionCopy).not.toMatch(/flex-basis:/);
});

test("the grid track is wide enough for a real row, not just a non-overflowing one", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const grid = ruleBody(css, ".dash-sidecar-grid");
  const track = grid.match(/minmax\(\s*min\(\s*100%\s*,\s*([\d.]+)rem/);
  expect(track).not.toBeNull();

  // The stacking container query below turns a card into copy-over-controls at 36rem of
  // card. A track narrower than that plus the panel's 2x19px padding hands out cards that
  // are born stacked — which is what shipped: 21rem produced 309-517px cards, every one
  // under the threshold, so the controls sat on a full-width second line inheriting
  // `justify-content: flex-end` and read as centred. The track floor must clear the
  // stacking threshold, not merely the overflow point.
  const stackingQuery = css.match(/@container\s+sidecar-card\s*\(\s*max-width:\s*([\d.]+)rem/);
  expect(stackingQuery).not.toBeNull();
  const paddingRem = 38 / 16;
  expect(Number(track![1])).toBeGreaterThan(Number(stackingQuery![1]) + paddingRem);
});

test("both cards wrap, so neither resolves its control group differently", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const card = allRuleBodies(css, ".dash-sidecar-row-card");
  expect(card).toMatch(/flex-wrap:\s*wrap/);

  // The wrapped LINES must pack from the top of the card. Equal copy bands alone are not
  // enough: the grid stretches both cards to the taller one's height, and `align-content`
  // defaults to `stretch` for a multi-line flex container, so each card spread its own
  // leftover space across its own lines. The two cards' content heights differ (the vision
  // control group carries the advanced disclosure), so the card with more slack pushed its
  // control line down — 27.4px at en/1024, 27.8px at ko/1024, 7.1px at ru/1100, and again
  // at 760px where the sidebar leaves the flow and the grid re-splits into two columns.
  //
  // This was verified by measuring the rendered page across 8 locales: with the bands but
  // WITHOUT this line the copy blocks were already equal (63/63) and the offset was still
  // 27.4px, which is what proves the lines — not the copy — were the mis-distributed thing.
  expect(card).toMatch(/align-content:\s*start/);

  // Wrapping only the vision card put its control group on a second line while the
  // web-search group stayed on the first — a guaranteed baseline mismatch. Likewise
  // `align-items: flex-start` on one card only: the two must resolve by the same rules.
  const vision = css.match(/(^|\n)\s*\.dash-vision-sidecar-card\s*\{([^}]*)\}/);
  if (vision) {
    expect(vision[2]).not.toMatch(/align-items:\s*flex-start/);
    expect(vision[2]).not.toMatch(/flex-wrap:\s*wrap/);
    // Same asymmetry hazard for the new rule: it belongs on the shared card class so both
    // cards resolve their lines identically, never on one of them.
    expect(vision[2]).not.toMatch(/align-content:/);
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
        expect(selector).toContain("dash-sidecar-select-row");
      }
    }
  }
});
