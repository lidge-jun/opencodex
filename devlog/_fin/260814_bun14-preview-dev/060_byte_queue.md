# 060 — Exact byte queue + global relay budget

## Files

### MODIFY: src/server/relay-eager.ts
Replace approximate `queuedBytes = 0` in pull() with explicit queue:
- Producer pushes to Array<Uint8Array> instead of controller.enqueue
- pull() dequeues one chunk, decrements per-stream + global counters
- Per-stream cap: 8 MiB (unchanged)
- Global process cap: 64 MiB (new)
- Producer pauses reader.read() when either cap hit
- cancel/error/finally releases all remaining reservation

### NEW: src/server/relay-budget.ts
Global relay byte budget singleton:
- reserve(bytes): boolean
- release(bytes): void
- metrics(): { active: number, peak: number }

### MODIFY: tests (relay tests)
- 1-byte slow consumer test
- 32+ concurrent slow consumers
- Queue full then cancel
- Global budget exhaustion

