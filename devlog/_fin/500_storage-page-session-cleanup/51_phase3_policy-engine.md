# 51 — Phase 3: auto-cleanup policy engine (opt-in, default OFF)

**Risk class:** C4 (drives Phase 2 deletion). Default OFF, never implicit.

## Problem
Manual cleanup (Phase 2) doesn't keep storage bounded over time. An opt-in
policy can do it automatically — but it operates an irreversible-capable path,
so it must be conservative and observable.

## Policy schema (proposed, persisted in settings)
```ts
interface StorageCleanupPolicy {
  enabled: boolean;            // default false
  trigger: { archivedBytesOver: number };       // e.g. 5 * 1024**3
  target:  { reduceToBytes?: number } | { removeOldestPercent?: number };
  schedule: "startup" | "daily" | "weekly" | "manual";
  mode: "quarantine" | "permanent";             // default "quarantine"
  lastRun?: { at: number; freedBytes: number; removed: number };
  nextRun?: number;
}
```

## Evaluation loop
```
on schedule tick (or startup):
  if (!policy.enabled) return;
  report = scanStorage();                        // 21
  if (report.archived.bytes <= trigger) return;
  candidates = oldest archived sessions until target met (by archived_at asc)
  preview = { count, bytes };                    // computed, logged
  for each candidate: Phase-2 safe-delete in `mode`  // 41/42, lock-safe
  record lastRun { freedBytes, removed }; schedule nextRun
```
- Batch policy (no per-session prompt).
- Honors Phase 2 lock safety: if DB busy, defer to nextRun.
- Selection by `threads.archived_at ASC` (oldest first), archived-only.

## Surfacing
- Storage page shows: policy on/off, last-run (freed bytes, count), next-run.
- An auto-run writes a log entry (and optional notification).

## Verification
- Simulate policy on a fixture: correct candidate selection, freed bytes ==
  preview, respects `mode` (quarantine vs permanent), no-op under threshold.
- Disabled policy never acts.

## Open questions
- Per-provider vs global policy? Notify-after-run vs silent+log?
