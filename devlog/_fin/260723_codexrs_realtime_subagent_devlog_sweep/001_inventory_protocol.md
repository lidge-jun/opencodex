# 001 — Research: live-evidence classification protocol

## Rule

Do **not** trust a plan doc that merely says "done". Require live signals.

## Classification labels

| Label | Meaning | Move? |
| --- | --- | --- |
| FINISHED | Terminal close-out exists and residual work is absent or explicitly out-of-band | YES → `_fin/` |
| ACTIVE | Explicit remaining work, open checklist, deferred core task, or ongoing issue/PR work | NO |
| AMBIGUOUS | Mixed signals; finish claim without residual proof or residual claim without active files | NO (list) |
| STUB | Empty dir or tiny non-unit file with no content | YES if empty/no content and no destination conflict; else AMBIGUOUS |

## Evidence hierarchy (highest first)

1. Explicit terminal close-out file in-unit (`*closeout*`, `999_status`, `100_merge_records`, loop DONE summary) naming outcome DONE/NOOP and commits/CI.
2. Measured residual work statements ("DEFERRED", "kept in _plan", "open issues", "not started", checklists with unchecked remaining steps).
3. File-system shape: empty dir, stub file, full decade docs with only plans and no close-out.
4. Cross-check against `_fin` destination existence (clobber risk).
5. Nested git trees / chase corpora are NOT plan units unless they are pure plan docs.

## Decision procedure per entry

1. List files.
2. Read latest 1–3 numbered docs tails + any status/closeout.
3. Search for residual markers: `DEFERRED`, `TODO`, `remaining`, `kept in _plan`, `open`, `WIP`, `not started`.
4. Search for terminal markers: `DONE`, `READY`, `MERGED`, `archived`, `close-out`.
5. If terminal AND no residual core work → FINISHED.
6. If residual core work → ACTIVE.
7. Else AMBIGUOUS.

## Unsafe moves

- Destination already exists under `_fin` with different content.
- Unit still referenced as active worktree plan for unfinished product work with residual checklist.
- Nested repository (`opencode-cursor`, `_chase/_cca`) — never auto-move whole nested git unless user explicitly asks.


## Amendment A1 — Named residuals vs unfinished core work

A unit may be FINISHED even if it lists deferred residuals, when ALL are true:

1. An explicit terminal outcome exists (`DONE` / release results / merge-readiness close).
2. Residuals are labeled deferred/out-of-scope/follow-up, not unchecked required tasks for this unit.
3. No decade doc remains as an unexecuted required work-phase for the same unit objective.

Counter-examples from live re-read (2026-07-23):

- `260723_issue_fixes/040_loop_closeout.md` names DONE + deferred GUI residual → FINISHED allowed.
- `260701_codex-catalog-split/999_status.md` "kept in _plan" + deferred split → ACTIVE.
- `500_storage-page-session-cleanup/90_open-questions.md` unchecked phase questions → ACTIVE.
- `260722_pr_review_strategy/050_final_verification.md` is an empty checklist without results → not enough for FINISHED.
- `260722_star_surge_triage/040_gui_blocked_longterm.md` still tracks residual open PRs/issues → ACTIVE unless a later closeout proves the unit ended.
