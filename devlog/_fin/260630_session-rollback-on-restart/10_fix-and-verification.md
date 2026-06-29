# 260630 — Fix: non-destructive native restore

Date: 2026-06-30

## Approach

Keep the revert behavior (Ctrl-C / stop still tags threads back to `openai`), but make every write
to the app's live files non-destructive. All changes are in `src/codex-history-provider.ts`.

1. `openStateDb()` — open `state_5.sqlite` with `PRAGMA busy_timeout = 5000`, matching the app's own
   connection options, so a concurrent write waits on the WAL lock instead of failing. Replaces the
   three raw `new Database(stateDbPath)` opens.
2. `appendRolloutLine()` — append one `session_meta` line via an `O_APPEND` handle (the same way the
   app appends metadata in `append_rollout_item_to_path`). No rename, no truncate, no mtime reset, so
   the app's cached append handle stays valid and concurrent appends compose safely. This covers the
   SQLite-replay reader (last-writer-wins).
3. `readLatestSessionMeta()` + thread-id guard — base the patch on the latest `session_meta` and
   skip when its `payload.id` != the canonical thread id, mirroring the app ignoring id-mismatched
   lines. Prevents writing a misleading line for forked rollouts.
4. `patchFirstLineProviderInPlace()` — for a length-preserving provider change (e.g.
   `opencodex` -> `openai`), rewrite only the `"model_provider":"..."` token inside line 1, padding
   the freed bytes with JSON-insignificant whitespace so the line byte length is identical. Equal
   length means an offset-fixed write with no truncate and no inode swap. This covers the
   first-line-clone reader path, so a later app git/memory-mode update cannot resurrect `opencodex`.
   The first line is read by growing the probe until the newline (16 MiB hard stop) so large
   `base_instructions` cannot silently disable the patch.

The opencodex direction (`openai` -> `opencodex`, a length-growing change) intentionally stays
append-only: keeping line 1 as the origin provider is harmless there and the live data-loss bug was
the revert direction.

## Verification

- `bun x tsc --noEmit`: clean.
- `bun test ./tests/`: 890 pass, 0 fail.
- New regression tests in `tests/codex-history-provider.test.ts`:
  - appends instead of rewriting line 1, preserving inode and prior bytes;
  - skips append when the latest `session_meta` has a foreign thread id;
  - rewrites line 1 in place (length-preserving) on opencodex-origin revert, and a later
    first-line clone no longer resurrects `opencodex`;
  - patches line 1 even when it exceeds the 64 KiB read chunk (large `base_instructions`).
- Live reproduction (isolated `CODEX_HOME`, app's cached append handle simulated):
  `inode_preserved=true`, `b'`/`b''` survived, DB flipped to `openai`, latest + first-line
  `session_meta` both `openai`, and an app clone-and-append afterward still resolved to `openai`.

## Surfaces reviewed

All native-restore entry points funnel through `restoreNativeCodex` /
`syncCodexHistoryProvider` / `restoreLegacyOpenaiHistory`, so they inherit the fix:
`src/cli.ts` signal shutdown + `ocx stop`/`restore`/`recover-history`, `src/server.ts` `/stop`
endpoint, and `src/service.ts` service stop/uninstall. The inject (opencodex) direction in
`src/codex-inject.ts` is unchanged in behavior beyond the safer append/DB open.

## Operational note

Running the proxy as a service (`ocx service install`, `OCX_SERVICE=1`) skips the on-shutdown
restore entirely, which also avoids the churn for users who never intend to drop back to native
Codex between restarts.
