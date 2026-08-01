# Phase 2 — Manual archived cleanup (C4 high-risk)

**Risk class:** C4 — irreversible data deletion. Separate, carefully-reviewed PR.
Must NOT ship with Phase 1.

## Goal
Let the user reclaim space by removing OLD ARCHIVED sessions, preview-first,
quarantine-by-default. Active sessions stay read-only.

## Hard requirements
- **Preview-first:** slider/presets (oldest 10/25/50%), a preview button, and a
  confirmation modal showing estimated count + bytes BEFORE any action.
- **Quarantine default:** move to trash/quarantine; permanent delete only behind
  an explicit checkbox.
- **Full data-model reconciliation** (see 20_codex-storage-structure.md): for each
  removed session, handle the `sessions|archived_sessions/*.jsonl` file AND the
  matching `threads` row (`rollout_path`, `archived`), plus any linked attachments
  and deletion manifest/audit trail.
- **Lock safety:** never touch an in-use sqlite. Skip/queue when `state_*.sqlite`
  is WAL-locked (Codex running); never corrupt a live DB.

## Verification idea
- Test preview accuracy (count/bytes match actual).
- Test quarantine round-trip + restore.
- Test deletion is a no-op / safe-skip when DB is locked.
- Regression suite required before shipping.

## Open questions
- Quarantine location + retention before permanent purge?
- Restore UX (undo window vs explicit restore)?
