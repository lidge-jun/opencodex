---
title: Codex Log Guard Reclaim
description: Manually reclaim free pages from Codex diagnostic-log SQLite storage with bounded incremental vacuuming.
---

Reclaim is the manual space-recovery stage of Codex Log Guard. It compacts the canonical Codex `logs_2.sqlite` database only when the database and runtime pass the same safety checks used by Log Guard protection.

Reclaim is **never scheduled automatically** and never runs merely because the Storage page is opened. The dashboard requires an explicit Compact action and a second confirmation before it sends the mutation request.

## What Reclaim does

OpenCodex performs a bounded offline maintenance sequence:

1. resolve the canonical `logs_2.sqlite` through Codex's effective `sqlite_home`;
2. verify the file identity and known Codex log schema;
3. verify process enumeration succeeded and no supported Codex writer process is running;
4. acquire the dedicated cross-process Log Guard lock;
5. repeat the Codex-process check while that lock is held;
6. open the existing database read/write without create semantics and prove an immediate SQLite writer can be acquired;
7. require `PRAGMA auto_vacuum` to already be `INCREMENTAL`;
8. run `PRAGMA quick_check` before maintenance;
9. run a full WAL checkpoint and refuse a busy/incomplete checkpoint;
10. execute bounded `PRAGMA incremental_vacuum(N)` batches, checkpointing after each batch;
11. run `PRAGMA quick_check` again after maintenance; and
12. report before/after database, WAL, page-count, freelist, and reclaimable-byte metrics.

The default batch target is approximately **8 MiB of SQLite pages**. A single invocation reclaims at most approximately **256 MiB of pages**, with an additional finite iteration cap. If more free pages remain, the result is reported as partial and you can invoke Compact again later.

The byte limits are converted to page counts using the database's actual SQLite page size. They are bounds on logical SQLite pages processed, not claims about SSD/NAND write volume.

## Safety guarantees

Reclaim deliberately does **not**:

- run full `VACUUM`;
- change `auto_vacuum` mode on an existing Codex database;
- delete, truncate, rename, or otherwise manipulate Codex `-wal` / `-shm` files directly;
- delete diagnostic rows;
- modify Log Guard protection triggers or unrelated user triggers;
- run while Codex is detected as active;
- proceed when process enumeration is uncertain;
- proceed on an unknown future log schema; or
- continue after a failed SQLite integrity check.

A busy Log Guard lock, busy SQLite writer, or busy initial checkpoint is returned as an explicit refusal rather than being retried in the background. If checkpoint contention appears only after an incremental-vacuum batch has already committed, OpenCodex reports the work already completed as a successful partial result with `stopReason: "busy"` instead of claiming that nothing changed.

## CLI

Inspect reclaimable space first:

```bash
ocx storage codex-logs status
```

Run one bounded maintenance pass:

```bash
ocx storage codex-logs compact
```

For machine-readable before/after metrics:

```bash
ocx storage codex-logs compact --json
```

If the result reports that more reclaimable space remains, stop there unless you explicitly want another bounded pass. OpenCodex does not loop indefinitely or schedule a follow-up pass for you.

## Management API

Compaction is exposed only as a mutation endpoint:

```text
POST /api/storage/codex-logs/compact
```

There is no GET alias for compaction. A successful response contains a `report` object with before/after measurements, reclaimed page counts, physical main-database size change, iteration count, completeness, stop reason, and integrity status.

Typical refusal states include:

- `codex_running`
- `process_enumeration_failed`
- `busy`
- `unsupported_schema`
- `auto_vacuum_not_incremental`
- `unsafe_path`
- `integrity_check_failed`
- `database_error`

Integrity failures include whether they occurred before or after the maintenance pass. A `busy` refusal means contention was detected before any vacuum batch committed; `stopReason: "busy"` inside a successful report means at least one batch committed before later checkpoint contention stopped the pass.

## Understanding the result

`pagesReclaimed` and `logicalBytesReclaimed` describe SQLite freelist pages removed during the pass. `physicalDatabaseBytesReclaimed` reports the observed reduction in the main database file after the maintenance checkpoints.

Those numbers can differ. SQLite/WAL/filesystem behaviour means reclaiming logical pages does not guarantee an identical immediate physical-file reduction, and none of these metrics should be interpreted as NAND writes, SSD wear, or TBW consumed/saved.

`complete: true` means the observed freelist reached zero. A partial result uses `stopReason: "page_budget"` when either the per-run page budget or the finite iteration cap ends the pass, `stopReason: "no_progress"` when SQLite stops reducing the freelist, and `stopReason: "busy"` when checkpoint contention appears after committed reclamation. All three are bounded outcomes; none causes an automatic retry.
