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

