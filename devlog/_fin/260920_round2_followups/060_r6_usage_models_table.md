# R6 — the Usage models table

Status: OPEN until the pull request lands on `dev`.

Four defects a user hit on the dashboard Usage tab, all in the models table. Three are layout; the
first is a reading the table gets wrong.

## The hit rate was withheld from every provider that reports partial cache detail

On the reporter's dashboard `gpt-5.6-sol` shows 2.8B cache hits and a hit rate of `—`.
`gpt-6-astra`, `k3[1m]`, `gemini-3.8-flash`, `gpt-5.6-luna` and `grok-4.6` show the same thing. The
reporter read it as the zero in the cache-writes column suppressing the rate.

It is not the writes column. The summary is right and the dashboard was throwing its answer away.

`calculateCacheHitRate` in `src/usage/summary.ts` averages cache reads over
`cacheObservedInputTokens` — the input tokens whose cache detail was actually reported — and
returns `null` when nothing was observed. That denominator is the #4546 contract recorded in
`structure/gui-and-management-api.md`: a synthesized zero and an unreported detail must not be
averaged as cache misses, or a pool that discarded every warm prefix reports a plausible hit rate.
A provider that reports reads and never reports writes is observed, and it has a rate.

The dashboard then required that denominator to cover the row's **entire** input before it would
show the number:

```tsx
model.cacheObservedInputTokens >= model.inputTokens ? model.cacheHitRate : null
```

One request in the row with no cache detail — a locally answered turn, an unreported usage record,
a row written by an older proxy — puts the denominator below `inputTokens` and blanks the column.
For a busy model that is every row, which is why six models with billions of measured hits all read
`—`. The gate arrived with the cache columns in #5268 and was never the server's rule.

The fix drops the gate. The cell renders whatever the summary supplied, because the summary already
refused to supply a number it could not justify, and the coverage becomes a tooltip instead of a
reason to hide the value: `usage.cacheHitRate.partial` names the measured and total input tokens on
a partially observed row, `usage.cacheHitRate.unmeasured` explains the em dash on a row where
nothing reported cache detail. That row — no basis at all — is now the only one that shows `—`.

The coverage sentence is carried twice: a `title` for a pointer, and an `sr-only` span so it is not
mouse-only. A `td` is not focusable and a `title` never reaches a keyboard or a touch screen, and a
cell whose whole point is to explain a number should not explain it to one input device.

No server change. The denominator, the provenance split and the `null` are all correct as they
stand, and the structure doc that owns the contract stays accurate.

## Column order

`Model, Provider, Share, Tokens, API list-price`, then the per-request detail:
`Requests, Measured, Input tokens, Output tokens, Cache hits, Cache writes, Hit rate`. Identity
first, then the three figures a reader compares models on, then the evidence behind them. The
previous order buried share and price behind five cache columns.

## Sideways scroll and pinned identity columns

`.tbl` is `width: 100%`, so twelve columns divided the shell between them until eight-digit token
totals folded onto a second line. The models table is now `width: max-content; min-width: 100%` and
the shell scrolls sideways — `.tbl-wrap` was already `overflow-x: auto`, so nothing else had to
move. Model and provider are `position: sticky` at fixed widths so a row stays identifiable while
its numbers scroll; both offsets are one `var(--space-3)` step negative, the same trick the sticky
header plays with `top`, so a stuck cell repaints the scrollport padding it slides over. Under
720px the pinning stands down, because at that width two pinned columns cost more reading room than
scrolling the whole table does.

Every selector is doubled as `.tbl.usage-models-tbl`. This file is `@import`ed from the top of
`styles.css`, so the whole of `styles.css` cascades after it, and a single class ties
`.tbl { width: 100% }` on specificity and loses on source order — the sizing contract reads as
applied and does nothing. The rules that already lived in this file buy the same margin with a
`.usw-section` prefix. The source-oracle case asserts the doubled form, because the single-class
version is the failure that looks correct.

## The exclusion caption

`(56 requests excluded)` shared a line with the amount and folded mid-phrase. It is a block now, so
the amount is the first line and the caption is the second.

## Verification

GUI change, so the screenshot gate applies and this lane cannot satisfy it: builds are not
permitted here, so no dashboard was rendered to photograph. The evidence offered instead is the
column order and cell layout written out above, the regression assertions below, and hosted CI.

- `gui/tests/usage-custom-range.test.tsx` — the partially observed row now asserts `90%` where it
  asserted `—`, with both tooltips, and the header sequence asserts the new order.
- `gui/tests/usage-layout.test.ts` — new source-oracle case binding the scroll, the pinned columns
  and the block caption, so removing the stylesheet rules fails rather than degrading silently.
- Adversarial static review by a second agent, since nothing here may be executed: it reproduced
  the cascade defect above independently and hand-evaluated the rendered cell arrays for all three
  fixture rows against the new JSX.
- NOT RUN: `bun run test`, `bun test` on any single file, `bun run typecheck`, `bun run lint:gui`,
  `bun run build:gui`, `bun install`, and any `ocx` execution. Hosted CI at the exact head is the
  only execution evidence for this lane; GUI lint, typecheck and `gui` tests all run in the
  `gates` job of `Cross-platform CI`, which a branch push does not trigger and the pull request
  does.
