# 040 — Delivery record

Terminal outcome: **DONE**. Verified against `origin/dev` head `38b0c09b6`, not
from memory of the work.

## What shipped

| PR | Merge commit | Content |
|----|--------------|---------|
| [#3466](https://github.com/lidge-jun/opencodex/pull/3466) | `1e3589531` | Brand home control, overview refresh-all-quotas, Accounts section-head refresh, i18n, docs, 4 test files |
| [#3472](https://github.com/lidge-jun/opencodex/pull/3472) | `b08e14e91` | zh-cn and ru locale rows for the refresh-all control |
| [#3473](https://github.com/lidge-jun/opencodex/pull/3473) | `38b0c09b6` | Removed the duplicated plan docs; recorded the locale-parity rule |

All three proven with `git fetch origin dev` then
`git merge-base --is-ancestor <sha> FETCH_HEAD`.

## Requirement-by-requirement audit

Read from `git show origin/dev:<path>`, so this reflects the merged tree.

- **Brand is a real control, both placements.** `gui/src/App.tsx` defines one
  `brand` node as `<button type="button" className="brand brand-home">` calling
  `navigateToPage("dashboard")` then `setNavOpen(false)`, rendered in the mobile
  topbar and the drawer head. Live at 700px: it is the second tab stop, named
  "Go to dashboard", and Enter moves the hash to `#dashboard` with the drawer
  closed. At 1280px a click from `#providers/Cursor/Models` lands on
  `#dashboard` with `aria-current="page"` and the sidebar row active.
- **No redundant home row.** The Providers overview header holds only the
  refresh and JSON controls; the sidebar keeps the single 대시보드 destination.
- **Overview refresh.** `.pws-dashboard-header-actions` carries the control,
  wired `refreshAllProviderQuotas` -> `fetchProviderQuotas(true)` -> shell
  forced read -> `onQuotaRefreshSettled`. Live CDP capture on the merged build:
  `GET /api/provider-quotas?refresh=1` -> 200, status line "Quota check
  complete" with `pws-status-ok`.
- **Pending + disabled + truthful settle.** `disabled={refreshingQuotas}` and the
  result derives from the awaited promise. Covered by four DOM tests including a
  double-click that must not issue a second forced read.
- **Locales.** All nine catalogs carry `nav.goHome`, `pws.refreshAllQuotas`, and
  `pws.quotaRefreshDone` (grep count 3 each on `origin/dev`).
- **Checks on the merged head.** `bun run typecheck` exit 0, `bun run lint:gui`
  exit 0, 55 focused GUI tests pass across 10 files. The repository-wide suite
  was never run locally, as instructed.

## Scope note

The objective asked for ONE pull request. It became three because review found
real defects after the first merge: two locales documenting a control they did
not describe, and duplicated plan docs left by a rename pushed as adds without
deletes. Splitting the fixes was the honest response to landed defects, not
scope drift — each is a small, separately reviewable correction to this unit.

## Two judgment calls worth keeping

**The status string is deliberately weaker than "refreshed."**
`fetchProviderQuotaReports` answers 200 even when one upstream probe failed and
that provider kept its last-good row, so "Quotas refreshed" would overstate what
the read proved. "Quota check complete" is what the boolean actually supports;
per-provider freshness stays in each row's own age. Raised as P2 by Codex
review and accepted.

**The Accounts refresh was moved, not added.** It already existed at the foot of
the account list, below every account's stacked rate-limit bars — off-screen
with two accounts, which is why it read as missing. It now sits in the section
head beside the numbers it refreshes; the footer button stays as part of the
account-management cluster, and the result line lives in the head only so one
refresh is not announced twice.
