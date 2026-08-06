# 42 — Phase 2: quarantine + restore (default-safe cleanup)

## Problem
Permanent deletion is unforgiving. Default cleanup must be reversible; permanent
purge is opt-in only.

## Quarantine layout (proposed)
```
~/.codex/.trash/<deletedAt-epoch>/
   rollout-<ts>-<uuid>.jsonl          # moved, not copied
   manifest.json                       # { threadId, rolloutPath, archived_at,
                                         #   tokens_used, quarantinedAt, bytes }
```
- Move (rename) within the same filesystem = atomic, no large copy.
- Manifest captures enough to restore the threads row.

## Restore round-trip
```
restore(quarantineEntry):
  1. move JSONL back to its original rollout_path
  2. re-insert/unflag the threads row from manifest
  3. remove the quarantine entry
```

## Permanent purge (opt-in)
- Only behind an explicit checkbox in the UI.
- Empties `.trash/` entries older than a retention window, or on explicit
  "purge now". This is the only path that does an irreversible `unlink`.

## Verification
- Round-trip test: quarantine → restore → session fully reappears (JSONL +
  threads row), byte-identical JSONL.
- Retention test: purge removes only entries past the window.
- Default-mode test: a normal cleanup never calls `unlink` (only move-to-trash).

## Open questions
- Quarantine retention window default (7d? 30d? until manual purge)?
- Trash location: under CODEX_HOME (counts toward its size) vs OS trash?
