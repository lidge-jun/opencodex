# 260724 SSE Hardening — 000 Master Plan

Session: 019f916a-afed-7b10-a421-c489509d4bb9 (HOTL goal loop, goalplan slug
`opencodex-dev-branch-hardening-loop-hotl-track-a`).
Base: `dev` @ 5157c490 (post bugfix-train, post #350/#359/#362/#364).

## Objective

Make the SSE/streaming pipeline fail truthful: no truncated or corrupted
upstream stream may surface as a clean completion on any downstream surface
(Responses SSE, Chat Completions SSE, Claude Messages, WebSocket), terminal
semantics must be exactly-once, and replay state must match what the bridge
claims to cache.

## Loop spec

- Loop archetype: spec-satisfaction repair (verifier defines done).
- Trigger: post-bugfix-train stability audit (WP0 research, docs 001/002).
- Goal: users never see a truncated/corrupted upstream turn reported as
  success; terminal events fire exactly once per turn.
- Non-goals: Windows runtime relay rewrite (class 10), retry-commitment
  policy change (class 13), replay-state eviction policy change (class 14),
  partial non-empty terminal reconstruction (class 6), PR #363's tool-arg
  duplication (class 8 — triage track owns it).
- Verifier: `bun run typecheck` + focused test files per phase; full
  `bun run test` before any dev push.
- Stop condition: all five decade docs executed with green C gates.
- Memory artifact: this unit folder + goalplan ledger.
- Expected terminal outcomes: DONE (all phases landed), BLOCKED (external
  dependency), NEEDS_HUMAN (policy conflict).
- Escalation: GUI changes out of scope — none planned; if a phase discovers
  a GUI surface need, stop and amend.
- HOTL resource bounds: local repo + gh read for issue cross-references;
  no push during implementation cycles (push decision belongs to the user);
  wall-clock unbounded, commit-per-step.

## Instability classes (from 002_instability_classes.md)

In scope: 1 (Google false completion), 2 (Anthropic early-EOF false
completion), 3 (finish_reason/stopReason loss), 4 (Chat stall/eof -> clean
[DONE]), 5 (incomplete not cached), 7 (double terminal), 9 (no
backpressure), 11 (keepalive/stall inconsistency), 12 (abort race).

Out of scope (with reasons in 002): 6, 8, 10, 13, 14.

## Dependency-ordered work-phase map (PHASE-SPLIT-01)

| Phase | Doc | Content | Why this order |
|-------|-----|---------|----------------|
| 1 | 010_phase1_adapter_terminal_truth.md | Google/Anthropic/openai-chat emit truthful terminal events + stopReason preservation; bridge stopReason mapping | Foundation: every downstream consumer trusts AdapterEvent terminals; fixing surfaces before adapters would mask, not fix, false completions |
| 2 | 020_phase2_bridge_terminal_singleness.md | Bridge emits exactly one terminal; replay state caches incomplete (matches bridge comment) | Core capability: consumes Phase 1's truthful terminals; state contract must hold before surfaces rely on it |
| 3 | 030_phase3_chat_incomplete_fidelity.md | Chat outbound maps stall/eof incompletes to error frames, not clean [DONE] | Integration surface: depends on Phase 2's terminal contract |
| 4 | 040_phase4_heartbeat_stall_consistency.md | SSE comment keepalives count as adapter activity; dead heartbeat relay resolved | Hardening: stall tuning is safe only once terminals are truthful (Phases 1-3) |
| 5 | 050_phase5_backpressure_abort_race.md | Pull-based/backpressure-aware bridge + chat outbound; cancelBodyOnAbort in generic adapter path | Hardening: restructures consumption loops — must land last so earlier phases pin behavior it must preserve |

Each phase = one full PABCD cycle. Never two decade docs in one B.

## Sequencing dependencies (A-gate amendment, round 1 FAIL -> fold)

- Phases 1-2 (010/020) touch google/anthropic/openai-chat adapters, bridge,
  state: no overlap with open PRs. They may start immediately.
- Phases 3 and 5 touch src/chat/outbound.ts and src/server/responses/core.ts,
  which open PRs #363 (chat/outbound + its tests) and #352 (core.ts) also
  modify. Dependency: the triage track must DECIDE #363 and #352
  (merge/close) and the working tree must be rebased on the resulting dev
  BEFORE phase 3 and phase 5 enter B. After either PR lands, re-audit the
  affected decade doc against the new tree (stale check) before building.
- #360 touches openai-responses.ts only: no conflict with any phase.
- If triage DEFERs #363 or #352, phases 3/5 proceed on current dev and the
  deferred PR is re-evaluated against the post-phase tree.

## Cross-track note

Track B (PR triage) runs interleaved as separate work-phases; #363 (class 8)
is decided there, not re-implemented here.
