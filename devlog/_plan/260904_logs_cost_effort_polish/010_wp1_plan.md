# 010 — WP1: plain-dollar cost, effort-only cell, overlap guard

One work-phase, one PABCD cycle. Diff-level plan.

## gui/src/pages/logs-cost-format.ts

```ts
const USD = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 4, maximumFractionDigits: 4,
});
export function formatEstimatedUsdValue(value, t, _localeTag?, priorityLowerBound = false) {
  if (!Number.isFinite(value) || value < 0) return t("logs.cost.unavailable");
  const amount = USD.format(value);           // "$0.1401" in every locale
  return t(priorityLowerBound ? "logs.cost.lowerBound" : "logs.cost.approximate", { amount });
}
```

`localeTag` stays in the signature so callers do not change; it is no longer used for the
amount. A doc comment records why (header is `~$`, CLI prints `~$`).

## gui/src/intl-formatters.ts

`formatEstimatedUsdValue(value, locale)` → same fixed en-US narrowSymbol formatter, keeps the
`~` prefix because the Usage page has no `~$` header. Locale parameter retained, unused.

## gui/src/i18n/*.ts (9 locales)

- `logs.cost.approximate`: `"{amount}"` in every locale (drop `~`, `약`, `約`, `约`, `ca.`,
  `env.`, `около`, `yaklaşık`). The `~` lives in the column header.
- `logs.cost.lowerBound`: `"≥{amount}"` in every locale.

## gui/src/pages/Logs.tsx

Table cell (≈L821–826): remove the caption span, keep `title={reasoningWire}`:

```tsx
<td className="mono log-reasoning-cell" title={reasoningWire}>{effortLabel(log)}</td>
```

Detail dialog and attempt rows unchanged (they still show `high (reasoning_effort=high)`).
If the effort cell was the only user of `.logs-stack-start`, delete that CSS rule too.

## gui/src/styles.css

```css
/* table-layout: fixed does not clip; without this a cell wider than its <col> paints over
   the neighbour (seen: "약 US$0.1401" under the model column, "reasoning_effort=high" under
   the provider column). */
.logs-table tbody td { overflow: hidden; }
.log-reasoning-cell { overflow-wrap: anywhere; }
```

`.log-col-cost` keeps `nowrap`: `$0.1401` is 7 ch and the column is 8 % ≥ 88 px.

## Tests

- Update `gui/tests/logs-priority-lower-bound.test.ts` and
  `gui/tests/logs-cost-lower-bound.test.ts`: en `"$1.6000"` / `"≥$1.6000"`, de `"$1.6000"`
  (fixed dollar, no locale prose), unavailable unchanged.
- New `gui/tests/logs-cost-plain-dollar.test.ts`: for every locale in `DICTS`, the rendered
  string matches `/^\$\d+\.\d{4}$/` (approximate) and `/^≥\$\d+\.\d{4}$/` (lower bound);
  no locale template contains `US`.
- New `gui/tests/logs-effort-cell.test.ts`: source oracle on `Logs.tsx` — the table-row effort
  cell has no caption span; the detail dialog still interpolates `reasoningWire`.
- New `gui/tests/logs-table-overflow.test.ts`: CSS source oracle — last effective
  `.logs-table tbody td` declaration has `overflow: hidden` and `.log-reasoning-cell` has
  `overflow-wrap: anywhere`.

## Verification (C)

`bun run typecheck`, `bun run lint:gui`, `bun test gui/tests/logs-*.test.ts gui/tests/intl-formatters.test.ts`,
`cd gui && bun run build`. Render: serve the built `gui/dist` through an isolated proxy on a
scratch port with a scratch `OPENCODEX_HOME` (port 10100 untouched), open `#logs` in ko,
screenshot + DOM geometry (computed `overflow: hidden` on body cells, and every text/child client rect stays inside its own cell rect — `scrollWidth` is not an oracle under hidden overflow). Screenshot saved under
`assets/` for the PR body.

## Delivery (D)

Branch `codex/260904-logs-cost-effort-polish`, commit/push `--no-verify`, PR to `dev` with the
template + screenshot, `gh pr merge --squash --admin`, ancestry proof.

## A-phase audit synthesis (gpt-5.6-sol reviewer, verdict FAIL → near-pass after fold)

1. `logs-auto-refresh.test.tsx:472` pinned the caption in the overview cell → FOLDED: asserts
   caption absent from textContent, present on `title`, still in attempt rows.
2. `locale-parity.test.ts` zh-TW placeholder guard rejects `{amount}` == English → FOLDED:
   both keys allowlisted with a comment.
3. `overflow: hidden` on every td could clip the status button (zh-TW 檢視詳細資料 > 64 px) and
   its focus ring → FOLDED: `.log-detail-btn` now `white-space: normal` and an inset
   `focus-visible` outline; the clip stays on all body cells because the cost and effort
   cells are not the only ones that can outgrow a fixed column (request id, provider).
4. `scrollWidth <= clientWidth` is not a valid overlap oracle under hidden overflow → FOLDED:
   the browser check measures painted descendant bounds (`getClientRects` of every child
   element) against the cell's own rect, and reads computed `overflow`.
5. Full local suite before PR-ready → REBUTTED: the user forbade the repository-wide local
   suite for this task; hosted CI on the exact head is the broad gate, recorded at merge.
   `.logs-stack-start` is still used by the timestamp cell (L763) → the CSS rule stays.

Accepted residual: the Logs formatter change also reaches conversation totals and detail /
attempt cost values (same `$` shape everywhere), and Usage's total keeps its `~` prefix.
