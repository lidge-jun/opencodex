/**
 * Source-text readers for stylesheet assertions.
 *
 * happy-dom performs no layout, so a test in this directory cannot read a computed
 * value. These helpers read the CSS *source* carefully enough that an assertion cannot
 * be satisfied by a commented-out value, a custom property, or an earlier duplicate of
 * a rule that a later one overrides.
 *
 * Lifted out of `viewport-scroll-caps.test.ts` (PR #2915), where they were file-local,
 * when a second test needed them. Every false negative documented below was found by
 * review and reproduced red before being closed; the comments are the reason this is
 * shared rather than re-implemented per test.
 */

/** Strip comments so no assertion can pass on prose that quotes an old value. */
export function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** All bodies for a selector, which may be declared more than once. */
export function allRuleBodies(css: string, selector: string): string {
  return ruleBodies(css, selector).join("\n");
}

/** Every body for a selector, in source order. */
export function ruleBodies(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp("(^|\\n)\\s*" + escaped + "\\s*\\{([^}]*)\\}", "g"))];
  if (matches.length === 0) throw new Error("rule not found: " + selector);
  return matches.map((m) => m[2]);
}

/**
 * The last *textual* declaration of a property across all bodies of an exact selector,
 * matched on the property's canonical lowercase spelling.
 *
 * Two false negatives, both found by review and both reproduced before being closed:
 *
 * 1. Concatenating bodies and taking the FIRST match let a second rule for the same
 *    selector, added later with a wrong value, win the cascade while the earlier correct
 *    declaration still satisfied the assertion. Hence reading the last occurrence.
 * 2. An unanchored property name matched inside a CUSTOM PROPERTY, so
 *    `max-height: calc(100dvh - 261px); --max-height: calc(100dvh - 260px)` passed with
 *    the rendered cap wrong. Hence the boundary below: the property must start the body
 *    or follow `;`/newline, and must not be preceded by `-`.
 *
 * CSS property names are case-insensitive, and an identifier may be written with escapes
 * (`max\\2d height` is `max-height`). A case-sensitive literal match therefore reported
 * the wrong winner when the real declaration used `MAX-HEIGHT`. Matching is now
 * case-insensitive, and an escape in the property name is rejected outright rather than
 * silently skipped: nothing in these stylesheets writes one, so its appearance means the
 * oracle no longer understands the file and should fail loudly instead of guessing.
 *
 * Scope, stated because an earlier version of this comment overclaimed: this is source
 * order within one exact selector string. It does not model `!important`, competing
 * selectors of different specificity, or @-rule nesting. A caller that depends on any of
 * those must assert the cascade question separately, or measure it in a real browser.
 */
export function effectiveDeclaration(css: string, selector: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(?:^|[;{\\n])\\s*" + escaped + "\\s*:\\s*([^;}]+)", "gi");
  let winner: string | null = null;
  // Only an escape in PROPERTY-NAME position defeats this reader. Scanning the whole body
  // would also reject an escape in a value - `content: "\\2014"` is ordinary CSS - so the
  // guard is anchored the same way the matcher is: body start or after `;`/newline, then a
  // name containing a hex escape, then a colon.
  const escapedName = /(?:^|[;{\n])\s*[-\w]*\\[0-9a-fA-F]/;
  for (const body of ruleBodies(css, selector)) {
    // An escaped identifier would need CSS unescaping to compare; refuse rather than report
    // a value this reader cannot prove is the winner.
    if (escapedName.test(body)) {
      throw new Error("escaped property identifier in " + selector + "; this reader cannot resolve it");
    }
    for (const m of body.matchAll(pattern)) winner = m[1].trim();
  }
  if (winner === null) throw new Error("property not found: " + selector + " { " + property + " }");
  return winner;
}
