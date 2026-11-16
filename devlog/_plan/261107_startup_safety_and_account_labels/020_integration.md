# Integration: exact-head review and merge

Depends on implementation and its verification. Re-fetch `origin/dev` and inspect
the union for overlap, especially the separate GUI sweep branch; test the union if
behind or overlapping. Never modify its inline-label background rule.

Use the repository PR template, target `dev`, document exact commands, results and
the full-suite resource exception, and include before/after screenshots via immutable
`pr-assets` commit links. Link the PR to this GOAT thread. The owner explicitly
authorizes push, PR creation and merge. Complete a fresh independent `task.create`
review with role `review` on a model available in `provider.list`; record findings
and fixes, and require PASS on the final head. Inspect and resolve all review threads.
The final fresh reviewer must explicitly review credential-derived identity projection
and masking/privacy boundaries as security review, and its explicit security result
must be recorded with the integration evidence per `MAINTAINERS.md`.

Verify current PR head and require green exact-head `ci` aggregate, `enforce-target`,
`hygiene`, and all full Ubuntu shards on the final head; missing, pending, skipped, cancelled or
older-head results do not count. Include file-size ratchet, all locale parity,
React Doctor, union checks and local validation evidence. If checks/review are
pending, use GOAT PR watch and end the turn; do not poll. Merge only after every
gate holds, with a short maintainer-integration comment and
`gh pr merge --squash --admin --match-head-commit <head>`. Verify the merge and
report PR URL and actual squash SHA via `origin.report`; unwatch at handback.
Apply `ci:full` before the implementation push as required for subprocess and
source-as-data coverage; verify the label and full-lane selection on the exact head.
