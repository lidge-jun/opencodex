# 260630 — Codex App sessions revert to last `ocx start` snapshot

Date: 2026-06-30

## Symptom

After closing and reopening the Codex desktop app, the session/thread list reverted to the state
at the last `ocx start`. Work done after that point appeared to vanish. The user typically runs
`ocx start` in a terminal foreground and stops it with `Ctrl-C`, then starts it again later.

In the user's own notation, the expected loop was `a a' b' -> b -> b'` (tag flips
`opencodex<->openai`, content always moves forward), but the observed behavior was
`a a' b' -> a -> a'` (the new turns `b'` were lost and the list snapped back).

## Root cause

The proxy runs without `OCX_SERVICE`, so its shutdown path
(`src/cli.ts` `syncCleanup` at the `SIGINT`/`SIGTERM`/`SIGHUP`/`exit` handlers) calls
`restoreNativeCodex()` -> `syncCodexHistoryProvider("openai")` on every termination, including a
normal `Ctrl-C`. That revert is intentional (native Codex can only resume a thread tagged
`openai`), but its *implementation* destroyed live data.

Cross-checked against codex-rs (`~/Developer/codex/121_openai-codex/codex-rs`):

1. `updateSessionMeta` rewrote each rollout JSONL with `atomicWriteFile` (temp + rename), which
   swaps the inode. The Codex app caches the live session's append handle and only reopens it when
   the handle is gone (`rollout/src/recorder.rs` `RolloutWriterState::ensure_writer_open`). After a
   rename, the app keeps writing to the orphaned inode; the path holds only opencodex's snapshot, so
   the live turns are lost on the next restart.
2. The proxy also opened the app's live `state_5.sqlite` (WAL) with a second writer connection and
   no `busy_timeout`, racing the app's pool.

## Evidence

- `lsof` showed `codex app-server` holding `state_5.sqlite`; `ps` showed the foreground
  `bun src/cli.ts start` proxy without `OCX_SERVICE`; `ocx status` confirmed "Service: not installed".
- codex-rs `state/src/runtime.rs` opens the DB WAL + `synchronous=NORMAL` + `busy_timeout=5s`,
  pooled; the list view reads the DB as the single source (`use_state_db_only`).
- codex-rs reads a thread's provider through TWO paths: the SQLite replay folds every `session_meta`
  last-writer-wins (`state/src/extract.rs` `apply_session_meta_from_item`), while
  `rollout/src/list.rs` `read_session_meta_line` reads only line 1 and
  `thread-store/src/local/update_thread_metadata.rs` clones it when writing later git/memory-mode
  metadata. Real rollouts already contain multiple `session_meta` lines.
- Live reproduction in an isolated `CODEX_HOME` reproduced the loss with the old code and confirmed
  the fix preserves `b'`/`b''` (see `10_fix-and-verification.md`).

## Why two earlier attempts were blocked (gpt-5.5 review)

- v1 (in-place truncate of line 1): read a stale snapshot, then `ftruncate` — races the app's
  concurrent append and clips new turns. BLOCK.
- v2 (append a trailing `session_meta`): fixed the truncate race but left line 1 as `openai`/stale,
  and missed validating the trailing line's thread id. BLOCK.
