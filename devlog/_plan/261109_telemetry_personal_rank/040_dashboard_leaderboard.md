# 040 — docs-site leaderboard and personal rank (wp5)

## NEW `docs-site/src/components/telemetry-dashboard/leaderboard.ts`

Fetches `GET /v1/leaderboard` (`TELEMETRY_LEADERBOARD_ENDPOINT` in `constants.ts`, overridable through
`data-leaderboard-endpoint` like the stats endpoint) and `GET /v1/profiles/by-handle/<handle>`. Renders with
`textContent` only (no `innerHTML` for user-supplied strings), avatar as an initial on a palette colour class.

## MODIFY `TelemetryDashboard.astro`

New `<section id="leaderboard" class="td-panel">`: period tabs (Day/Week/Month), metric toggle (Tokens/Requests), table
(rank, avatar+name, @handle, tokens, requests), an empty state ("No public profiles yet — connect from the opencodex
dashboard Home"), and a "Find a profile" form. `?profile=<handle>` (validated with `PROFILE_HANDLE_RE`) opens the
personal-rank view: rank per period, totals, model families, and a note that profiles are opt-in and self-reported.

## MODIFY `telemetry-dashboard-i18n.ts`

New keys in all 8 locales.

## Tests

NEW `tests/ci-workflows/docs-telemetry-leaderboard.test.ts` (source oracle like `docs-telemetry-dashboard.test.ts`):
every locale has the keys, user strings are set through `textContent`, handle validation before fetch, endpoints
constant. Docs-site build in C.


## Stale check (wp5 P, 2026-11-09)

- `TelemetryDashboard.astro` (1521 lines, stack-owned, scoped styles) and `telemetry-dashboard-i18n.ts` (960 lines,
  whose test forbids "opt-in" wording because the anonymous telemetry is on by default) stay untouched. The leaderboard
  is a sibling component `docs-site/src/components/TelemetryLeaderboard.astro` mounted by `dashboard.mdx` after
  `<TelemetryDashboard />`, with its own copy module `docs-site/src/data/telemetry-leaderboard-i18n.ts` (same 8
  locales) and its own client `docs-site/src/components/telemetry-dashboard/leaderboard.ts` (endpoint constants live
  there, not in the stack's `constants.ts`).
- The docs-site does not import from the root `src/`; the handle regex and palette are duplicated and a source-oracle
  test asserts they equal `src/telemetry/profile/contract.ts`.
- Test: `tests/ci-workflows/docs-telemetry-leaderboard.test.ts` (pure helpers, copy parity, `textContent`-only rendering,
  handle validation before any fetch, mdx mount).
