# 050 — opencodex.me/dashboard

Stack layer 6. Reads `GET https://telemetry.opencodex.me/v1/stats` (`TelemetryStatsV1`, 030) from the browser and links the telemetry guide from 040.

## Page

`docs-site/src/content/docs/dashboard.mdx` with `template: splash`, mounting
`<TelemetryDashboard />`. A content page (not `src/pages/`) gets Starlight's locale fallback routes,
so the header's language links (`/ko/dashboard/` ...) resolve and `internal-links.mjs` and
`tests/ci-workflows/docs-link-targets.test.ts` pass unchanged.

## Sections (adapted from tokscale, MIT, credited in the footer)

1. Header: title, range pills (7d / 30d / 90d / 365d), last-updated time, privacy callout linking the
   telemetry guide and the opt-out variables.
2. KPI strip (tokscale `ProfileOverview`): active installs, requests, tokens, active hours —
   `tabular-nums`, compact K/M/B with exact values in `title`.
3. Token mix bar (tokscale `TokenBreakdown`): input / cache read / cache write / output / reasoning — disjoint buckets from the payload contract, so the segments sum to the total.
4. Activity: a 52-week heatmap of daily active installs from the always-365-day `heatmap` series (tokscale `ProfileContributionGraph`, 5 grades)
   and an ECharts stacked daily chart from `dailyByProvider` (tokens or requests by provider kind). ECharts is already a
   docs-site dependency (`FrontierBoards.astro`) and re-themes on `data-theme` changes.
5. Provider-kind and model-family share tables (tokscale `ProfileModels` colour dots).
6. Platform, version and install-channel distribution, new installs per version/channel; reliability (outcome ratio and top error codes).
7. Downloads: npm weekly/total downloads (`api.npmjs.org/downloads`) and GitHub release asset download
   counts (`api.github.com/repos/<owner>/<repo>/releases`), fetched client-side with graceful fallback.

Loading, empty ("collector not deployed yet") and error states are explicit; no layout jumps.

## Files

`docs-site/src/components/TelemetryDashboard.astro` (shell + client script),
`docs-site/src/components/telemetry-dashboard/*.ts` (pure formatting / series helpers testable from
`tests/`), `docs-site/src/data/telemetry-dashboard-i18n.ts` (copy for the 8 site locales), and the localized `/dashboard/` link in both the desktop nav and the splash
mobile menu of `docs-site/src/components/Header.astro`, plus a link from `guides/telemetry.md`.

## Verification

- `tests/ci-workflows/docs-telemetry-dashboard.test.ts`: the route exists, helpers format and bucket a
  fixture stats response correctly, empty/error states render, no hard-coded secrets.
- `cd docs-site && bun install --frozen-lockfile && bun run build`.
- Browser check of the built page against a fixture stats JSON (screenshot for the PR).


