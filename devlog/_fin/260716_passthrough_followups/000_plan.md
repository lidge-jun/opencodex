# 260716 Passthrough follow-ups — plan MOC

## Context

Born from the v2.7.21 release train (`devlog/_fin/260716_release_2721/`, same-day):
PR #136 (`fef332c4`, MustangRider) fixed the Anthropic native passthrough so the
`connectTimeoutMs` deadline covers ONLY the wait for response headers and is cleared
once headers arrive; our hardening commit `d83db031` extracted `fetchWithHeaderDeadline`
(src/server/claude-messages.ts) with a `finally`-guaranteed `clear()` so the reject
path cannot leak the timer. The release audit (sol reviewer, VERDICT GO-WITH-FIXES)
surfaced three residual items. This unit turns them into diff-level implementation
docs; NO code changes ship from this unit itself.

## The three items (dependency-ordered phase map)

| Phase | Doc | Item | Class |
|-------|-----|------|-------|
| 1 | `010_body_occupancy_design.md` | Bound response-body occupancy on the Anthropic native passthrough (idle + size, never total-time) | C3 design |
| 2 | `020_workflow_path_sync.md` | `service-lifecycle.yml` trigger paths miss `src/cli.ts` that `release.yml`'s gate regex checks | C1 one-liner |
| 3 | `030_timeout_fallback_unification.md` | claude-messages.ts falls back to `?? 120_000` while the repo-wide documented default is `200_000` | C1 one-liner |

Phases 2 and 3 are independent of 1 and of each other; ordering is by risk review
depth, not dependency. Each phase is one PABCD cycle when implemented.

## Timeout-history constraint (LOAD-BEARING for phase 1)

Verified from git history — the repo has repeatedly RAISED patience because slow
first tokens / long generations are legitimate:

- `b62a1450` "fix(timeout): raise provider connect/stream timeout to 100s" — Kiro
  event-streams held the connect timeout open for the whole response; long
  generations aborted at 30s. 30_000 → 100_000.
- `1496b932` "feat(anthropic): improve prompt caching and provider timeouts" —
  provider timeout consolidation era; the documented repo default became 200_000
  (`src/types.ts:420-421` (comment at :420, property at :421): "Connect timeout (ms) for upstream fetch — covers DNS, TCP,
  TLS, and response header. Default 200000.").
- PR #136 exists precisely because the OLD passthrough kept `AbortSignal.timeout`
  attached through the body, killing legitimate long streams at the deadline.

**Design law derived:** any body-occupancy bound MUST be inactivity-based
(silence kills, progress keeps alive) and/or size-based. A total-wall-clock body
cap is FORBIDDEN — it re-introduces the exact bug class the history above kept
paying down. Precedent already in-repo: `stallTimeoutSec` (default 90) on the
/v1/responses adapter path measures upstream silence, not duration.

## Out of scope

- Implementing any of the three items (this unit is docs-only; implementation
  phases run later, one PABCD cycle per decade doc).
- Touching the /v1/responses adapter path timers (already covered by
  `stallTimeoutSec`); phase 1 targets ONLY the native Anthropic passthrough.

## Verification plan for this unit

- Every mechanism claim carries a `path:line` anchor verified against the working
  tree at `a6db6cc4`-era dev (post-v2.7.21).
- Sol explorer research (agent Volta) grounds 010; sol reviewer audits the unit
  before it is committed as final (A-gate).

## Implementation evidence (2026-07-16, unit closed)

- 030 → commit `03798a81` (fallback 120s→200s; tsc + 16/16 endpoint tests; Kuhn PASS).
- 020 → commit `dd5fff89` (src/cli.ts in both paths blocks + PR/push path-set
  equality contract test; ci-workflows 5/5; Kuhn PASS).
- 010 → commit `0b006b66` (idleDeadline primitive with pause() — audit round 3 High:
  timer runs ONLY while a read is pending; tap guard + Anthropic error tail +
  deterministic client-cancel classification on BOTH stream and non-stream paths —
  audit round 4 blocker folded; closeReason += body_stall|body_overflow in
  request-log AND usage/log; config bodyStallSec=90/bodyMaxBytes=64MiB adopted as
  recommended; A1-A6 activation tests + adapter-fixture terminal proof).
- Full suite post-implementation: 2590 pass / 0 fail (242 files).
- Audits: sol reviewer Kuhn rounds 1-4 (PASS, PASS, GO-WITH-FIXES(2H) folded,
  GO-WITH-FIXES(1) folded).
