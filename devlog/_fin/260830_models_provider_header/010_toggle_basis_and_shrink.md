# 010 — Let the toggle's content be seen, and make every child yield

Fixes the geometry half. Meaning is phase `020`.

**Sixth design.** The five before it were each rejected by an adversarial reviewer or
by a stress measurement, and the rejections are the useful part — they map the shape
of the problem:

| draft | approach | killed by |
|-------|----------|-----------|
| 1 | shared-chip `nowrap`/`flex-shrink: 0` + inner `flex-wrap` + name ellipsis | inner wrap is inert; shared-chip change unsafe elsewhere |
| 2 | `min-width: max-content` floor | unbounded: 64-char name overflowed the card by 216px |
| 3 | floor + 16rem name cap + 12rem chip cap | 64-char name **and** alias together still overflowed 64px |
| 4 | `flex-basis: auto` + ellipsis on name and chip | the count and badge children kept min-content floors |
| 5 | `flex-basis: auto` + one rule for every child | let the fixed-size chevron shrink to 2.5px |
| **6** | **draft 5 + a `flex: none` exemption for the icon** | — |

Drafts 2-4 were three versions of one mistake: bound the row by naming the children
that could overflow it, then discover the next child. Draft 5 stops naming children —
and then over-applied, shrinking an icon that has no text to truncate. Draft 6 keeps
the universal rule and exempts the one child whose size is intrinsic rather than
textual. `011` records each failure.

## The mechanism, measured

At 1100px the collapsed row measures:

| element | width |
|---------|-------|
| `.models-provider-head` | 488.0 |
| `.models-provider-actions` | **422.9** (scrollWidth 423) |
| `.models-provider-toggle` | **31.1** (scrollWidth 93) |
| name span inside it | **0.0** (scrollWidth 44) |

The toggle carries inline `flex: 1` (`Models.tsx:1229`), which resolves to
`flex: 1 1 0%`. That zero **basis** is the defect. A flex item with a zero base size
never reports a content requirement, so the header — which already has
`flex-wrap: wrap` — never learns the toggle needs room and never wraps the actions
cluster to its own line. It keeps one line and hands the toggle the 31px remainder.

Inside that remainder the name absorbs the whole deficit, measures 0.0px, and —
carrying inline `white-space: nowrap` with default `overflow: visible` — paints its
glyphs across the count. The chip blob is the same starvation, finished by CJK
line-breaking between Hangul syllables. Even the chevron collapses: measured 0px wide
on a starved row, against 14px on a healthy one.

Two independent properties are required:

- **Visibility** — the toggle's content must enter the header's wrap decision, so it
  receives a share rather than a remainder. That is `flex-basis: auto`.
- **Boundedness** — whatever the content, the row must not force itself wider than the
  card. Shrinkability alone does not give this: a flex child stops at its own
  `min-width: auto` floor, which is its min-content width, and the *sum* of those
  floors can exceed the container.

The bound has one precondition worth stating plainly, because the round-5 audit caught
the document overstating it: `> *` selects **element** children. A bare string
interpolated directly into the button becomes an anonymous flex item, which no selector
can reach, and it would keep its own min-content floor. Every child today is an
`<svg>` or a `<span>`, so the rule covers all of them — but the guarantee is
"every element child, and the markup keeps children element-wrapped", not "anything
anyone adds later". The regression test asserts that second half.

Draft 2 bought visibility with a raised *minimum*, which is the direct enemy of
boundedness. Draft 4 bought boundedness for the two children it named and left the
count and the discovery badge with their automatic floors intact.

## The change

`gui/src/pages/Models.tsx` (—1229), the inline style on the toggle button:

```diff
-          style={{ flex: 1, border: 0, ... }}
+          style={{ flex: "1 1 auto", border: 0, ... }}
```

It has to be the TSX: an inline style beats any stylesheet rule short of
`!important`, and reaching for `!important` against markup we own is the wrong
trade.

`gui/src/styles-models-workspace.css`:

```css
 .models-provider-toggle {
   min-width: 0;
 }

+/* Every child, not an enumerated list. Four earlier designs bounded the row by
+   naming the children that could overflow it (name, then alias chip, then the
+   count and badge), and each revision found another one; a child added later
+   would have reintroduced the defect silently. Quantifying over the children
+   instead: min-width:0 removes the automatic min-content floor that stops a flex
+   child shrinking, and the ellipsis makes that shrink legible instead of clipped.
+   Covers every ELEMENT child; a bare interpolated string would become an
+   anonymous flex item no selector can reach, so keep children element-wrapped. */
+.models-provider-toggle > * {
+  min-width: 0;
+  overflow: hidden;
+  text-overflow: ellipsis;
+  white-space: nowrap;
+}

+/* The one exemption, and why it is not a return to enumerating children: every
+   other child is TEXT, whose overflow the ellipsis makes legible. The chevron is
+   an icon at a fixed 14px with nothing to truncate, so shrinking it destroys the
+   collapse affordance instead of abbreviating it. Selected by element TYPE, not
+   by identity — any future icon child inherits it without being named. Measured:
+   without this, the adversarial stress case shrinks the chevron to 2.5px while
+   the containment gate still reports success. */
+.models-provider-toggle > svg {
+  flex: none;
+}
```

