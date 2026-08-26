# 000 — bun14-preview-dev: Plan

## Objective

Build preview-dev = dev + Bun 1.4 product candidate stack. When Bun 1.4.0
ships to npm, the only change is dependency version bump — all compatibility
patches, CI qualification, and memory/stream/worker improvements are already
landed and verified on the canary.

## Loop-spec

- Loop archetype: spec-satisfaction (CI green + typecheck + memory gate)
- Write scope: src/, .github/, scripts/runtime/, tests/, devlog/, package.json, bun.lock
- Out of scope: npm publish, release.yml preview-dev gate, main/preview promotion, Go runtime, gui/
- Budget: unbounded token, sol medium subagents

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| 1 | 010 | CI composite action + preview-dev qualification | — |
| 2 | 020 | Bundle Bun 1.4.0-canary.1 | — |
| 3 | 030 | Runtime provenance recording | 020 |
| 4 | 040 | Memory comparison harness | 020 |
| 5 | 050 | Stream caps revision gate | 020 |
| 6 | 060 | Exact byte queue + global relay budget | 050 |
| 7 | 070 | Fetch body cancel on retry/failure | 020 |
| 8 | 080 | Worker settle skip on Bun 1.4 | 020 |
| 9 | 090 | Isolate teardown proof | 080 |
| 10 | 100 | Promotion + rollback docs | all |

## Accept criteria

- c-ci-sot: No hardcoded bun-version in .github/workflows/ (grep returns empty)
- c-bundle: package.json bun=1.4.0-canary.1, typecheck clean
- c-provenance: qualified-bun.json + runtime test pass
- c-memory: compare-bun-memory.ts exists with wave definitions
- c-stream-caps: bunHasAsyncPullCancelFix returns true for verified revision
- c-byte-queue: Explicit queue + per-stream/global caps in relay
- c-fetch-cancel: disposeResponseBody in all error paths
- c-worker: storageWorkerOsJoinSettleMs returns 0 for qualified Bun 1.4
- c-isolate: CI has consolidated + split forms
- c-docs: Promotion doc with rollback steps
