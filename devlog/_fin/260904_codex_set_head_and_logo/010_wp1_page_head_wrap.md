# 010 — Codex Set page head must not clip its actions at a narrow viewport

## Observed defect

Reported from the running dashboard at `http://localhost:10100/#codex-set` in an
850px-wide viewport. Measured against `dev` at 2421e44ce with the live proxy
(v2.43.0, pid 32347):

```
.main-inner                left 232  right 840
.codex-auth-page-head      left 268  right 804   width 536
…__actions                 left 367  right 804   width 437  scrollWidth 577
  spark toggle             left 616  right 652
  "Pause exhausted"        left 662  right 803
  "Refresh quotas"         left 813  right 944   <- past the container's 804
```

The actions cluster wants 577px and is given 437px. Nothing wraps and nothing
scrolls, so the last control renders 140px outside its own box and is visually
sliced by the viewport edge. `document.scrollWidth` still equals `innerWidth`,
so no horizontal scrollbar appears to rescue it — `html` and `body` both carry
`overflow-x: hidden` (`styles.css:161`, `styles.css:165`), which converts the
overflow into a clip instead of extending the page.

## Why it happens

`.page-head` is `display:flex; justify-content:space-between` with an `h2` title
and the actions row as its two children. `.codex-auth-page-head__actions` is
itself `display:flex` with `min-width:0` and no `flex-wrap`. Its children resist
shrinking: the spark toggle by declaration
(`.codex-auth-spark-toggle { white-space: nowrap }`) and the two buttons via
`.btn { white-space: nowrap }` plus their icon+label content. (The feedback span
is the exception — in the `is-warn` tone it sets `white-space: normal`. It is not
what overflows here.) A nowrap flex line whose items cannot shrink below their
content width overflows the line box rather than wrapping. `min-width:0` lets the
*container* shrink, which is exactly what turns a would-be overflow into a clip.

The title compounds it: "Codex Auth" wraps to two lines at this width and holds
its own column, so the actions column loses width precisely when it needs more.

## Fix

Let the head and its action cluster wrap. Wrapping is the whole fix — nothing
else is required at 850px.

- `.codex-auth-page-head` gains `flex-wrap: wrap`, so the actions row can drop
  below the title instead of competing with it for a single line.
- `.codex-auth-page-head__actions` gains `flex-wrap: wrap` and
  `justify-content: flex-end`, so a cluster that still does not fit on one line
  breaks onto a second one, right-aligned like the wide layout.
- `row-gap: 8px` on the head keeps a wrapped actions row off the title.
- `.codex-auth-page-head > .page-title { flex: 1 1 auto }`: once the cluster owns
  its own row the title has the full width available, so "Codex Auth" stops
  wrapping onto two lines at this size.

Why that suffices: the actions' 577px hypothetical main size plus the title plus
the 16px gap exceeds the 536px line, so the cluster drops to its own 536px row;
it then breaks internally because no single item exceeds 536px (the widest is the
feedback span at `max-width: 18rem` = 288px).

The feedback span's `min-width: 8rem` is deliberately left alone. It is a
*horizontal* reservation — dropping it to 0 would let the first feedback string
shove both buttons sideways, trading a clip for a jump — and it is not load
bearing for the overflow now that both axes wrap. It is also rendered outside the
`embedded` ternary in `codex-account-pool-main-card.tsx`, so any rule on that
class would reach the Providers workspace variant too. Both reasons point the
same way: leave it.

Wide-viewport rendering is unchanged: wrapping only takes effect when the line
actually overflows, and the container was already `display:flex` with the same
gap and alignment. Measured at 1440px after the change, title and actions still
share one 26px-tall row.

## Out of scope

The `embedded` variant (Providers workspace) renders a plain `.row` with an
inline `justifyContent: flex-end`, not `.codex-auth-page-head`. It is untouched
and must stay untouched.

## Verification

Re-measure the same rects at 850px and assert every button's `right` is inside
`.main-inner`'s `right`, plus an after-screenshot at the same viewport, and a
second measurement at 700px (inside the 760px mobile breakpoint) and 1440px to
cover both sides of it. No repository-wide suite (operator constraint);
`bun run typecheck`, `bun run lint:gui` and `bun run build:gui` are the
mechanical gates.
