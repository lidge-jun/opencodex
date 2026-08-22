# 040 — Memory comparison harness

## Files

### NEW: scripts/runtime/compare-bun-memory.ts
Wave-based A/B memory comparison script:
- Waves: startup, SSE-normal, SSE-slow, SSE-abort, error-bodies, worker, HTTP/2, WebSocket, restart, idle-recovery
- Records: rss, heapUsed, heapTotal, external, arrayBuffers, app-owned retained
- Hard correctness gate: crash/hang/timeout, leaked turns/workers/reservations/budget
- Comparison gate: wave-by-wave idle median slope analysis

