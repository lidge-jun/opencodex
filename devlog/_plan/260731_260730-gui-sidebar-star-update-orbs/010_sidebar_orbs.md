# 010 — WP1: sidebar star + always-visible update orb

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## MODIFY / NEW / DELETE map

### NEW `src/github/star-state.ts`

`gh`-backed star probe with a 10-minute cache. Three states, because starring runs
through the user's own `gh` login and opencodex holds no GitHub token:
`starred` / `not-starred` / `unauthenticated`.

- `probeStarState()` — `gh auth status`, then `gh api /user/starred/<repo>` (204 vs 404).
- `getStarStatus()` — cached read; only spawns `gh` on a cold/expired cache.
- `starRepository()` — `gh api -X PUT /user/starred/<repo>`; writes the resulting
  state into the cache so the click path never waits out the TTL.
- Injectable `StarDeps { runGh, nowMs }` so tests never spawn a process.

### NEW `src/update/badge.ts`

`readUpdateBadge()` reads the existing 20h `version.json` cache
(`src/update/notify.ts` `readVersionCache`) and calls
`triggerBackgroundRefreshIfStale` — no `npm view` on the request path, unlike
`/api/update/check`. Source checkouts and `0.0.0`/`?` report `updateAvailable:false`
with `canUpdate:false`.

### NEW `src/server/management/sidebar-routes.ts`

- `GET /api/github/star` → `getStarStatus()`
- `POST /api/github/star` → `starRepository()`
- `GET /api/update/badge` → `readUpdateBadge()`

Scalar-only payloads (state enum, repo slug, version strings). Rides the existing
management auth + origin gate; no auth of its own.

### MODIFY `src/server/management-api.ts`

Register `handleSidebarRoutes` at the end of the dispatch chain.

### NEW `gui/src/components/sidebar-github-row.tsx`

Row = GitHub link (flex:1) + `.sidebar-github-actions` holding two 28px orbs.

- Star orb: filled/amber and non-interactive when starred; click stars when
  `not-starred`; opens the repo page when `unauthenticated` or when the POST fails.
- Update orb: **always rendered**. `updateAvailable` → accent (blue) class plus a
  badge dot; otherwise the plain orb. Click always navigates to the dashboard
  update deep link, which runs a fresh check and shows install/cancel.
- Polls: star 5min, badge 10min via `useKeyedClientResource`.

### MODIFY `gui/src/icons.tsx`

Add `IconDownload` (no download glyph existed; `IconArrowDown` reads as sort order).

### MODIFY `gui/src/App.tsx`

Replace the bare GitHub `<a>` in `.sidebar-foot` with `<SidebarGithubRow>`; drop the
now-unused `IconGithub` import. `onOpenUpdate` closes the mobile drawer and calls
`navigateToPage("dashboard", "update")`.

### MODIFY `gui/src/app-routing.ts`, `gui/src/use-app-route-state.ts`

Accept `#dashboard/update` as a valid dashboard hash (`DASHBOARD_UPDATE_HASH`) so
route normalization does not strip it, and let `navigateToPage(page, subPath)` push
a sub-path.

### MODIFY `gui/src/pages/dashboard-shared.ts`, `gui/src/pages/use-dashboard-data.ts`

`hashRequestsUpdateDialog()` detects the deep link; the dashboard consumes it from the
`hashchange` listener (an external event, not a render effect — the repo's eslint
config bans `set-state-in-effect` and ref writes during render), normalizes the hash
back to `#dashboard`, then opens the existing dialog.

### MODIFY `gui/src/styles.css`

`.sidebar-github-row`, `.sidebar-github-actions`, `.sidebar-orb`,
`.sidebar-orb--starred`, `.sidebar-orb--update`, `.sidebar-orb-dot`. Existing tokens
only (`--raised`, `--border`, `--accent-ring`, `--amber`, `--green`, `--radius-pill`).

### MODIFY `gui/src/i18n/{en,ko,ja,de,zh,ru}.ts`

`sidebar.star`, `sidebar.starred`, `sidebar.starUnauthenticated`,
`sidebar.starFailed`, `sidebar.updateAvailable`, `sidebar.checkUpdate`.

## TESTS

`tests/sidebar-star-state.test.ts`

- unauthenticated `gh` → `unauthenticated`, and no star API call is attempted
- authenticated + 204 → `starred`; + non-zero → `not-starred`
- `getStarStatus` serves the cache inside the TTL (one probe for two reads)
- `starRepository` success flips the cached state to `starred` without a re-probe

`tests/update-badge.test.ts`

- source checkout → `updateAvailable:false`, `canUpdate:false`
- newer cached version on the channel → `updateAvailable:true`
- same/older cached version → `false`
- missing cache → `false` and a background refresh is triggered

## Verification (C)

```
bun run typecheck                                  # exit 0
bun test tests/sidebar-star-state.test.ts tests/update-badge.test.ts   # 0 fail
cd gui && bun run lint && bun run lint:i18n && bun run build           # exit 0
```
