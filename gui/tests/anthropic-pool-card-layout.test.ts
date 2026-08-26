import { expect, test } from "bun:test";

/**
 * Claude account-pool card inset contract. The rule comment on
 * `.anthropic-pool-card__notice` in `src/styles.css` explains why each value is what it is.
 *
 * Source-text assertions, not rendered measurements: happy-dom performs no layout, so a
 * getBoundingClientRect() here returns zeros and would prove nothing. Rendered proof was
 * captured in a real browser during the fix — the title sat 17px from the card's left edge
 * while the warning box and the threshold input sat at 1px.
 */

const cssUrl = new URL("../src/styles.css", import.meta.url);
const tsxUrl = new URL(
  "../src/components/provider-workspace/AnthropicAccountPoolSettings.tsx",
  import.meta.url,
);

/** Strip comments so no assertion can pass on prose that quotes a value. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Body of a top-level rule. Anchored with no leading whitespace on purpose: `.setting-row`
 * also appears indented inside an `@media` block that only sets `flex-wrap`, and matching
 * that one instead would read the inset off the wrong rule.
 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[2];
}

/** Horizontal component of a `margin`/`padding` shorthand, in px. */
function horizontal(body: string, property: "margin" | "padding"): number {
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`));
  if (!match) throw new Error(`${property} not found in: ${body.trim()}`);
  const parts = match[1].trim().split(/\s+/);
  // 1 value: all sides. 2-3 values: second is the horizontal one. 4: right, then left.
  const side = parts.length === 1 ? parts[0] : parts[1];
  const px = side.match(/^([\d.]+)(?:px)?$/);
  if (!px) throw new Error(`${property} value is not a px length: ${side}`);
  return Number(px[1]);
}

/** The inset every padded row in this card already uses. */
async function rowInset(): Promise<number> {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const cardRow = horizontal(ruleBody(css, ".card-row"), "padding");
  const settingRow = horizontal(ruleBody(css, ".setting-row"), "padding");
  const cardSub = horizontal(ruleBody(css, ".card-sub"), "padding");
  // The three disagree only if the card's own baseline moved, which this contract cannot
  // silently follow — a mismatch means the target inset has to be re-decided, not guessed.
  expect(settingRow).toBe(cardRow);
  expect(cardSub).toBe(cardRow);
  return cardRow;
}

test("the warning box is inset by the same amount as the card's padded rows", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const notice = ruleBody(css, ".anthropic-pool-card__notice");
  expect(horizontal(notice, "margin")).toBe(await rowInset());
});

test("the threshold field is inset by the same amount as the card's padded rows", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());
  const field = ruleBody(css, ".anthropic-pool-card__field");
  expect(horizontal(field, "padding")).toBe(await rowInset());
});

test("the help line inside the threshold field is not indented twice", async () => {
  const css = withoutComments(await Bun.file(cssUrl).text());

  const group = css.match(
    /(^|\n)([^{}]*\.anthropic-pool-card__field \.card-sub\s*)\{([^}]*)\}/,
  );
  expect(group).not.toBeNull();
  expect(horizontal(group![3], "padding")).toBe(0);
});

test("the component styles the warning and the field by class, not inline", async () => {
  const tsx = await Bun.file(tsxUrl).text();

  expect(tsx).toContain('className="card-sub anthropic-pool-card__notice"');
  expect(tsx).toContain('className="field anthropic-pool-card__field"');

  // The inline box styles are what bypassed the inset: an inline `padding` also outranks
  // any stylesheet rule, so reintroducing one silently disables the fix above.
  expect(tsx).not.toContain('padding: "10px 16px"');
  expect(tsx).not.toContain("borderRadius");
  expect(tsx).not.toMatch(/style=\{\{[^}]*marginTop: 10/);
  expect(tsx).not.toMatch(/style=\{\{[^}]*display: "block"/);
});
