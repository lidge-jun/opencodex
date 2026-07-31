# Phase 4 — upgrade-path hardening (migration certainty)

Most users update FROM a re-tag install, so the one-time opencodex→openai migration
must succeed even when the first attempt hits a locked `state_5.sqlite` (Codex app
open during `ocx start` — the common case). Today a failed migration only prints a
warning; threads stay invisible until the user manually reruns start.

## Files

## Audit fixes folded in (gpt-5.5 reviewer, 2026-07-06)

- **(blocker 1) NO patient sleepSync retry inside inject.** `injectCodexConfig` is reachable
  from the live daemon (`/api/sync` → codex-sync.ts:59 → server.ts:1724); a 3x750ms sleepSync
  plus sqlite busy_timeout 5s would block every request. Inject KEEPS the existing
  `syncCodexHistoryProvider("openai")` (2 attempts / 500ms — unchanged today). Patience lives
  ONLY in the daemon guardian: 60s unref ticks, `{attempts: 1}` per tick.
- **(blocker 2) pending-count predicate mirrors eject exactly:**
  `WHERE model_provider = 'opencodex' AND trim(coalesce(first_user_message, '')) != ''`
  (no source filter, no RESUMABLE_SOURCES — eject handles exec→cli itself).
- Count probe opens sqlite `{ readonly: true }` (repo precedent kiro-credentials.ts:186)
  with a SHORT busy_timeout (100ms) so a locked DB cannot stall a daemon tick or doctor.
- Guardian starts ONLY in cli.ts handleStart (never from inject — `/api/sync` re-runs
  inject and would double-start loops); handle stored and stopped in syncCleanup next to
  the token guardian.
- Export `shouldInjectApiAuthHeader` (currently private, codex-inject.ts:53) for the gate.
- `migrateHistoryToOpenai` stays a thin alias (default = current retry), with an
  `attempts` option used by the guardian tick.

**MODIFY `src/codex-history-provider.ts`**
- `withHistoryRetry(fn, io)` gains `attempts` (default 2 = current behavior) and
  `delayMs` options.
- NEW `migrateHistoryToOpenai(stateDbPath?, backupPath?, opts?)`: patient wrapper
  (default attempts 3, delayMs 750) around the openai restore path; returns
  `CodexHistorySyncResult`.
- NEW `countPendingOpencodexHistory(stateDbPath?, backupPath?)`: read-only
  `{ pendingRows, backupEntries, failed? }` — COUNT of threads still tagged
  `opencodex` + backup manifest entry count. Cheap; used by guardian + doctor.

**NEW `src/history-migration-guardian.ts`**
- `startHistoryMigrationGuardian(deps?)`: unref'd setTimeout loop (default 60s,
  max 60 ticks). Each tick: count pending; 0 pending + 0 backup → stop silently;
  else migrate with `{attempts: 1}` (no sleepSync in the daemon event loop — the
  tick cadence IS the retry). Success → log migrated count, stop. Cap reached →
  final warning, stop. Injectable deps for tests.

**MODIFY `src/codex-inject.ts`**
- Design B branch calls `migrateHistoryToOpenai()` (patient) instead of plain
  `syncCodexHistoryProvider("openai")`.
- Export `shouldInjectApiAuthHeader` so the CLI can gate the guardian.
- Failed-migration message mentions the daemon keeps retrying in the background.

**MODIFY `src/cli.ts` handleStart**
- After `startTokenGuardian()`: when Design B mode (loopback) and
  `syncResumeHistory !== false`, start the migration guardian; stop it in
  `syncCleanup`.

**MODIFY `src/doctor.ts`**
- New "Codex history migration" section: pending rows / backup entries / locked
  state, with a close-the-app hint.

## Tests
- `withHistoryRetry` honors attempts (fail 3x, succeed on 4th with attempts 4).
- `countPendingOpencodexHistory` on the legacy fixture → counts; after migration → 0.
- `migrateHistoryToOpenai` clears legacy rows + backup (happy path).
- Guardian: stops immediately at 0 pending; retries while migrate fails then
  logs+stops on success; respects maxTicks; stop() cancels.

## Accept
- Targeted + full `bun test` green, tsc clean.
