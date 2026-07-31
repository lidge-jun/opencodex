# 95 — Verification matrix

| Phase | Surface | Risk | Verification | Evidence |
|---|---|---|---|---|
| 1 | scanner module (21) | C2 | unit: bucket bytes/count vs du/find; read-only invariant (mtime/inode unchanged) | tests/storage-scanner.test.ts |
| 1 | /api/storage (31) | C2 | integration: success envelope (no error) + forced-failure fallback envelope | tests + manual curl |
| 1 | Storage.tsx + nav (32) | C2 | `cd gui && bun run build` passes; manual nav render; no delete control | build log |
| 1 | fixtures (33) | C2 | fixture round-trips; lock-safe null counts | tests |
| 2 | delete reconciliation (41) | C4 | all-or-nothing: JSONL quarantined + threads row updated + edges handled + manifest; SQLITE_BUSY no-op | tests + manual on copy |
| 2 | quarantine/restore (42) | C4 | quarantine→restore byte-identical; default mode never unlinks; retention purge correct | tests |
| 3 | policy engine (51) | C4 | fixture sim: selection/freed-bytes/preview parity; disabled = no-op; lock defers | tests |

## Global gates per phase
- `bun x tsc --noEmit` clean.
- Targeted `bun test tests/...` green.
- Atomic commit per surface.
- C4 phases (2/3): independent reviewer + full test suite before ship; quarantine
  default; never delete active sessions; lock-safe.
