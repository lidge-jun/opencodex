import { expect, test } from "bun:test";

/**
 * The Codex Set page head must be able to wrap.
 *
 * The standalone head holds a title and feedback slot. Long translated feedback
 * must wrap below the title without clipping; pause/refresh have a separate row.
 *
 * Source-text assertions, not measurements: happy-dom performs no layout, so a
 * getBoundingClientRect() here returns zeros and would prove nothing. The
 * rendered proof was captured in a real browser and lives in
 * devlog/_plan/260904_codex_set_head_and_logo/030_live_verification_record.md.
 * What this file guards is the declaration that produced it.
 */
const cssUrl = new URL("../src/styles.css", import.meta.url);

/** Strip comments so no assertion can pass on prose that quotes a value. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Body of a top-level rule. Anchored with no leading whitespace on purpose, so a
 * selector that also appears indented inside an `@media` block is not read off
 * the wrong rule.
 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[2]!;
}

test("the Codex Set page head and its action cluster both wrap", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());

  // The head wraps so the cluster can drop below the title instead of competing
  // with it for one line.
  expect(ruleBody(css, ".codex-auth-page-head")).toContain("flex-wrap: wrap");

  // The cluster wraps so it can break internally when even a full row is not
  // enough, staying right-aligned as it does at wide widths.
  const actions = ruleBody(css, ".codex-auth-page-head__actions");
  expect(actions).toContain("flex-wrap: wrap");
  expect(actions).toContain("justify-content: flex-end");
});
