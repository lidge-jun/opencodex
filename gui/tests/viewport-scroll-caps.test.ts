import { expect, test } from "bun:test";
import { allRuleBodies, effectiveDeclaration, ruleBodies, withoutComments } from "./helpers/css-declarations";

/**
 * Viewport-dependent sizing contracts in the shared stylesheet.
 *
 * Source-text assertions, not rendered measurements: happy-dom performs no layout, so a
 * computed max-width here would prove nothing. Rendered proof was captured in a real
 * browser via CDP while fixing these two rules; this file's job is to stop the specific
 * shapes that caused the defects from coming back silently.
 */

const cssUrl = new URL("../src/styles.css", import.meta.url);


test("the log table caps its scroll height against the dynamic viewport", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const wrap = allRuleBodies(css, ".logs-table-wrap");

  // Static `vh` resolves against the LARGE viewport, which ignores mobile browser chrome:
  // the cap is then computed for a viewport taller than the one the user can see and the
  // last rows sit underneath the address bar. The rest of the shell (.app, .sidebar,
  // .main-inner--combos, the mobile drawer) already uses 100dvh, so this rule was the
  // outlier rather than the convention.
  // The subtrahend is locked, not just the unit: a `calc(100dvh - <anything>)` would
  // satisfy a unit-only assertion while silently resizing the table. Read from the
  // EFFECTIVE declaration so a later duplicate rule cannot hide behind this one.
  const effective = effectiveDeclaration(css, ".logs-table-wrap", "max-height");
  const cap = effective.match(/^calc\(\s*100dvh\s*-\s*([\d.]+)px\s*\)$/);
  expect(cap).not.toBeNull();
  expect(Number(cap![1])).toBe(260);
  expect(wrap).not.toMatch(/max-height:\s*calc\(\s*100vh\s*-/);
});

test("the toast width cap outranks the later .notice rule", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());

  // Every toast carries BOTH classes, and `.notice { max-width: var(--prose-measure) }`
  // (70ch = 542px) is declared later in this same file at equal specificity 0,1,0. Source
  // order therefore won and a single-class `.action-toast` cap never applied - the toast
  // rendered 542px instead of its design width. Two classes is what wins the cascade, so
  // the cap must stay on the compound selector.
  // Again the EFFECTIVE declaration, for the same reason: a second `.action-toast.notice`
  // rule added later with a wrong width would win the cascade while the first one still
  // matched a first-occurrence assertion.
  const effective = effectiveDeclaration(css, ".action-toast.notice", "max-width");
  const cap = effective.match(/^min\(\s*([\d.]+)px\s*,\s*calc\(\s*100vw\s*-\s*([\d.]+)px\s*\)\s*\)$/);

  // Both halves are asserted on purpose. An earlier revision kept only the design width,
  // which dropped the viewport term and let the toast reach the screen edge at narrow
  // widths (measured left = 0 at 430px, losing the 24px inset the right side keeps).
  // Exact values, not merely positive ones: a 1px design width or a 1px inset would pass
  // a `> 0` check while destroying the layout. 480px is the design width and 48px is the
  // 24px inset doubled, both measured on the rendered toast.
  expect(cap).not.toBeNull();
  expect(Number(cap![1])).toBe(480);
  expect(Number(cap![2])).toBe(48);

  // Guard the ordering premise itself: if `.notice` ever moved ABOVE this rule, a
  // single-class cap would start working and someone could "simplify" the compound
  // selector away. The assertion is only meaningful while `.notice` still comes later.
  const noticeIndex = css.search(/(^|\n)\s*\.notice\s*\{/);
  const compoundIndex = css.search(/(^|\n)\s*\.action-toast\.notice\s*\{/);
  expect(compoundIndex).toBeGreaterThanOrEqual(0);
  expect(noticeIndex).toBeGreaterThan(compoundIndex);
});

test("the cap reader is not fooled by a custom property or an earlier duplicate", () => {
  // Both of these are regressions, not hypotheticals: each passed a previous revision of
  // this file while the rendered cap was wrong, and each was reproduced against the real
  // stylesheet before being closed. The fixture is inline so the guard is testable without
  // touching gui/src/styles.css.

  // A custom property whose NAME contains the property being read. Reading `max-height`
  // without a declaration boundary matched `--max-height` and reported the good value
  // while the real declaration was 261px.
  const masked = [
    ".logs-table-wrap {",
    "  max-height: calc(100dvh - 261px);",
    "  --max-height: calc(100dvh - 260px);",
    "}",
  ].join("\n");
  expect(effectiveDeclaration(masked, ".logs-table-wrap", "max-height")).toBe("calc(100dvh - 261px)");

  // A later duplicate rule for the same selector wins the cascade. Taking the FIRST match
  // reported the earlier correct value.
  const duplicated = [
    ".action-toast.notice { max-width: min(480px, calc(100vw - 48px)); }",
    ".action-toast.notice { max-width: min(200px, calc(100vw - 8px)); }",
  ].join("\n");
  expect(effectiveDeclaration(duplicated, ".action-toast.notice", "max-width")).toBe("min(200px, calc(100vw - 8px))");

  // A property that genuinely is not there must throw rather than silently report a
  // neighbouring declaration.
  expect(() => effectiveDeclaration(".logs-table-wrap { overflow-y: auto; }", ".logs-table-wrap", "max-height")).toThrow();
});

test("the cap reader survives case variants and refuses escaped identifiers", () => {
  // CSS property names are case-insensitive, so `MAX-HEIGHT` is a real declaration and won
  // the cascade while a case-sensitive reader reported the earlier lowercase value. Both of
  // these were demonstrated in a browser before being closed here.
  const shouted = [
    ".logs-table-wrap {",
    "  max-height: calc(100dvh - 260px);",
    "  MAX-HEIGHT: calc(100dvh - 261px);",
    "}",
  ].join("\n");
  expect(effectiveDeclaration(shouted, ".logs-table-wrap", "max-height")).toBe("calc(100dvh - 261px)");

  // An escaped identifier (`max\\2d height` is `max-height`) would need CSS unescaping to
  // compare. Rather than skip it and report a value it cannot prove is the winner, the
  // reader fails loudly - nothing in this stylesheet writes one.
  const escapedIdent = ".logs-table-wrap { max-height: calc(100dvh - 260px); max\\2d height: calc(100dvh - 261px); }";
  expect(() => effectiveDeclaration(escapedIdent, ".logs-table-wrap", "max-height")).toThrow(/escaped/);
});

test("an escape in a VALUE is ordinary CSS and must not trip the guard", () => {
  // The escape guard exists for property NAMES. Scanning the whole rule body would also
  // reject `content: "\\2014"`, which is ordinary CSS and says nothing about which
  // declaration wins - a false failure is as much a broken oracle as a false pass.
  const valueEscape = [
    ".logs-table-wrap {",
    "  content: \"\\\\2014\";",
    "  max-height: calc(100dvh - 260px);",
    "}",
  ].join("\n");
  expect(effectiveDeclaration(valueEscape, ".logs-table-wrap", "max-height")).toBe("calc(100dvh - 260px)");
});
