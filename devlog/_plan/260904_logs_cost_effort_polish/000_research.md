# 000 — Logs page cost / effort / overlap: research

Live symptoms observed on http://localhost:10100/#logs (v2.42.0, ko locale, 2026-09-04):

1. Cost cells render as `약 US$0.1401`. `Intl.NumberFormat(ko, {currency: "USD"})` emits the
   `US$` code prefix, and the ko template `logs.cost.approximate = "약 {amount}"` prepends prose.
   The column header already reads `~$`, so both the prose and the currency code are noise.
   Same class of noise in ja (`約`), zh (`约 US$`), zh-TW (`約 US$`), de (`ca.`), fr (`env. $US`),
   ru (`около`), tr (`yaklaşık`).
2. The effort cell renders two lines: `high` and a caption `reasoning_effort=high`
   (`reasoningWireLabel`). The caption is also in the cell `title`. In the table it is redundant
   and, in the mono font, wider than the 9 % column.
3. Overlap. Measured with `table-layout: fixed` at 1100 px:
   - cost cell width 88 px, content scrollWidth 102 px → paints over the model column
     (screenshot shows `0.1401claude-fable-5-1`).
   - effort cell width 99 px, caption span 139 px → paints over the provider column
     (`reasoning_effort=high` sits under `Kimi`).
   Neither `td` has `overflow` set, and both cost (`white-space: nowrap`) and the caption
   cannot wrap, so fixed layout lets them bleed.

Code pointers:

- `gui/src/pages/logs-cost-format.ts` — `formatEstimatedUsdValue` builds the amount with
  `Intl.NumberFormat(localeTag, {style: "currency", currency: "USD"})` and wraps it in
  `logs.cost.approximate` / `logs.cost.lowerBound`.
- `gui/src/intl-formatters.ts` — `formatEstimatedUsdValue` used by Usage totals; same
  `US$` issue in ko/zh/zh-TW.
- `gui/src/pages/Logs.tsx` ~L821 — the table cell renders `effortLabel(log)` plus the wire
  caption span. Detail dialog (~L967) and attempt rows (~L1092) show the wire label inline in
  parentheses; those stay.
- `gui/src/styles.css` L1985–2006 — column widths; L2010 `.log-col-cost { nowrap }`.
- Tests: `gui/tests/logs-priority-lower-bound.test.ts`, `gui/tests/logs-cost-lower-bound.test.ts`
  pin the current `~$` / `ca. 1,6000 $` strings and must be updated.

Decision: render the amount as a fixed `$` + en-US number in every locale. Rationale: the header
is the untranslated `~$`, the CLI usage report prints `~$12.3456`, and a per-locale
`0,1401 $` under a `~$` header is inconsistent. The lower-bound marker stays as `≥`.
