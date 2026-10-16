# Audit and verification record

## Independent review (explorer reviewer, A gate)

Verdict NEAR-PASS. The reviewer read the four touched files, ran the focused suite and
typecheck, and measured the rendered panel in headless Chrome rather than trusting the CSS
comments. It cleared the behavioral half: `rangeOpen` feeds only `aria-expanded`, the
`is-active` class and the conditional render, and `loadUsage`, `resourceKey`, `presetKey`,
the held-cache gating and the `UsageWindowMismatchError` receipt check are untouched, so
request identity and caching cannot have moved. Every `var()` in the new block resolves, no
other `.usage-range*` selector exists in `gui/src`, and `usage.range.custom` is already in all
ten catalogs, so promoting it from `aria-label` to visible text adds no key.

Findings folded in:

1. **BLOCKING — measured spacing defect.** `repeat(2, minmax(0, 200px))` capped each date
   track at 200px, but `.input` carries `min-width: auto` and a `datetime-local` control's
   intrinsic minimum is ~206px in Chrome at this font size. Measured `input w=206.0` in a
   200px track, leaving a 2px visible gap where the grid declares 8px — and worse for locales
   whose date format is longer than `mm/dd/yyyy`. That is the exact rhythm defect this change
   exists to repair. Fixed by sizing every track to its content: `repeat(4, auto)` with
   `justify-content: start`.
2. **MINOR — dangling IDREF.** `aria-controls` named a panel that is unmounted while closed.
   Now emitted only while open.
3. **MINOR — hidden validation state.** `rangeError` survived a collapse, so a submitted
   invalid range left an alert behind an unmarked trigger. Closing now retires the error while
   keeping the draft; covered by a new regression test.
4. **MINOR — vacuous-assertion risk.** The `interval()` helper was class-coupled; it is now
   scoped to `.usage-range-bar [role="status"]`.
5. **MINOR, accepted.** Disclosure state across a preset click stays open and is left unpinned.

## Verification status

| Check | Result |
|---|---|
| `bun run typecheck` | pass (before the no-local-suite instruction) |
| `cd gui && bun test tests` | 1937 pass / 0 fail (before the instruction; 26 in the usage suite after the review fixes) |
| `cd gui && bun run lint` | pass |
| `cd gui && bun run build` | pass |
| `bun run test` (repository-wide) | **NOT RUN** — killed on the maintainer's explicit instruction |
| Rendered browser check | Collapsed, open, applied-then-collapsed, validation error, dark theme and 430px width, against a live proxy |

Screenshots in `assets/`: `010_before.png` is the shipped 2.49.0 layout, `020_after_collapsed.png`
and `030_after_open.png` are this change. Remote exact-head CI is the full-suite authority.
