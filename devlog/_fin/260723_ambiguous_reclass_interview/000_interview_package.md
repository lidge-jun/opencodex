# Interview tracker — AMBIGUOUS/devlog reclass + _fin move

- Session: `019f8e04-4172-7260-982d-891794bdbd98`
- Updated: 2026-07-23T08:43:16.335734Z
- Mode: Clarification
- Loop archetype: **spec-satisfaction** (subagent-verified residual classification defines done)

## Settled answers

1. Finish policy evolved through conflict resolution to **HYBRID** (final).
2. Branch: use existing dev worktree `/Users/jun/.codex/worktrees/f655/opencodex` (HEAD `dd8eda0f`, ahead origin/dev 3). Do **not** switch the main preview checkout.
3. Target set: **all current `_plan` units on that worktree** (measured 12 units at interview close).
4. Residual handling: core residual blocks move; deferred polish may move with residual memo (`residual-active.md`); no new ACTIVE folders required.
5. Verification: subagents must verify core residual-0 before any move.

## Dimension readiness

| Dimension | Score | Knowns |
| --- | --- | --- |
| Goal | 3 | Reclassify whole `_plan` on f655/dev; move only hybrid-eligible units to `_fin`; record residuals. |
| Constraint | 3 | Work in f655; no product code; no push; no clobber; nested git never move; main preview checkout untouched. |
| Success criteria | 3 | Core residual blocks; deferred polish + memo ok; subagent verification required; inventory+move log+residual memo are evidence. |
| Ontology | 3 | Labels KEEP / MOVE_WITH_MEMO / BLOCKED; unit residence `_plan` vs `_fin`; residual-active.md central memo. |

## Core vs deferred rubric (settled for Plan)

**Core residual (KEEP in `_plan`, never move):**
- Required implementation still pending/unimplemented
- Explicit open queue that is the unit's purpose (open PR/issue triage still in flight)
- Empty verification checklist with no measured results when unit claims done
- Plan-only unit with no execution evidence

**Deferred polish (MOVE + residual memo allowed):**
- Named out-of-scope residual
- Follow-up GUI / docs polish after code landed
- Accepted known limitation
- Live smoke deferred when unit already has code+test evidence

## OPEN ASSUMPTIONS (recorded, non-blocking)

1. Interview/session tracker remains under main repo `.codexclaw/`; file moves execute in f655 worktree.
2. Destination collision => skip + report, never overwrite.
3. Historical internal contradictions in old plan docs are classification inputs, not interview blockers.
4. Current main checkout stays on `preview` during Plan/Build.

## Scan rounds

- R1–R3: branch/policy conflicts surfaced and resolved by later answers.
- R4: package settled; remaining items are Plan operationalization + per-unit subagent verification.

## Next

Await user fork: Proceed to Plan / more questions / pause.


## User proceed (2026-07-23T08:44:01.239173Z)

User answered `처리해` — treat as Proceed to Plan/execute under settled package.
