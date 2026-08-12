# 33 — Phase 1: test fixtures + read-only assertions

## Problem
Phase 1 must prove correct aggregation AND the read-only invariant before ship.

## Fixture builder
- Create a temp dir acting as CODEX_HOME with:
  - `sessions/2026/05/27/rollout-...jsonl` (a few files, known byte sizes),
  - `archived_sessions/rollout-...jsonl`,
  - a tiny `state_9.sqlite` with a `threads` table (rows with `rollout_path`,
    `archived` 0/1) and a `logs_9.sqlite` with N `logs` rows,
  - WAL/SHM siblings to exercise the lock-safe path.
- Point the scanner at it via `CODEX_HOME` override (the scanner derives all
  paths from `CODEX_HOME`, so an env/param injection covers it).

## Tests
1. `scanStorage()` bucket bytes == sum of fixture file sizes (per bucket).
2. fileCount == number of fixture files per bucket.
3. oldest/newest match fixture mtimes.
4. DB row counts match inserted rows (via `?mode=ro&immutable=1`).
5. Lock-safe: with a simulated locked DB, counts come back `null`, no throw.
6. **Read-only invariant**: snapshot fixture mtimes/inode before+after a scan;
   assert nothing under CODEX_HOME changed (no writes, no new files).
7. `/api/storage` integration: success envelope has no `error`; forced failure
   returns the fallback envelope with `error: "scan_failed"`.

## Verification
- `bun test tests/storage-scanner.test.ts` green.
- `bun x tsc --noEmit` clean.
