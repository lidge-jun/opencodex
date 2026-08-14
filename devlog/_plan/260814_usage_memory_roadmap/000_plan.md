---
title: Usage & Memory Roadmap — P0 through P3
date: 2026-08-14
class: C4
prior-art: "#1008 (closed/unmerged), #1412 (open draft), #1367 (open), #1635 (open), #820 (open), #1217 (open)"
---

# 000 — Objective

OpenCodex has two independent structural problems:

1. **Usage data lifecycle** — a single unbounded `usage.jsonl` that grows forever,
   dashboard reads only the newest 64 MiB tail, and 30d/all-time aggregates silently
   lose data beyond that window (#1497, #1580).

2. **Memory defense before Bun 1.4** — oversized input, continuation compounding,
   provider transport failures, and no process-wide memory coordination mean a single
   bad request or slow client can push RSS to OOM.

This unit implements P0 (memory defense, 5 PRs) and P1 (usage storage, 3 PRs) as a
stacked PR chain. P2 (retention + UI) and P3 (stream coordinator) are documented but
deferred.

## Constraints

- CWD: worktree on `dev` at `/Users/jun/.codex/worktrees/8d76/opencodex`
- Bun 1.3.14 bundled, `MIN_FIXED_BUN_VERSION = null`
- No gui/ changes (P2 scope)
- No docs-site/ changes
- No release automation changes
- Preserve existing dirty state (antigravity-models.ts, 260814_gemini-tiered-wire-ids)
- Push with --no-verify, CI deferred to stack review time
- Local focused tests as verification bar

## Current codebase state (2026-08-14)

| Component | File | State |
|-----------|------|-------|
| Usage writer | `src/usage/log.ts` | Single `appendUsageEntry` → `usage.jsonl`, no rotation |
| Usage reader | `src/usage/log.ts:983` | 64 MiB tail, incremental after first read |
| Usage summary | `src/usage/summary.ts` | In-memory aggregation from parsed entries |
| Usage cache | `src/server/management/usage-summary-cache.ts` | TTL cache over summary |
| Memory watchdog | `src/server/memory-watchdog.ts` | Warn-only, no restart |
| Lifecycle | `src/server/lifecycle.ts` | `drainAndShutdown` exists, `markRecyclingForExit` exists |
| Admission | `src/lib/admission.ts` | Per-host circuit gate, no input-size gate |
| Config types | `src/types.ts:616` (OcxConfig), `src/types.ts:1233` (OcxProviderConfig) |
| Depth cap | `src/integrations/serialize.ts:231` | JSON only (`MAX_JSON_NESTING=1000`) |
| YAML/TOML | `src/integrations/serialize.ts` | No depth cap on YAML write, no YAML/TOML parse cap |
| Continuation | `src/server/responses/core.ts` | previous_response_id expansion, no size admission |
| Stream mode | `src/types.ts:709` | `streamMode: auto|legacy-tee|eager-relay` |
| Provider config | `src/types.ts:1233` | No `upstreamHttpVersion` or `responseDelivery` fields |

## Phase map (dependency-ordered)

```
P0 — Memory defense (independent of each other, stacked for review):
  010  M0-1  Input admission gate           → branch: codex/m0-1-input-admission
  020  M0-2  Continuation overlap removal   → branch: codex/m0-2-continuation-dedup
  030  M0-3  Provider delivery policy       → branch: codex/m0-3-provider-delivery
  040  M0-4  Memory recovery policy         → branch: codex/m0-4-memory-recovery
  050  M0-5  Non-JSON depth cap             → branch: codex/m0-5-nonjson-depth-cap

P1 — Usage storage (U1 → U2 → U3 dependency chain):
  060  U1    Segmented usage writer         → branch: codex/u1-segmented-writer
  070  U2    SQLite projector               → branch: codex/u2-sqlite-projector
  080  U3    Projection-backed API          → branch: codex/u3-projection-api
```

P0 items are functionally independent but stacked for review ordering. P1 items
have real dependencies: U2 consumes U1's segments, U3 consumes U2's SQLite.

## Stack plan (DEV-STACK-01)

The 8 branches form a single review stack:
- Layer 0: `codex/usage-memory-roadmap-docs` (base: `dev`) — this unit, docs only
- Layer 1: `codex/m0-1-input-admission` (base: layer 0)
- Each subsequent branch bases on the one below
- Merge bottom-up after review

Layer 0 exists so every implementation layer can cite its own decade doc from a
base that already contains it. It carries no source change, so it is mergeable on
its own and cannot block the layers above it.

## Verifiers

| Phase | Command | Reads target |
|-------|---------|-------------|
| M0-1 | `bun test tests/input-admission.test.ts` | New test file |
| M0-2 | `bun test tests/continuation-dedup.test.ts` | New test file |
| M0-3 | `bun test tests/provider-delivery.test.ts` | New test file |
| M0-4 | `bun test tests/memory-recovery.test.ts` | New test file |
| M0-5 | `bun test tests/nonjson-depth.test.ts` | New test file |
| U1 | `bun test tests/usage-segmented-writer.test.ts` | New test file |
| U2 | `bun test tests/usage-sqlite-projector.test.ts` | New test file |
| U3 | `bun test tests/usage-projection-api.test.ts` | New test file |
| All | `bun run typecheck` | Whole project |

## SoT sync target

`structure/` — update if architectural boundaries change. No current architecture
doc covers the usage subsystem or memory coordination.

## Out of scope

- gui/ dashboard changes (P2)
- docs-site/ updates
- Release automation
- Bun upgrade (P4)
- Stream timeline / TurnScope / one-reader relay (P3, documented only)
- WebSocket upstream (#1608, Bun 1.4 gated)
