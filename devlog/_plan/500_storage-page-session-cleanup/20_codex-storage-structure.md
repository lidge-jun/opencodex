# Codex storage structure (measured on macOS)

Measured 2026-06-29 on this Mac. `CODEX_HOME` unset → defaults to `~/.codex`.
All numbers are real `du`/`sqlite3` output, not estimates.

## Top buckets by size (`du -sh ~/.codex/*`)

| Bucket | Size | Notes |
|---|---|---|
| `sessions/` | **2.4 GB** | rollout JSONL, the dominant consumer (858 files) |
| `plugins/` | 316 MB | plugin cache/runtime — not session data |
| `logs_2.sqlite` | 145 MB | structured log rows (78,037) |
| `computer-use/` | 57 MB | CU artifacts |
| `shell_snapshots/` | 30 MB | shell capture |
| `cache/` | 9.2 MB | catalogs, app dir |
| `state_5.sqlite` | 7.1 MB | thread metadata DB |
| `archived_sessions/` | 156 KB | archived rollout JSONL (flat dir) |

Session-cleanup scope = `sessions/` + `archived_sessions/` + `state_*.sqlite`
thread rows. `logs_2.sqlite` is a separate lifecycle. `plugins/`, `computer-use/`,
`shell_snapshots/` are non-session and out of cleanup scope (but useful in a
diagnostics view).

## sessions/ layout

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO8601>-<uuid>.jsonl
e.g. sessions/2026/05/27/rollout-2026-05-27T00-52-43-019e64fd-...-...jsonl
```

- Date-partitioned: year / month / day directories.
- One JSONL file per session (rollout). 858 files, 2.4 GB total here.
- JSONL line shape: `{ timestamp, type, payload }`. Observed `type` values:
  - `session_meta` (first line — session header)
  - `event_msg`
  - `response_item`

## archived_sessions/ layout

- Flat directory of `rollout-*.jsonl` (no date partitioning).
- Sessions move here when archived. Small today (156 KB / 1 file).

## state_5.sqlite — `threads` table (the JOIN key)

236 rows (1 archived). Relevant columns:

| Column | Meaning |
|---|---|
| `id TEXT PRIMARY KEY` | thread id |
| `rollout_path TEXT NOT NULL` | **path to the session's rollout JSONL** |
| `archived INTEGER`, `archived_at` | archive flag + timestamp |
| `created_at`, `updated_at`, `recency_at` | lifecycle timestamps |
| `tokens_used`, `cwd`, `git_sha/branch/origin_url`, `title`, `preview` | metadata |

Indexes: `archived`, `created_at`, `updated_at`, `source`, `provider`.

**Critical for cleanup design:** deleting a session is NOT a file delete. To
remove a session safely you must reconcile:
1. the `sessions/.../rollout-*.jsonl` file (or `archived_sessions/...`),
2. the matching `threads` row (`rollout_path` join, `archived` flag),
3. WAL/SHM lock state while Codex is running (`state_5.sqlite-wal`, `-shm`).

## logs_2.sqlite — `logs` table

- 78,037 rows. Columns include `ts`, `level`, `target`, `thread_id`,
  `process_uuid`, `estimated_bytes` (per-row size estimate — handy for a
  diagnostics breakdown without scanning blobs).
- Indexed by `ts` and `thread_id`. Separate cleanup lifecycle from sessions.

## WAL / locking caveat (read-only diagnostics too)

Every root sqlite has `-wal` + `-shm` siblings that are live while Codex runs.
A Phase 1 read-only scanner should:
- get file sizes via `fs.stat` (never opens the DB),
- when DB-internal counts are needed, open with `?mode=ro&immutable=1` or skip
  gracefully on lock contention — never write or risk corrupting an in-use DB.

## Reproduce

```bash
du -sh ~/.codex/sessions ~/.codex/archived_sessions ~/.codex/logs_2.sqlite ~/.codex/state_5.sqlite
find ~/.codex/sessions -type f | wc -l
sqlite3 ~/.codex/state_5.sqlite "select count(*), sum(archived) from threads"
sqlite3 ~/.codex/logs_2.sqlite "select count(*) from logs"
```
