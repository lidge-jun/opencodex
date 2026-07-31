# Phase 1 — Storage diagnostics (read-only)

**Risk class:** C2 (read-only, low risk). Recommended first PR.

## Goal
A dashboard Storage page that shows where `~/.codex` disk goes, with zero
deletion. Answers "why is my CODEX_HOME 3+ GB?".

## Surface (future implementation, not this cycle)
- Backend: new `GET /api/storage` in `src/server.ts` (sits beside `/api/usage`,
  `/api/logs`). Returns per-bucket size/count/oldest/newest.
- Scanner: new module building on `src/codex-paths.ts` (`CODEX_HOME`). Aggregates
  `sessions/` (date-partitioned rollout JSONL), `archived_sessions/`,
  `logs_2.sqlite`, `state_*.sqlite`, attachments. Sizes via `fs.stat`; DB row
  counts via `?mode=ro&immutable=1` with graceful skip on lock.
- Frontend: new `gui/src/pages/Storage.tsx`, registered in `gui/src/App.tsx`
  (import + route) next to `Usage`/`Logs`.

## Buckets to surface
sessions, archived_sessions, logs DB (+WAL), state DB, attachments, remote
attachments, deletion manifests, total. Per bucket: size, count, oldest, newest,
largest few (capped). Optionally non-session buckets (plugins/computer-use) as
context.

## Verification idea
- Unit-test size/age aggregation against a fixture CODEX_HOME.
- Assert read-only: no writes to CODEX_HOME during a scan.
- Confirm `/api/storage` numbers match `du`/`sqlite3` on a fixture.

## Open questions
- Show non-session buckets (plugins, computer-use) or keep session-focused?
- Cap on "largest items" list length?
