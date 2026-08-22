---
title: Codex Log Guard
description: Inspect and explicitly reduce Codex diagnostic-log persistence without exposing log bodies.
---

OpenCodex can inspect Codex's persistent diagnostic-log database and, when you opt in, reduce which diagnostic rows Codex persists. Inspection stays read-only; protection is an explicit mutation that is refused unless the known Codex log schema is present and Codex is stopped.

## What Inspect reports

OpenCodex resolves Codex's effective `sqlite_home` using Codex's existing precedence and inspects the canonical `logs_2.sqlite` database there. A higher-numbered or legacy `logs_N.sqlite` file is never substituted as the mutation-capable target.

The Storage view reports:

- the main database, WAL, and SHM file sizes;
- total log rows and the share stored at `TRACE` level;
- the largest log-target buckets by row count, using rank labels instead of target names;
- SQLite freelist space that may be reclaimable later; and
- whether the observed schema is compatible with the currently known Codex log schema.

If `sqlite_home` is outside `CODEX_HOME`, the diagnostic database is shown separately. Its bytes are not silently folded into the existing `CODEX_HOME` storage total.

OpenCodex does not select or expose `feedback_log_body` while producing these diagnostics. Log levels are reduced to the fixed known level set plus `OTHER`, and target names are not serialized.

## Protect modes

Protection is **off by default**. Enabling it installs one OpenCodex-owned `BEFORE INSERT` trigger in Codex's canonical `logs_2.sqlite` database. OpenCodex never replaces an unknown trigger using its reserved names and removes only triggers whose SQL matches the OpenCodex-owned version.

Two modes are available:

- **Compatibility** (`compat`) is the recommended mode. It pins the current Log Guard v1 rule set to the high-volume targets that current Codex already filters or down-levels in its persistent SQLite log sink. Unrelated `TRACE` rows are preserved.
- **Quiet** (`quiet`) suppresses every new `TRACE` row while preserving `DEBUG`, `INFO`, `WARN`, and `ERROR` rows.

Protection reduces rows that reach persistent SQLite storage. It does **not** eliminate Codex's earlier tracing work: events can still be formatted, queued, grouped into transactions, and considered by Codex's own pruning logic before the trigger ignores a row. Treat Protect as a persistent-write-churn shield, not as a switch that disables diagnostic generation inside Codex.

Log Guard filters only persisted local SQLite log rows. It does not change Codex diagnostic processing, [adapter transport](/reference/adapters/), provider payloads, streaming semantics, authentication, routing, quotas, or account state.

### Safety checks

Before Protect, Disable, or Repair changes the foreign database, OpenCodex:

1. resolves exactly the canonical `logs_2.sqlite` path;
2. verifies that the path is a regular, non-symlink file and that the known schema matches exactly;
3. verifies that process enumeration succeeded and no supported Codex writer process is running;
4. acquires a dedicated cross-process Log Guard lock;
5. repeats the Codex-process check after acquiring that lock;
6. opens the database read/write **without** create semantics and acquires SQLite `BEGIN IMMEDIATE` with no busy wait;
7. changes only OpenCodex-owned Log Guard triggers and reads the result back before commit; and
8. persists the requested mode in OpenCodex configuration while the Log Guard lock is still held.

If process enumeration is uncertain, the database is busy, the schema is unknown, or a reserved trigger name belongs to different SQL, the mutation fails closed. OpenCodex does not terminate Codex automatically.

## Drift and Repair

The requested protection mode is stored in OpenCodex configuration separately from Codex's log database. This matters because a Codex migration can rebuild the `logs` table, and SQLite drops triggers attached to a table that is replaced.

When the saved mode is `compat` or `quiet` but the corresponding owned trigger is no longer observed, Log Guard reports **drifted**. `ocx doctor` reports the drift but never repairs it automatically.

Repair is explicit:

```bash
ocx storage codex-logs repair
```

OpenCodex deliberately does not recreate protection on every startup. A later release can reconsider automatic repair only after there is enough field evidence that doing so is safe across Codex migrations.

## CLI

Read status:

```bash
ocx storage codex-logs status
ocx storage codex-logs status --json
ocx doctor
```

Enable the recommended compatibility policy:

```bash
ocx storage codex-logs protect
```

Choose quiet mode explicitly:

```bash
ocx storage codex-logs protect --mode quiet
```

Disable OpenCodex protection or repair drift:

```bash
ocx storage codex-logs unprotect
ocx storage codex-logs repair
```

Add `--json` to the Log Guard commands for machine-readable output. See the [CLI reference](/reference/cli/) for the canonical command syntax and JSON behaviour.

The existing command remains unchanged:

```bash
ocx storage --json
```

Its response carries the same Codex-log status used by the Storage page.

## Management API

Status is available at:

```text
GET /api/storage/codex-logs
```

Explicit mutations use:

```text
POST /api/storage/codex-logs/protect
POST /api/storage/codex-logs/unprotect
POST /api/storage/codex-logs/repair
```

The Protect body is either `{"mode":"compat"}` or `{"mode":"quiet"}`. `GET /api/storage` also includes the report as `codexLogs` so the dashboard can refresh the normal storage breakdown and Codex-log diagnostics from one snapshot request.

## Read-only snapshot semantics

Status inspection opens the database read-only with SQLite `immutable=1`. This prevents a diagnostic read from creating or updating `-wal` or `-shm` sidecars.

The trade-off is important: SQL aggregates and observed trigger metadata describe the last checkpointed database snapshot. If Codex is actively writing, the live WAL can contain newer rows or schema pages than the immutable snapshot. A successful mutation response uses the trigger state that OpenCodex verified inside its write transaction; a later read-only status request can temporarily lag until SQLite checkpoints those schema pages.

OpenCodex reports the WAL file size separately and does **not** label the result as SSD write rate, NAND writes, or drive-wear/TBW consumption.

## Compatibility states

A known schema reports inspection and protection as supported. A missing, unreadable, or unknown future schema remains inspectable as metadata but is reported as unsupported for mutation-capable operations.

An unknown schema is not guessed into compatibility. This lets a newer Codex version remain observable while preventing Log Guard from treating an unreviewed database layout as safe to modify.

## Reclaim is still separate

Protect does not vacuum or compact SQLite. The later **Reclaim** stage will add an explicit, offline, bounded incremental-vacuum flow with checkpoints and integrity checks.

Protect never runs `VACUUM`, never truncates or deletes Codex's WAL directly, and never performs scheduled space reclamation.
