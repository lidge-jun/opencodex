# 040 — Regression coverage for the two chrome fixes

## Why this exists

Both fixes in #3465 shipped with live proof and zero committed guard. Two
independent reviewers flagged the same hole from opposite directions:

- The plan auditor found `gui/tests/sidebar-codex-set.test.ts:28` pinning
  `Icon: IconKey` and required it be unpinned. It was.
- CodeRabbit then observed that unpinning removed the *only* thing tying that
  nav row to any icon at all, and asked for focused coverage of the new mapping.

Both are right, and they are not in conflict — the mistake would be to answer
the second by undoing the first. The comment already in that file says why:
pinning "the shape of one line" made the test fail "the moment an entry gained a
field — a change it was never written to catch". Re-pinning the whole literal
with a new icon name recreates exactly that.

The CSS fix has no guard either. `rg -l codex-auth-page-head gui/tests` returns
one file, about toast tone, not layout. A future `flex-wrap` removal would
restore the clip silently.

## What to assert, and where

A sibling file, `gui/tests/codex-set-chrome.test.ts`, not an extension of the
sidebar test. That file's subject is routing identity — "always present, never
filtered by view mode", plus the legacy `#codex-auth` bookmark. Icon identity
and page-head layout are a different contract, and `anthropic-pool-card-layout.test.ts`
is the precedent for giving a visual contract its own file with its own
explanation of why each value is what it is.

Instrument: source-text assertions, matching this suite's convention for
anything layout-shaped. `anthropic-pool-card-layout.test.ts` states the reason
outright — happy-dom performs no layout, so `getBoundingClientRect()` returns
zeros and would prove nothing. The rendered proof for this unit lives in `030`
as real-browser measurements; these tests guard the source that produced it.

Borrow that file's two safeguards:

- `withoutComments()` before matching CSS, so an assertion can never pass on
  prose quoting the value. This unit's fix ships with a long explanatory comment
  that literally contains the words `flex-wrap`, so without stripping, the CSS
  assertions would be self-satisfying. This is the single most important detail
  here.
- `ruleBody()` anchored at line start, so a selector that also appears indented
  inside `@media` is not read off the wrong rule.

### wp4-a/b — the row wears the mark, asserted through a render

The first draft of this doc proposed `toContain('Icon: IconCodex')`. A reviewer
rejected it, correctly: that is the *same* fragility the sidebar test documents
removing, one rename later. Renaming the symbol is not a regression; the string
breaks anyway. What must not change is the glyph.

So the name is read from the NAV row only to *resolve* the component, and every
assertion lands on rendered output:

1. Strip comments from `App.tsx`, slice the `NAV` table, and capture the
   `Icon:` identifier for the `codex-set` row. Source text is forced here —
   `NAV` is not exported, so no other instrument can observe the mapping.
2. Resolve that name against the `icons` module namespace and fail with a
   readable message if it is not exported.
3. `renderToStaticMarkup` it and assert the geometry.

Rendering is the right instrument for the second half because the JSX is
multi-line and attribute-ordered — `toContain('strokeWidth={2.484}')` would
break on a reformat. `renderToStaticMarkup` normalizes to
`stroke-width="2.484"` regardless of authoring style. It is also the suite's
*lighter* render instrument: happy-dom is installed but needs five global swaps
plus teardown, and no layout, event, or lifecycle behavior is under test here.

Geometry is asserted as tokens from the `d` attribute — the ring's radius and
its extreme points, the underscore, the chevron — with whitespace collapsed
first, so a decimal-preserving reflow passes while a redraw fails.

The specific silent-revert this guards, which the first draft failed to name:
folding the mark back through `S()`. That helper hardcodes a 24-unit box and
stroke 2, which rescales a path drawn for 32 units and still renders something
icon-shaped — review does not catch it, and `stroke-width="2.484"` does not
contain `stroke-width="2"`. Hence the negative assertions on
`viewBox="0 0 24 24"` and `stroke-width="2"`.

File: `gui/tests/sidebar-codex-mark.test.tsx`, a sibling rather than an
extension. `sidebar-codex-set.test.ts`'s declared subject is the row surviving
the removed viewMode filter; mark identity is a different contract, and this
repository already keeps mark-identity tests in their own files
(`provider-icons`, `client-marks-assets`, `integration-marks`).

### wp4-c — the page head still wraps

```ts
expect(ruleBody(css, ".codex-auth-page-head")).toContain("flex-wrap: wrap");
expect(ruleBody(css, ".codex-auth-page-head__actions")).toContain("flex-wrap: wrap");
```

on comment-stripped CSS.

## What this does NOT catch

Worth stating so nobody reads more into a green run than is there:

- It does not catch upstream drift. Nothing re-fetches `success.html`; this pins
  "matches what was copied on 2026-09-04", not "matches upstream today".
- It does not catch a mangled path that happens to retain the asserted tokens.
  Closing that needs a full normalized-`d` equality, at real formatting cost —
  a deliberate trade.
- It does not prove the sidebar renders the icon at all: the row is read as
  source text, so deleting `<Icon />` from the nav JSX would leave this green.
- It does not prove the head *renders* unclipped. No layout engine runs. A
  change to `.page-head`, `.btn`, or the container width could reintroduce a clip
  with both `flex-wrap` declarations still present. Only `030`'s browser
  measurements prove the rendered outcome, and only for the moment they were taken.
- It does not cover 17px sizing, `currentColor` inheritance, or theme contrast.
- It does not cover the `embedded` variant, which never had the defect.
- It does not cover the other eight nav rows, whose glyphs stay freely swappable.

## Verification

`bun test --isolate tests/sidebar-codex-mark.test.tsx tests/codex-set-chrome.test.ts`
plus the existing `tests/sidebar-codex-set.test.ts`, and both new files driven
red once — the mark test by pointing the row at a neighbouring glyph, the CSS
test by removing a `flex-wrap` — because an assertion never seen to fail is not
known to be load-bearing. No repository-wide suite.
