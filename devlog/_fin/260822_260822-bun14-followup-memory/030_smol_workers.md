# 030 — smol workers: bounded JSC heap for storage/history batch workers

Depends on: 000. Sibling PR (no shared files with 010/020) — but landing is
GATED on a local large-fixture A/B (audit finding 3).

## Why

history-job/restore-job/policy-job spawn short-lived Workers for batch work.
`smol: true` (probe-verified on bundled 1.4.0) selects JSC's Small heap growth
policy → lower peak RSS during storage jobs, at a GC-frequency cost.

## Risk (audit finding 3 — must be measured before landing)

These workers are NOT small-payload: policy cleanup materializes all archive
candidates (src/storage/policy.ts:347-379); cleanup snapshots full thread/log/
memory/goal rows and serializes an aggregate backup
(src/storage/cleanup.ts:765-785,872-914,1171-1269); history reads complete
SQLite result sets with rollout buffers (src/codex/history-provider.ts:586-619,
709-732). smol is a growth-policy choice, not a payload bound — a large job
could GC-thrash or slow past the worker timeout.

## Pre-landing gate: per-worker large-fixture A/B

For each worker (history, restore, policy): build a large fixture (≥100MB
aggregate rows / large rollout set), run the job smol-off vs smol-on ×3,
record peak RSS (Subprocess/process sampling), elapsed wall time, completion
status. Acceptance to land each call site: completion success, elapsed within
+25% of baseline, peak RSS reduced. A worker failing the gate keeps its
full-size heap and the doc records the numbers — partial landing (subset of
the three call sites) is an acceptable outcome.

## Changes (only for call sites that pass the gate)

src/codex/history-job.ts:309, src/storage/restore-job.ts:170,
src/storage/policy-job.ts:303 — one-line `, { smol: true }` (pinned Bun 1.4
types include smol; no cast needed per audit).

## Tests
Existing worker suites stay green (smol changes GC policy, not messaging).
The A/B harness script + numbers are the landing evidence, committed into this
unit.

## Measurement claim
Local A/B is the primary evidence (host-independent fixtures); macmini optional.
