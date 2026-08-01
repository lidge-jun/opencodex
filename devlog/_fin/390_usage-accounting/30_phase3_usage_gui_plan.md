# Phase 3 — Usage GUI Tab

Phase 2 (commits `095a02f` + `94a29bf`) shipped `/api/usage` and the Logs Tokens column. This phase consumes that endpoint in a dedicated Usage page.

## Surface

### NEW `gui/src/pages/Usage.tsx`

Single page component. Fetches `${apiBase}/api/usage?range=<range>` and renders:

- **Summary cards** (top row): Requests, Reported requests, Total tokens, Coverage, Active days. All cards show numbers from the API; coverage shows `XX%`; active-days counts `days[]` entries where `requests > 0`.
- **Range segmented control**: `All / 30d / 7d` — controlled state on the page, no router needed. Default `30d`.
- **Daily activity heatmap**: GitHub-style 7-row by N-column grid.
  - Rows = days of week (Sun…Sat or per locale weekStart — keep Sun=0 in v1).
  - Columns = ISO week.
  - Cell color from a 5-level scale: 0, low, mid-low, mid-high, high. Buckets are quantile-based on the page's `days[]` (skip zero-request days when computing buckets). All-zero state collapses to the empty color.
  - Cell title attr shows `<date>: <requests> req, <totalTokens> tokens`.
- **Model list**: virtualized? — not needed for v1; render up to top 100 with `overflow-y:auto`. Each row: model name + resolved + provider badge + `requests` + `reportedRequests` + token total + share bar.
- **Provider list**: similar; smaller — typically 1–5 rows.
- **Coverage section**: 3-column row showing `reported / unreported / unsupported` counts, with a one-line caption explaining "Missing usage is never counted as zero".

Page is `apiBase`-only; no other props. Auto-refresh OFF by default (this is not a live log).

### MODIFY `gui/src/App.tsx`

- Add `"usage"` to `Page` type and `VALID_PAGES`.
- Add nav item: `{ id: "usage", tkey: "nav.usage", Icon: IconActivity }` (placed between `logs` and `codex-auth`).
- Add `{page === "usage" && <Usage apiBase={API_BASE} />}` route.

### MODIFY `gui/src/icons.tsx`

- Add `IconActivity` (heartbeat / line-chart glyph).

### MODIFY `gui/src/styles.css`

- `.usage-cards` — 5-col grid of cards.
- `.usage-card` — same look as existing dashboard cards (re-use `.card` class if available).
- `.usage-range` — segmented control.
- `.heatmap` — outer container.
- `.heatmap-grid` — `display: grid; grid-template-rows: repeat(7, 12px); gap: 2px;`.
- `.heatmap-cell` — 12x12, rounded 2px.
- `.heatmap-cell-0` through `.heatmap-cell-4` — color scale (use `var(--green)` family + a 4-step lightness ramp). Empty state uses `var(--border)`.
- `.usage-bar` — horizontal `<div>` bar with width from `shareRatio`.
- All styles must respect existing CSS variables (`--bg`, `--border`, `--text`, `--muted`, `--green`).

### MODIFY i18n bundles (`gui/src/i18n/{en,ko,zh}.ts`)

Add keys:

- `nav.usage`
- `usage.title`, `usage.subtitle`
- `usage.range.all`, `usage.range.7d`, `usage.range.30d`
- `usage.card.requests`, `usage.card.reported`, `usage.card.totalTokens`, `usage.card.coverage`, `usage.card.activeDays`
- `usage.section.heatmap`, `usage.section.models`, `usage.section.providers`, `usage.section.coverage`
- `usage.coverage.note`
- `usage.empty`
- `usage.col.requests`, `usage.col.reported`, `usage.col.tokens`, `usage.col.share`

## Out Of Scope

- Date range custom picker (v1 only has 7d/30d/all).
- Export CSV / JSON download (future Phase 5+).
- Per-day drill-down on heatmap cell click (future).
- Dashboard summary card (Phase 4 of slice map).

## Risks

- Heatmap layout: a long range (`all` after months of use) will overflow horizontally. Mitigation: `overflow-x: auto` on the heatmap container; cells stay 12px wide.
- Color contrast in dark mode: verify the heatmap-cell-0/empty distinction is visible.
- Browser-side typecheck: `bun run build` in `gui/` runs `tsc -b && vite build`. Any GUI typing mismatch with the API shape fails the build.

## Verification

- `cd gui && bun run build` (catches tsc + vite).
- `bun x tsc --noEmit` (root types unaffected; sanity check).
- `bun test tests/usage-summary.test.ts` (no backend changes, but re-run to confirm no regression).
- Atomic commit: `feat(gui): add Usage tab with GitHub-style activity heatmap`.
