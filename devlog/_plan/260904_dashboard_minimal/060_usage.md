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
  for `range !== "7d"`; the 7d `WeekDayBars` stays inline (it is small). `pinRight` is
  scoped inside the `useEffect` (Usage.tsx:390-398); hoist it to a `useCallback` at component
  scope (reads `heatmapRef.current`) so both the effect and `<details onToggle={pinRight}>` call
  it. A closed details has zero width, so the effect's first run is a no-op; onToggle pins after open.
- L815 subtitle: delete the `<p>`; render `<Tooltip content={t("usage.subtitle")} side="top"><IconInfo aria-hidden/><span className="sr-only">{t("usage.subtitleAria")}</span></Tooltip>`
  beside the 커버리지 card label. `Tooltip` (ui.tsx:323-365) already renders its OWN focusable
  `<button>` trigger around `children` and sets no `aria-label` (round-4 blocker 3), so the
  accessible name comes from the visually-hidden span: NEW key `usage.subtitleAria`
  ("How usage is counted" / "사용량 집계 방식") in all nine locales. The existing `.sr-only`
  class is used by AccountPriorityControl.tsx:59. `usage.subtitle` is therefore STILL CONSUMED — not an orphan.

### MODIFY gui/src/styles.css

- `.usage-cards-3x2` → rename/adjust to `.usage-cards-5`; `.usage-heatmap-details > summary`.

### MODIFY gui/src/i18n/*.ts

- `usage.card.activeDays` → orphan (delete in 090). `usage.subtitle` stays (Tooltip content). NEW `usage.subtitleAria` in all nine locales.

### Tests

- MODIFY gui/tests/usage*.test.ts* asserting 6 cards or the subtitle (`rg -n 'activeDays|usage.subtitle' gui/tests`).
- NEW gui/tests/usage-minimal.test.tsx: 5 stat cards; heatmap inside a closed `details` for
  30d; inline bars for 7d; a focusable ⓘ button whose accessible name is `usage.subtitleAria` exists beside 커버리지 and shows `usage.subtitle` on focus.

## Verifiers

`bun test ./gui/tests/usage*.test.ts*`, `cd gui && bun test tests`, build.

## Accept criteria

- ko 1440 #usage: first viewport = filters + 5 cards + cost line + collapsed 일별 활동 + model table head.

## Bypass fields

E2 · CI gates · `--no-verify` · none · "early warning".
