# 000 — Research: preserving usage history beyond the 64 MiB management read window

## Problem

`~/.opencodex/usage.jsonl` is append-only and unbounded (observed: 157 MB / 380k rows
after ~5 weeks). `readUsageSnapshotForManagement` reads only the newest
`managementUsageMaxReadBytes` (default 64 MiB) and caps parsed rows at
`MANAGEMENT_USAGE_MAX_ENTRIES` (200k). Once the file outgrows the window, every
`/api/usage` consumer silently loses the oldest days — the summary reports
`historyTruncated: true` but the data is simply absent from `days`/`models`/
`providers` and from `summary` totals. Observed in production on 2026-08-04:
the 30d range was missing 11 of 30 days.

Raising the byte window (256 MiB) or the entry cap (500k) only defers the loss and
makes every read slower. The fix: fold rows that leave the read window into a
compact daily aggregate sidecar, and make the reader merge "rollup (old) + raw
tail (recent)".

## Prior-art survey (lunasearch, 5 lanes, Tier-2 source-proven 2026-08-04)

### Lane 1 — TSDB downsampling (James)

- Prometheus: block-merge compaction, aggregates live in *separate* recording-rule
  series; safety boundary is the immutable block. [Storage docs](https://prometheus.io/docs/prometheus/latest/storage/) (primary).
- InfluxDB: raw bucket and aggregate bucket are separate retention domains; a
  scheduled task windows recent data with an explicit lateness `offset`.
  [Downsample and retain](https://docs.influxdata.com/enterprise_influxdb/v1/guides/downsample_and_retain/) (primary).
- Thanos Compactor: rewrites blocks into aggregate chunks *after* a watermark
  (raw→5m only after 40h); single-compactor rule; halt on overlap.
  [Compactor](https://thanos.io/tip/components/compact.md/) (primary).
- Takeaway: every mature system separates the raw store from the aggregate store
  and only folds data past a stability boundary.

### Lane 2 — append-only log compaction (Beauvoir)

- Kafka never compacts the active segment; compaction reads older immutable
  segments and atomically swaps results in. [Design](https://kafka.apache.org/41/design/design/) (primary).
- Readers merge "stable compacted snapshot + live tail by validated offset
  boundary". Ordering and offsets never change.
- logrotate `copytruncate` documents a copy→truncate race that loses appends —
  writer-uncoordinated truncation is inherently lossy.
  [logrotate.conf(5)](https://man7.org/linux/man-pages/man5/logrotate.conf.5.html) (primary).
- JSONL: compact only complete newline-terminated records; quarantine a partial
  final line. [jsonlines.org](https://jsonlines.org/) (lead).

### Lane 3 — crash-safe ordering (Sartre)

- SQLite WAL: persist WAL first, then the DB, then reset the WAL — the aggregate
  never advances ahead of its source. [WAL](https://www.sqlite.org/wal.html) (primary).
- Atomic replace: temp file → fsync(temp) → rename → fsync(parent dir).
  [fsync(2)] (primary).
- Two files cannot be flushed atomically; make the raw log authoritative, keep a
  durable monotonic watermark in the sidecar, replay the raw suffix after the
  watermark on recovery. Advancing the watermark *after* the aggregate is durable
  converts crashes into idempotent re-work, never loss.
  [USENIX ATC15 crash-consistency](https://www.usenix.org/system/files/conference/atc15/atc15-paper-min.pdf) (primary research).

### Lane 4 — LLM CLI usage stores (Pascal)

- Claude Code: append-only JSONL transcripts + a *separate* `stats-cache.json`
  aggregate for `/usage` — the same raw/aggregate split at much coarser grain.
  [Claude directory docs](https://code.claude.com/docs/en/claude-directory) (primary).
- Codex: documented unbounded-JSONL pathologies (issue #34061, ~755 GiB of
  session JSONL) with no shipped rotation fix — nobody upstream has solved this
  for us; also a warning that agents must not self-ingest their own logs
  (issue #27131).
- ccusage consumes schema-complete JSONL/SQLite token records; our
  `PersistedUsageEntry` is already schema-complete, so folding to aggregates
  loses only per-request identity, not meterability.

### Lane 5 — exactly-once boundaries (Averroes)

- High-water-mark pattern: persist `(aggregate, mark)` together; read strictly
  after the mark; advance the mark only with the aggregate.
  [GOV.UK HWM guidance](https://pg-bulk-ingest.docs.trade.gov.uk/high-watermark/) (primary).
- A *source offset* answers "which records are consumed" (exactly-once); an
  *event-time watermark* answers "when is a bucket final". For a local file the
  offset is the correctness boundary — wall-clock time is unsafe.
  [Flink streaming analytics](https://nightlies.apache.org/flink/flink-docs-stable/docs/learn-flink/streaming_analytics/) (primary).
- Emit deltas and add, or emit snapshots and replace — never add repeated
  cumulative snapshots (Beam accumulating-pane trap).

## Design conclusions adopted

1. **Offset cutline, not date cutline.** The rollup covers exactly the byte range
   `[0, cutlineOffset)` of a specific file lineage; the reader takes raw rows
   from `[cutlineOffset, EOF]`. Dedupe is structural (disjoint byte ranges), so
   out-of-order timestamps cannot double-count and boundary days merge additively
   in the day grid.
2. **Rollup rows are deltas.** Each fold run appends aggregate rows covering only
   the newly folded byte range. The reader sums all rollup rows plus the tail.
   Repeated groups across fold runs are additive by construction.
3. **Ordering: fold → fsync rollup → advance meta (temp+fsync+rename).** A crash
   between rollup append and meta advance re-folds the same range next run; to
   make that idempotent each fold writes a `segment` record keyed by
   `(lineageId, fromOffset)` and the folder skips ranges already recorded.
4. **Never truncate raw by default.** The window mechanism already ignores the
   prefix; truncation is a policy decision deferred (documented for a follow-up).
   No writer-coordination or copytruncate-style race exists as a result.
5. **Token aggregates only; cost stays display-time.** Cost is linear in tokens
   for a fixed `(provider, model, tier, longContext)` price row, so grouping by
   those keys preserves exact display-time recomputation and keeps price-table
   fixes retroactive. Long-context is per-request non-linear, hence it is part of
   the group key, evaluated at fold time with the same predicate used today.
6. **Two aggregation grains.** `summary`/`days` count *requests* (entry-level);
   `models`/`providers` count *attributions* (attempt-level, combo-aware). The
   rollup stores both kinds of rows explicitly rather than deriving one from the
   other lossily.

## Claim ledger

| # | Claim | Source | Tier |
|---|-------|--------|------|
| 1 | Kafka excludes the active segment from compaction | kafka.apache.org/41/design | verified |
| 2 | copytruncate documents a lossy race window | man7 logrotate.conf(5) | verified |
| 3 | SQLite orders WAL-persist before DB-persist before WAL-reset | sqlite.org/wal.html | verified |
| 4 | Atomic replace requires temp+fsync+rename+dir-fsync | fsync(2) man page | verified |
| 5 | HWM advances only with its aggregate, source-derived not wall-clock | GOV.UK pg-bulk-ingest docs | verified |
| 6 | Prometheus/Thanos fold only past a stability watermark | prometheus.io, thanos.io | verified |
| 7 | Claude Code keeps raw JSONL + separate aggregate cache | code.claude.com | verified |
| 8 | Upstream Codex has no shipped rotation fix for JSONL growth | github.com/openai/codex#34061 | verified |
