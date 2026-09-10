# Sidecar control band: one shared start position

Status: shipped on `codex/sidecar-shared-control-band`.

## Reported symptom

The two dashboard sidecar cards looked centre-aligned rather than
left-copy / right-controls, and the two model selects did not start at the
same x.

## Two independent causes

Both were measured over CDP in a real browser across the eight shipped
locales, not inferred from the stylesheet.

### 1. Every two-up card was born stacked

`.dash-sidecar-grid` used a `21rem` track floor. The stacking container query
fires at `36rem` of card. A two-up card therefore had 309-517px of content --
always under the threshold -- so it entered the stacked regime immediately:
copy on a full-width flex line, controls on a second full-width line
inheriting `justify-content: flex-end` from the shared
`.dash-delegation-controls` rule. The model select floated in the middle of
the card with the switch pinned to the right edge, which is what reads as
centred.

The track floor is now `39rem`: 624px of track, 586px of content after the
panel's 2x19px padding, clear of the 576px stacking threshold. A card the grid
places two-up can now hold a real row, and below that the grid drops to one
column where a card is wide enough for the same row.

The general lesson: the track floor is the width at which a card can render
its intended LAYOUT, not the width at which its widest control stops
overflowing. The old comment stated the second and the number satisfied only
that.

### 2. The two control groups sized intrinsically

The groups do not hold the same controls. Web search is one select plus a
label and a switch; vision is two selects. Measured natural widths at 1600px:

| locale | web search | vision | select start delta |
|--------|-----------:|-------:|-------------------:|
| ja     | 268px      | 569px  | 301px              |
| ko     | 275px      | 569px  | 294px              |
| zh     | 272px      | 569px  | 297px              |
| de     | 309px      | 569px  | 260px              |
| ru     | 326px      | 569px  | 244px              |
| fr     | 344px      | 569px  | 225px              |

Both groups packed to the card's right edge. Equal right edges with unequal
widths gives unequal left edges, so the start position was a function of
translated label width.

`flex: 0 0 min(100%, 26rem)` makes the band definite and identical in both
cards, with `justify-content: space-between` packing from the band's left
edge while keeping the trailing switch on the card's right. The vision card no
longer overrides the band width or the copy basis: copy absorbs leftover
width, so a per-card copy basis moved the band's left edge by the difference,
which is why equal band widths alone were not sufficient.

## Rendered verification

At 1920/1600/1440/1200/1024/900/760/600/430 across ko/en/ru/fr/ja/de/tr/zh:
band start delta 0px at every cell, no horizontal or vertical overflow, no
truncated select label, no clipped hint. The streaming label also stops
wrapping to three lines, because the band gives it room to stay on one.

Evidence images in `evidence/`. "Before" is the same build with the shipped
declarations reverted by an injected in-browser override, so the pair differs
only by the fix: 571px of select divergence at ko/1440 and 256px at ko/1024,
both 0px after.

## Regression coverage

`gui/tests/sidecar-layout.test.ts` gains two source-oracle assertions -- the
definite unshrinkable band with no per-card override, and a track floor that
must exceed the stacking threshold plus padding. Both were driven red against
the pre-fix values before being committed.

One trap worth recording: `allRuleBodies` matches a selector everywhere it
appears, including inside `@container` blocks, where the stacked regime
legitimately sets `flex: 0 1 auto`. A row-regime assertion read those
overrides and failed against a correct stylesheet. The new `baseCascade`
helper strips container queries so the base-rule invariants are tested against
the base rules only.
