# 060 — WP6: Usage — drop the vanity card, collapse the year heatmap

Depends on: nothing.

## File change map

### MODIFY gui/src/pages/Usage.tsx

- L300: delete the 활동일 `.stat`; `usage-cards-3x2` → `usage-cards-5` (CSS: 5 columns at
  ≥ 1100 px, 3+2 below). `activeDays` prop: remove from `SummaryCards` signature and its caller.
- L302-312 cost row: keep; change `stat-value mono usage-cost-value` → `mono text-control
  usage-cost-value` so the number is not the loudest element in the section.
- L400-415 heatmap section: wrap in
  `<details className="panel usage-heatmap-details"><summary className="panel-title">{t("usage.section.heatmap")}</summary>…</details>`
  for `range !== "7d"`; the 7d `WeekDayBars` stays inline (it is small). The
  `ResizeObserver` pin-right effect must run on open: add `onToggle={() => pinRight()}`.
- L815 subtitle: delete the `<p>`; put the text on the 커버리지 card's `title`.

### MODIFY gui/src/styles.css

- `.usage-cards-3x2` → rename/adjust to `.usage-cards-5`; `.usage-heatmap-details > summary`.

### MODIFY gui/src/i18n/*.ts

- `usage.card.activeDays`, `usage.subtitle` → orphan (delete in 090). No new keys.

### Tests

- MODIFY gui/tests/usage*.test.ts* asserting 6 cards or the subtitle (`rg -n 'activeDays|usage.subtitle' gui/tests`).
- NEW gui/tests/usage-minimal.test.tsx: 5 stat cards; heatmap inside a closed `details` for
  30d; inline bars for 7d; coverage card has a `title`.

## Verifiers

`bun test ./gui/tests/usage*.test.ts*`, `cd gui && bun test tests`, build.

## Accept criteria

- ko 1440 #usage: first viewport = filters + 5 cards + cost line + collapsed 일별 활동 + model table head.

## Bypass fields

E2 · CI gates · `--no-verify` · none · "early warning".
