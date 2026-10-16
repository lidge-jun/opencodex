# wp6 — CI closure

For each lane PR: rebase onto the latest `origin/dev` when it moved or conflicts, push with
`--force-with-lease` to the lane's own branch only, then confirm Ubuntu CI on the exact head:
`gh pr view <N> --json headRefOid,statusCheckRollup` and
`gh run list --commit <sha> --json databaseId,event,status,conclusion,workflowName`.
The full expected set of PR checks must appear on the exact head and pass: typecheck, the
four test shards, gates, hygiene, enforce-target, and desktop shell. A required check that
never appears is missing evidence, not a pass. The coordinator dispatches the manual
Windows/macOS runs once at the end, so those are out of this lane.
Pending, skipped, cancelled, or older-head results are not green. A failing leg is diagnosed
from its job log (`gh api repos/lidge-jun/opencodex/actions/jobs/<id>/logs`) and fixed inside
the lane's write scope, or reported to the coordinator when the cause is outside it.

## Outcome (2026-09-28)

| Item | PR | Final head | Merged as | Notes |
|---|---|---|---|---|
| #6130 + #6131, Closes #6118 | #6171 | 4746a53645 | fddd1da4e4 | Codex P2 fixed: count cap before byte demotion, header-only usability check |
| #6121 | #6174 | fb5be52704 | 513f02f085 | Added auth-mode and PATCH base-URL API tests; security-review item flagged |
| #6150 | #6175 | fa69f3e0b6 | ea5c90814f | Codex P2 fixed: projection moved before vision preprocessing |
| #5964 | #6177 | 45f7177d84 | 0a1d87eb35 | Late-input echo fix (bounded); Codex P2 fixed: orphaned block on queue flush |
| #5539 | none | — | — | Dropped (050) |

Every PR's full check set passed on its final head before merge (four test shards, gates,
structure gate, docs site build, docker smoke, npm-global, desktop shell, enforce-target, ci).
Local tests were frozen by maintainer order partway through the train, so the review-fix
commits were verified by CI only.
