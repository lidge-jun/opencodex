# A runtime integration roadmap

## Loop specification

- Archetype: spec-satisfaction repair; C3 runtime, C4 proxy credential/recovery boundaries.
- Trigger: owner assigned A (#3672, #3679, #3568, #3581, #3671), authorized inherited parallel subagents, contributor-preserving stacked PRs, no-verify pushes, dev integration and immediate resolved-work closure.
- Goal: preserve transport termination, configured WS egress, native subagent MESSAGE recovery, conversation affinity and effective policy capabilities.
- Non-goals: B/C/D implementation, release promotion/publication, production service/config/credential changes. #3661 remains open unless its complete residual scope is independently proven solved.
- Verification: remote focused activation checks during each implementation cycle; required current-head hosted CI before readiness/merge; final dev ancestry and CI. No local tests, typecheck or builds. Git diff checks and prose validation only locally.
- Stop: all five changes or proven equivalents on dev; original PRs closed with attribution and landing references; fully solved linked issues closed; unresolved issue scope documented.
- Memory: this unit, the session-bound goalplan/ledger, and ignored `.tmp/a-runtime-stack/` evidence.
- Outcomes: DONE / proven NOOP; external blockers recorded, never inferred from ordinary conflicts or pending CI.
- Delegation: main owns FSM, branches, commits, pushes and merges. Plan/review lanes have disjoint file scope. Two distinct failed dispatches return ownership to main; new worker scope is added at P.
- Resource scope: existing git/gh identity, owned `codex/a-*` branches, public contributor PR reads, and existing the isolated remote verification host SSH for isolated verification. No new account credentials or provider requests. User imposed no subagent/model-inheritance budget cap; no model override. Two-hour checkpoint per work phase triggers evidence/reliability reassessment; pending CI is monitored with bounded waits, not abandoned.

## Phase map

| Cycle | Artifact | Consumes | Delivers |
|---|---|---|---|
| roadmap | 000 + 010..060 | live dev and public contributor changes | audited full integration plan; docs only |
| sse | 010_sse.md | existing SSE relay boundary | failure notification independent of tee cancellation |
| ws | 020_ws.md | prior transport baseline | WS outbound policy and pool identity |
| recovery | 030_recovery.md | validated transport stack | MESSAGE recovery + reparse/cache semantics |
| affinity | 040_affinity.md | recovery/reparse fields | stable Command Code conversation identity |
| capabilities | 050_capabilities.md | final effective dispatch behavior | policy selection congruent with dispatch |
| landing | 060_landing.md | independently verified stack layers | current dev inclusion and closeout |

The owner explicitly requested a stack. Independent transport fixes are retained as separate cumulative layers to expose interaction at each head; this publication order is not a claim of a hard dependency between SSE and WS. The actual code dependency is recovery before affinity. Each layer has its own PR diff, regression proof and CI. Bottom-up merge only; retarget before deleting parent branches. Keep stacks short by landing verified lower layers while subsequent cycles continue when possible.

## Ownership

A owns shared `src/server/responses/core.ts` integration for #3568 then #3581. C owns #3576 and may land its separate OAuth replay region first; both lanes refresh dev and preserve each other's changes. B owns `src/config.ts` final field reconciliation with #3679. Source snapshots use `refs/codex/a-original/N`, not remote-tracking scratch refs that concurrent fetch-prune can remove.

## Evidence and provenance

CI entry `.github/workflows/ci.yml` has unrestricted pull_request bases for stacks. `src/**`, `tests/**`, `scripts/**` are observed by its changes job; Linux test shards invoke `scripts/ci/run-bun-test-batches.sh`, gates run tsc/privacy, and macOS/Windows jobs validate platform behavior. These definitions were inspected without executing local suites. Remote-check scripts and real run IDs will be captured at C, not invented at P. Original source changes and review histories are public; any newly discovered security reasoning stays in ignored scratch.

- #3672: `077dd61f66ac80678d071ae8fe516507f43a4264`
- #3679: `b05cccf264b4ab61db5d8dee8232c2f89bb1b541`
- #3568: `036a9321788464fdf33a387c9f44a834a844bdc1`
- #3581: `f60397d3408e0339ffc66acdcaca8133e40866c2`
- #3671: `7b1beb9c5eacd8dde22681a5df26804be52380b8`
