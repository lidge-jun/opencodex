# 013 — Final: what shipped and what the measurement taught

Supersedes the mechanism proposed in `010`/`011`/`012`. Those documents are kept
because the failed attempts are why the shipped fix is exactly these two
declarations and not a third.

## Shipped

```css
.dash-sidecar-row-card { align-content: start; }
.dash-sidecar-row-card .dash-sidecar-copy .setting-hint { min-height: 3lh; }
```

The second replaces `min-height: 3.9375rem` on the copy block.

**Both are load-bearing, and each was confirmed by removing it from the shipped
stylesheet and re-measuring the rendered page.** They fix two independent halves
of the same symptom, which is why neither alone is enough:

| shipped CSS under test | worst paired offset | what breaks |
|------------------------|--------------------|-------------|
| both declarations | **0.0px** | nothing |
| `3lh` only (`align-content` back to its `stretch` default) | **27.8px** | equal copy rows, but each card spreads its own leftover space across its own wrapped lines |
| `align-content: start` only (old `3.9375rem` band restored) | **19.5px** | lines pack from the top, but the two copy rows are unequal at ru/fr (63px vs 82.5px) |

`align-content: start` fixes the *distribution* of the wrapped flex lines;
`3lh` fixes the *height of the copy row* those lines pack against. Removing
either one re-opens the defect, so a future maintainer must treat both as part
of the fix.

## The defect, stated exactly

The pair's control rows sat **19.5px** apart — one line box — at every two-up width
from 1600 down to 740, in **ru** and **fr** only. Six other locales measured 0px.

The old band was 63px, documented as "21px title + 3px hint margin + two 19.5px
hint lines". It encodes a two-line assumption. The ru/fr vision hint wraps to
**three** lines at a two-up card (82.5px of copy against 63px), so the band stopped
describing the taller card and each card's control line followed its own copy.

`3lh` states the real constraint — reserve three line boxes of the hint's own
line-height — so the shorter hint reserves the same three lines, and a font or
line-height change cannot invalidate the number.

| locale | hint lines (web search / vision) | before | after |
|--------|----------------------------------|--------|-------|
| en | 2 / 2 | 0px | 0px |
| ko | 1 / 2 | 0px | 0px |
| ja | 2 / 2 | 0px | 0px |
| zh | 1 / 1 | 0px | 0px |
| de | 2 / 2 | 0px | 0px |
| tr | 2 / 2 | 0px | 0px |
| **ru** | **2 / 3** | **19.5px** | **0px** |
| **fr** | **2 / 3** | **19.5px** | **0px** |

## Why not subgrid

Shared row tracks are the textbook fix and the independent auditor recommended
them. They are unavailable here, and the evidence is unambiguous:

| attempt | measured result |
|---------|-----------------|
| card as subgrid, `container-type` on the card | never applied; computed `display` stayed `flex` |
| `container-type` moved to `.dash-sidecar-grid` | card's computed `grid-template-rows` = `none`; tracks 19px; cards 54px tall; controls overflowing 43-80px |
| `container-type` on `.dash-overview-stack` | same collapse |
| `auto` / `min-content` / `max-content` rows | no effect — the rejection is of `subgrid`, not the sizing |
| isolated clone, no container ancestor | worked, delta 0 — which is what identified containment as the cause |

Chrome rejects a child's `grid-template-rows: subgrid` when an ancestor
establishes layout containment via `container-type`. This surface has two such
containers (`.dash-sidecar-grid` and the per-card `sidecar-card` that the existing
narrow-card queries depend on), so there is no placement that does not block it.

## Two measurement failures worth keeping

Both produced confident, wrong "all clear" results. The harness now defends
against each.

**1. A symmetric break passes a relative gate.** The subgrid collapse reported
`ctrlYDelta = 0.0px` while cards rendered 54px instead of 215px, because both
cards were broken identically. Alignment deltas cannot see that. The gate now also
asserts absolute card height, child-vs-panel overflow, and hint truncation.

**2. A leftover probe stylesheet fakes a pass.** An earlier round reported "ALL
OK" for `align-content: start` across 30 cells. The number was real; the page was
not the shipped page — an injected experiment sheet from a previous probe was still
attached. The harness now strips every probe sheet before measuring, counts what
remains, and **fails** if the count is not what the run expects.

The second one is why `align-content: start` was briefly believed to be the
*whole* fix. Re-measured on a clean page it leaves the full 19.5px at ru/fr,
because packing lines from the top does nothing about copy rows that are unequal
to begin with. That is a correction of its sufficiency, not of its necessity — it
ships, and the removal test above shows the pair drifts 27.8px without it.

## Deferred, per the audit

- `020` **withdrawn.** The `0px` third track is normal `auto-fit` behaviour for a
  collapsed empty track, not a defect. Replacing `auto-fit` with a fixed two-up
  would change future three-card behaviour for no present gain.
- `030` **reduced.** `dvw` does not subtract a classic scrollbar, so a unit swap
  would not have fixed the toast, and the containing-block rewrite was dropped as
  unreproducible on this surface (`innerWidth == clientWidth`, gap 0). Shipped
  instead: `.logs-table-wrap`'s `vh` → `dvh`, and a toast `max-width` that was
  losing the cascade to a later equal-specificity `.notice` rule.

## Evidence

- Harness: `.tmp/uiux/measure.ts` (scratch, not committed)
- Screenshots with control-row guides: before `-19.5px` / after `0px` at ru and fr, 1024
- Regression: `gui/tests/sidecar-layout.test.ts`, red on the previous CSS (2 fail), green on this one (8 pass)
