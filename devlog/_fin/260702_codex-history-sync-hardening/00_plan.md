# Codex History Sync Hardening — Loop 1 Plan (P)

- **Date:** 2026-07-02 · **Branch:** cursor-fixes · **Class:** C4-adjacent (user chat-history
  integrity; this loop changes only error-handling/reporting, not tagging semantics)
- **Driver:** User reports: after `ocx update` + restart, the Codex app shows chat history
  gone except pinned; Windows much worse than macOS.
- **Evidence base:** first-hand read of src/codex-history-provider.ts (full), call sites
  codex-inject.ts:283/379; Codex xhigh RCA (design map + ranked causes); local state DB
  inspection (threads.model_provider openai 616 / opencodex 575; no pinned column —
  pinning is app-side, consistent with "pinned survive a list filter").

## Confirmed failure mechanism (this loop's target)

`syncCodexHistoryProvider()` swallows recoverable SQLite/file-lock errors and returns
`{rows:0, files:0}` (`codex-history-provider.ts:369-376`) — indistinguishable from
"nothing to do". On Windows the Codex app holds `state_5.sqlite` (WAL, busy_timeout 5s,
no retry) far more aggressively, and stop paths there are likelier to be forced. During
`ocx update` → `stop` → restore silently no-ops → threads stay `model_provider='opencodex'`
→ the native app hides them (except app-side pinned). Nothing tells the user; nothing
retries. The backup manifest (`codex-history-backup-*.json`) is only deleted after a
SUCCESSFUL restore — its continued existence after stop is a reliable "restore incomplete"
signal.

Deferred to loop 2 (needs codex-rs list-filter facts, research in flight): avoiding the
re-tag design entirely, `session_index.jsonl` reconciliation, cross-process sync lock,
`thread_source` propagation.

## Diff-level changes

**MODIFY `src/codex-history-provider.ts`**
- `CodexHistorySyncResult` gains `failed?: true` (set only when a recoverable lock error
  survived retries; hard errors still throw).
- New `withHistoryRetry<T>(fn, io?)`: run `fn`; on `isRecoverableHistoryError` sleep 500 ms
  (injectable for tests) and retry once; on second recoverable failure return null.
- `syncCodexHistoryProvider` + `restoreLegacyOpenaiHistory` route through it; on exhausted
  retries return `{rows:0, files:0, failed:true}`.
- Export `isRecoverableHistoryError` for tests.

**MODIFY `src/codex-inject.ts`**
- `restoreNativeCodex()`: when `history.failed`, append to the returned message:
  `⚠️ Codex resume history could NOT be restored — the Codex app appears to be holding
  the history DB. Close the Codex app/IDE and run 'ocx stop' again; until then routed
  threads stay hidden in the native app.`
- `injectCodexConfig()`: when forward-sync `history.failed`, historyMessage notes the skip
  (`history sync skipped: state DB locked (close the Codex app and rerun 'ocx start')`).

**MODIFY `src/update.ts` + `bin/ocx.mjs`**
- After the successful stop gate, scan the ocx config dir for `codex-history-backup-*.json`;
  if present, print a non-blocking warning that native history visibility is not restored
  and how to fix (close Codex app → `ocx stop`). Update proceeds (blocking an update on an
  open IDE would be worse; the warning is actionable).

## Tests

- `tests/codex-history-provider.test.ts`: `isRecoverableHistoryError` truth table
  (SQLITE_BUSY/LOCKED codes, "database is locked" message, EBUSY/EPERM; rejects plain
  errors); `withHistoryRetry` — recoverable→success on 2nd try, exhausted→null, hard
  error rethrows, injectable sleep not real-slept.
- `tests/update-stop-first.test.ts` (source-shape, existing style): update paths contain
  the history-backup scan + warning.

## Verification gate (C)

`bun test ./tests/` (0 fail) + `bun x tsc --noEmit` (0 errors).