`min-width: 0` on the toggle is **kept**, not replaced. That also means the existing
assertion at `gui/tests/models-provider-head.test.ts:29` stays green — draft 2 would
have broken it.

**No `max-width` anywhere, and no child named by identity.** The bound comes from
removing every child's floor, so there is nothing to forget and nothing to re-tune when
a chip is added to this header later. The single exemption selects on element type
(`svg`), which is the distinction that matters: text children abbreviate, icons do not.

## Measured result

Gate: in every cell `chipLines === 1`, name width > 0, name text overflow
(`scrollWidth - width`) <= 0, no page overflow.

| | ko | ru | fr | en | de |
|-|----|----|----|----|----|
| 1440 | pass | pass | pass | pass | pass |
| 1280 | pass | pass | pass | pass | pass |
| 1100 | pass | pass | pass | pass | pass |
| 1024 | pass | pass | pass | pass | pass |

20/20, worst bad-cell count 0, re-measured after the chevron exemption was added
(draft 6). The chevron also returns to 14px on the rows where it had collapsed to 0.

Containment, reading `cardScrollOver` = card `scrollWidth` minus its width, where
**positive means the card is silently clipping** (`.models-provider-card` sets
`overflow: hidden`, `styles-models-workspace.css:296`):

| stress case | baseline | draft 3 | draft 4 | draft 5 | **draft 6** |
|-------------|---------:|--------:|--------:|--------:|------------:|
| 64-char name @1100 | 39 | -2 | -2 | -2 | **-2** |
| 64-char alias @1100 | 16 | -2 | -2 | -2 | **-2** |
| name + alias together @1100 | 229 | **64** | -2 | -2 | **-2** |
| realistic worst row @1100 (64-char name + alias + longest `de` badge) | 229 | — | -2 | -2 | **-2** |
| adversarial: every child forced to 64 chars @1100 | 484 | — | **484** | -2 | **-2** |
| chevron width in that adversarial case | 14 | — | — | **2.5** | **14** |

The last row is what draft 4 could not survive and what forced the universal rule. It
is deliberately beyond reachable input — the count and badge are localized strings
with small interpolated numbers, not free text — but it is the only case that proves
the bound does not depend on knowing what the children are.

The final row is the round-5 audit finding, and it is the reason containment alone is
not a sufficient gate: draft 5 reported `cardScrollOver: -2` on the adversarial case
**while** silently shrinking the 14px collapse chevron to 2.5px. A gate that measures
only "does the row fit" certifies a fix that bought the fit by destroying an
affordance. `flex: none` on the icon restores 14px with containment unchanged at -2.

The gate is not vacuous: against the unpatched stylesheet it reports
`ko/1100 bad=3` (0px name, **6-line** chip) and `ko/1280 bad=4` (name 9.9px, chip 2
lines). `ru/1100` is green even unpatched — Russian wraps to a wider min-content —
which is why a single-locale check would have missed this defect entirely.

## Removal test

| dropped | normal bad cells @ko/1100 | adversarial stress | realistic stress | chevron @adversarial |
|---------|--------------------------:|-------------------:|-----------------:|---------------------:|
| nothing | 0 | -2 | -2 | 14 |
| `flex: 1 1 auto` | **3** | -2 | -2 | 14 |
| the child rule | 0 | **908** | **229** | 14 |
| the `svg` exemption | 0 | -2 | -2 | **2.5** |

All three are load-bearing and none substitutes for another: the basis fixes the
everyday defect, the child rule bounds the pathological ones, and the exemption keeps
the child rule from paying for that bound with the collapse affordance. Each row was
driven by actually removing the declaration and re-measuring. Contrast drafts 1 and 3,
where four of five and two of three declarations measured inert.

## Cost of the universal rule

`white-space: nowrap` on every child means no child of this header can wrap. That is
correct here — it is a single-line identity row of a slug, chips and a count, none of
which should ever wrap — but it is a real constraint on future content. Anything
genuinely multi-line belongs in `.models-provider-body`, not the header. The
alternative was another enumerated exception list, which is what drafts 2-4 already
disproved.

## What is deliberately NOT changed

- **The shared `.models-chip` rule.** Only the toggle's own children are touched. The
  model-row chips at `Models.tsx:1447-1455` sit in a non-wrapping `.row` with long
  translations (de "Benutzerdefiniert", ru "Пользовательская"); a primitive-level
  change there was rejected in draft 1.
