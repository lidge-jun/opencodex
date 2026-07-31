# 01 - Revised roadmap (external GPT-Pro review folded in)

An external code-level review of feat/kiro-on-dev vs kiro-gateway reprioritized
the work toward functional hardening. User direction: multi-account failover is
OUT of scope; push functional hardening harder.

## Status

- Phase 10 native images: DONE (commit 494be0d, 5 tests, tsc + 23 tests pass).

## Revised phase order (P0 first)

| Phase | Tier | Surface | Source |
|-------|------|---------|--------|
| 70 | P0 | Stream exception/error is TERMINAL - stop parsing, no `done` after an upstream exception frame. | review 2.2 / P0-1 |
| 80 | P0 | Kiro-specific HTTP retry/backoff: refresh-on-401/403, 429/5xx exp backoff + jitter, first-token retry (pre-first-byte only), abort upstream on client disconnect. | review 1.7 / 2.3 / P0-2 |
| 90 | P0 | OAuth singleflight refresh + SQLite reload-before-refresh + busy-timeout; API-region vs runtime-region split. | review 2.4 / P0-3 |
| 100 | P0 | Resume / tool-result correctness: E2E matrix for tool-call continuation and compact/resume; repair orphaned tool results in current-turn-only payloads. | review 1.5 / 2.5 / P0-4 |
| 110 | P0 | Eventstream decoder hardening: frame-size cap, header-length bounds, per-header read bounds, malformed-frame fuzz tests. | review 2.1 / P0-5 |
| 120 | P1 | Tool schema sanitization (drop empty required, additionalProperties), long-description handling, orphaned/no-tools fallback. | review 1.4 / P1-2,3 |
| 130 | P1 | Model list/resolver: versioned-slug normalization, max effort advertise, missing official models reconciled. | review 1.2 / P1-4,5 (folds old Phase 50) |
| 140 | P1 | Kiro-specific error mapping: auth/region/quota/model-unavailable to actionable Codex errors. | review 3.5 / P1 |
| 150 | P2 | Truncation detection/recovery. | review 1.4 / P2 (folds old Phase 60) |
| 160 | P2 | Tag usage as estimated + calibration fixtures; debug observability. | review 3.1 / P2 |

## Superseded earlier stubs

- Old Phase 20 (retry) -> Phase 80 (expanded).
- Old Phase 30 (payload guard) -> folded into Phase 100/120 request shaping.
- Old Phase 40 (thinking parse-back) -> P2 follow-up; deprioritized below correctness/hardening.
- Old Phase 50 (model normalization) -> Phase 130.
- Old Phase 60 (truncation) -> Phase 150.

## Discipline unchanged

One full PABCD cycle per phase. Each closes with bun x tsc --noEmit + targeted
bun test and one atomic commit. Independent verifier dispatch per phase.
