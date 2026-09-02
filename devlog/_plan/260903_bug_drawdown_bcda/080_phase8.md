# 080 — Phase 8 (wp8): Issue #3152 — dashboard log panel jitter

## Finding (gpt-5.6-sol investigator, high effort)

VERDICT FIXABLE_NOW, confidence medium, no auth/release risk.

`gui/src/pages/Logs.tsx:521-533` virtualizes dynamically measured rows with a
44px estimate while the multiline cells at `:746-826` are far taller. The table
stays on automatic layout with no fixed column schema
(`gui/src/styles.css:1992-1995`), so every changed mounted-row subset
recalculates intrinsic column widths; model wrapping (`gui/src/styles.css:1985`)
then changes row heights and feeds another virtualizer measurement
(`gui/src/pages/Logs.tsx:741-744`). Native scroll anchoring and the 2 s refresh
(`:458-468`) amplify it rather than cause it.

PR #3250 replaces only the polling at `gui/src/pages/Logs.tsx:429-456` with delta
merging. It touches neither table geometry nor virtualization, so it does not
fix or supersede #3152 — but it will need a small same-file rebase.

## MODIFY / NEW / DELETE map

- MODIFY `gui/src/pages/Logs.tsx` — add a ten-column `<colgroup>` before
  `<thead>`; change `estimateSize` 44 → 92; supply `getItemKey` from
  `requestId` with a timestamp/model/provider fallback so measurements survive
  prepends.
- MODIFY `gui/src/styles.css` — `table.logs-table { table-layout: fixed; }`, ten
  explicit `<col>` widths (12/9/7/8/15/9/13/8/11/8 %), and `overflow-anchor: none`
  plus `scrollbar-gutter: stable` on `.logs-table-wrap`.

## TESTS

- `gui/tests/viewport-scroll-caps.test.ts` — effective `table-layout` is
  `fixed`, all ten width declarations exist and total 100 %, and
  `.logs-table-wrap` carries `overflow-anchor: none` + `scrollbar-gutter: stable`.
  The `table-layout` assertion is red on HEAD.
- `gui/tests/logs-auto-refresh.test.tsx` — the rendered table contains the
  ordered ten-column `<colgroup>`.

## RED-before-fix status of each assertion

- `table-layout: fixed` on `table.logs-table` — RED on HEAD. `gui/src/styles.css`
  currently leaves the table on automatic layout, so the computed value is
  `auto`.
- The ten `<col>` width declarations totalling 100% — RED on HEAD. No
  `<colgroup>` exists in `gui/src/pages/Logs.tsx`, so there is nothing to sum.
- `overflow-anchor: none` and `scrollbar-gutter: stable` on `.logs-table-wrap` —
  RED on HEAD; neither declaration is present.
- The ordered ten-column `<colgroup>` in the rendered table
  (`gui/tests/logs-auto-refresh.test.tsx`) — RED on HEAD for the same reason.

All four are red by absence, which is a legitimate red so long as the assertion
is written and observed failing BEFORE the fix lands, not asserted afterwards.

## Verification (C)

```
bun test gui/tests/viewport-scroll-caps.test.ts
bun test gui/tests/logs-auto-refresh.test.tsx
bun run lint:gui
```

Both focused GUI test files must be run — the `<colgroup>` render assertion lives
in the second one. A `gui`-labelled PR also requires a screenshot in the
description per `enforce-target`.