- `overflow-wrap: anywhere` stays on the existing name rule although the inline
  `white-space: nowrap` makes it dead. Removing it is unrelated cleanup; it is noted
  so the next reader knows it is inert rather than load-bearing.

## Diff scope

- `gui/src/pages/Models.tsx` — one inline style value.
- `gui/src/styles-models-workspace.css` — two rules added (the universal child rule
  and the `svg` exemption); the existing `min-width: 0` on the toggle is kept.
- `gui/tests/models-provider-head.test.ts` — extended; the existing line-29
  `min-width: 0` assertion stays valid and must not be removed.
- `gui/tests/helpers/css-declarations.ts` — NEW. The shared source-text CSS readers,
  lifted out of `viewport-scroll-caps.test.ts` so two tests can use one copy.
- `gui/tests/viewport-scroll-caps.test.ts` — its four file-local helpers are deleted and
  replaced by an import from that module; its assertions are unchanged.

## Regression test (red first)

Use the effective-declaration reader so a commented-out or custom-property occurrence
cannot satisfy an assertion.

**It lives in `gui/tests/helpers/css-declarations.ts`**, which exports
`effectiveDeclaration`, `ruleBodies`, `allRuleBodies` and `withoutComments`.

That module is part of this change. The reader originated in
`viewport-scroll-caps.test.ts` (PR #2915) as four **file-local, unexported** functions,
so it could not be imported as first planned. B resolved that by moving all four into the
shared module and rewriting the original test to import them — one copy, not the third
copy that copying them here would have produced.

**What this gate can and cannot see.** The reader's own comment (:53) records that it
does not model competing specificity, `!important`, or at-rule nesting. So it proves
the four declarations exist on the exact selector, and nothing about computed layout:
the ellipsis, the containment numbers, and the 14px chevron are **measurements**
recorded above, not unit assertions. That split is deliberate and is why the tables in
this document are the primary evidence for the fix.

1. The provider-toggle button in `Models.tsx` carries `flex: "1 1 auto"`. The
   negative half must be **scoped to that style object**, not a file-wide search for
   `flex: 1` — a legitimate bare `flex: 1` exists at `Models.tsx:2162`, so a global
   assertion would be wrong. This is the declaration whose absence reproduces the
   user's screenshot.
2. `.models-provider-toggle > *` declares `min-width: 0`, `overflow: hidden`,
   `text-overflow: ellipsis` and `white-space: nowrap`, with a comment naming the
   defect so the rule is not narrowed back to specific children later.
3. `.models-provider-toggle > svg` declares `flex: none`. Assert this **separately**
   from rule 2: it is the declaration whose removal reintroduces the 2.5px chevron, and
   a reader who sees only the universal rule is likely to delete it as redundant.
4. Every direct child the toggle renders is an **element**, never a bare string. The
   universal selector cannot reach an anonymous flex item, so this is the invariant the
   `> *` bound actually rests on. Assert that the JSX between the toggle's opening and
   closing tag contains no bare interpolation — all seven children today are `<svg>` or
   `<span>`.

A declaration test cannot observe clipping, so the containment table above stays a
recorded measurement rather than a unit assertion.

## Render grounding

Screenshots at the failing width, captured from the running dashboard and then **read
back** rather than merely produced: `evidence/010-before-ko-1100.png` and
`evidence/010-after-ko-1100.png` (ko, 1100px, dpr 2, the second chip-bearing provider
row). The before shot is the shipped build with the fix reverted **in the browser** by an
injected override, so both images come from the same code and differ only by the two
declarations.

| | before | after |
|-|-------:|------:|
| capture height (dpr 2) | 696px | **416px** |
| rows containing ink | 365 | **101** |
| name box | 8.6px, chip on 6 lines | **43.6px, chip on 1 line** |

Pixel readback is the observation step: ink was counted per row against the sampled
background luminance, which is what confirms the vertical sprawl actually collapsed
rather than the clip rectangle merely shrinking.

The chevron was verified the same way, since a rendered width is exactly what the round-5
audit found the numbers hiding. Under the adversarial stress row at 1100:

| | `getBoundingClientRect` | drawn glyph span |
|-|------------------------:|-----------------:|
| shipped (exemption present) | **14.0px**, `flex-shrink: 0` | 9.5px |
| exemption overridden away | 4.9px, `flex-shrink: 1` | 36.8px of smeared ink |

Two notes on reproducing this. `Page.captureScreenshot` hangs indefinitely over CDP
unless `Page.bringToFront` is called first. And an injected `<style id="__cand">` from an
earlier harness run survives in the page, which silently made a first pair of "before"
and "after" screenshots byte-identical; the capture script now removes those ids and
asserts the geometry it expects before shooting.
