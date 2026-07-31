# 41 — Phase 2: deletion data-model reconciliation (C4)

**Risk class:** C4 — irreversible. This doc defines WHAT a safe delete must touch.

## Problem
Deleting a session is not `rm file.jsonl`. The session is represented in BOTH
the filesystem and `state_*.sqlite`. A naive file delete orphans the DB row;
a naive row delete orphans the JSONL. Either leaves the dashboard inconsistent.

## The data model (measured, see 20_codex-storage-structure.md)
For one session:
1. **Rollout JSONL** — `sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`
   (or `archived_sessions/rollout-...jsonl` once archived).
2. **threads row** — `state_*.sqlite` `threads` where `rollout_path` points at
   (1). Columns: `id`, `rollout_path`, `archived`, `archived_at`, `tokens_used`…
3. **Linked rows** — `thread_spawn_edges` (14 rows observed) reference thread ids;
   sub-agent/spawn relationships must be considered (cascade or block).
4. **Attachments / manifests** — any attachment files + deletion manifest/audit
   trail (if present in the home) tied to the thread.

## Safe-delete sequence (proposed)
```
for each selected (archived) session:
  1. verify it is archived (never touch active sessions)
  2. resolve rollout_path from the threads row (source of truth)
  3. move JSONL -> quarantine (see 42)            # reversible
  4. mark/remove threads row (+ archived_at)       # inside a txn
  5. handle thread_spawn_edges referencing the id  # cascade rule TBD
  6. write a deletion-manifest entry (audit)
commit txn only if all FS moves succeeded; else roll back.
```

## Lock safety
- `state_*.sqlite` has live `-wal`/`-shm` while Codex runs. Phase 2 must:
  - open the DB in normal RW mode ONLY when not locked; on `SQLITE_BUSY`,
    skip/queue the operation and surface "Codex running — try later".
  - never delete a JSONL whose thread row could not be updated (no half-deletes).

## Verification
- Test the full reconciliation on a fixture: JSONL gone (quarantined), thread
  row updated, edges handled, manifest written — all-or-nothing.
- Test `SQLITE_BUSY` path: no-op + clear error, zero partial state.

## Open questions
- `thread_spawn_edges`: cascade-delete children or block delete of a parent
  with live children? (90_open-questions.md)
