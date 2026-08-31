# 030 — Dynamic viewport units in scroll surfaces (wp3)

> **Shipped in #2906** (`4d646c494`), separately from the sidecar alignment fix in
> #2905 that the rest of this unit records. It is a different change to a
> different file (`gui/src/styles.css`), kept in the same unit because one audit
> pass found both.
>
> Rules below are named by selector, not line number: the fix this document
> describes inserted lines above the very rules it cites, so most of its original
> citations stopped describing what they pointed at — `styles.css:2003` is now
> `min-width: 220px` and `:1222` is a `z-index`. `:755` still lands on
> `.action-toast`'s `max-width` by coincidence, which is why the selector is the
> reference and the line is only a hint.

## Defect

`.logs-table-wrap` in `gui/src/styles.css` — **as it was before the fix**; the
rule now sits at line 2011 and carries `100dvh`:

```css
.logs-table-wrap { max-height: calc(100vh - 260px); }
```

`vh` is the *large* viewport: it ignores mobile browser chrome, so the log table
is capped for a viewport taller than the one the user can see, pushing the last
rows under the browser UI. The rest of the shell already moved to `100dvh` —
`.app` (244), the sidebar (247), `.main-inner--combos` (411-412) and the mobile
drawer (2213) — so this line is an outlier, not a convention.

`.action-toast` (749) and `.toast-notice` (1229) cap toast width with
`calc(100vw - Npx)`. Per CSS Values and Units 4, `100vw` includes the classic
scrollbar gutter, so a scrollbar-reserving platform can in principle render a cap
wider than the visible area. (`.notice` at 1215 is a different rule: it caps with
`var(--prose-measure)`, which is what makes it win the cascade below — it does not
use a viewport unit at all.)

A separate, *reproduced* toast defect turned up while measuring that one: the
cap on `.action-toast` never applied at all. Every toast also carries `.notice`,
and `.notice { max-width: var(--prose-measure) }` is declared later in the same
file at equal specificity, so source order won and the toast resolved to 70ch
(542px) instead of its design width.

## Change

- `.logs-table-wrap` → `max-height: calc(100dvh - 260px)`.
- Add `.action-toast.notice { max-width: min(480px, calc(100vw - 48px)) }` — two
  classes so it beats the later `.notice` rule. Both halves of the cap are
  restated: dropping the viewport term let the toast reach the screen edge at
  430px (measured `left = 0`, losing the 24px inset the right side keeps).
- `.logs-table-wrap` was the only static `vh` in a scroll surface; the `12vh`
  padding on the toast wrapper is decorative offset, not a size cap, and stays.

### Not changed: the `vw` → containing-block rewrite

The scrollbar-divergence rewrite was reverted before commit because it could not
be reproduced on this surface: the probe measured `innerWidth == clientWidth`
(gap 0), so `100vw` and the containing block agree here and the change would have
been an unmeasured edit to a live width cap. The units stay `vw`; the toast is
fixed by the specificity rule above, which *was* reproduced.

## Verification

Behavioural, not textual: the probe compares each scroll container's computed
`max-height` against `visualViewport.height` and counts any cap that exceeds it
(`staticVh`). The gate fails on a non-zero count, so the assertion survives a
selector rename. Measured at a mobile profile where the visual viewport is
smaller than the large viewport. The toast cap was verified by reading its
computed `max-width` and rendered rect at 1440 and 430.

## Acceptance

- `staticVh = 0` at every swept cell, including the 430-wide mobile profile.
- No `calc(100vh` remaining in a scroll-surface cap.
- Toast computed `max-width` is 480px at 1440 (not 542px) and keeps its 24px
  inset at 430px.
