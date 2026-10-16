# wp4: PR gates and issue/PR closeout

## Change and PR shape

Two ordinary `dev` PRs carry this lane, each with its own gate. Neither is a native stack.

- **PR-1 (closes wp1):** branch `codex/t4-account-pool-pause` with the audited #6087 carry, its review fixes, docs/tests and this lane record. Trailer: `Co-authored-by: chilung-cgu` with the donor commit email. It merges as soon as its own gate passes and does not wait on wp3.
- **PR-2 (closes wp3):** branch `codex/t4-account-pool-auth-rotation` cut from `dev` after PR-1 merged, with the Antigravity 401/validated-403 slice. Trailer: `Co-authored-by: MerryEcho` with the donor commit email. It is opened only if the wp3 audit and security review pass.

Before each push, fetch latest `origin/dev`, rebase without overwriting another branch, inspect the union for file-size ratchet and closed unions/locales/counts, and rerun that PR's affected tests. Summary/Verification/Checklist follow `.github/PULL_REQUEST_TEMPLATE.md`. PR-1's GUI screenshot is uploaded to the separate `pr-assets` branch at a commit SHA and linked in the description, never committed on the lane branch.

## Per-PR gate

- **Tests.** PR-1 runs the focused files from [010_pause.md](010_pause.md) plus the hard-lock/reset-credit files; PR-2 runs those from [030_auth_failover.md](030_auth_failover.md) plus the pause selection files it consumes. Each also runs `bun run test:changed` from a same-commit `/private/tmp/t4-account-pool-verify` checkout, `bun run typecheck`, `bun run privacy:scan`, `bun run structure:check` and `bun run skill:surface:check`; PR-1 adds `bun run lint:gui` and `bun run build:gui`. Record each command, exit and counts. If a full local `bun run test` is disproportionate during seven concurrent lanes, say so and rely on the actual hosted CI; never describe an unrun suite as passing. Never bypass the test cleanup guard under `~/.codex`.
- **Base.** `origin/dev` must be an ancestor of the PR head at merge time; otherwise rebase and revalidate.
- **Review.** An explicit independent auth/security review, and correct Codex/CodeRabbit findings resolved. An open correct finding blocks self-integration.
- **CI.** Inspect required checks by head SHA, event, run id/attempt and job conclusions. Missing, skipped, cancelled, approval-blocked, pending and old-head results are not success. Record the maintainer-integration decision; never push directly to `dev`.
- **After merge.** Read back the merge SHA, dispatch `ci.yml` on `dev`, confirm the run's head SHA equals the merge SHA and that it succeeds, and repair any regression from this lane. A PR whose CI fails and cannot be repaired stays open and unmerged with a status comment.

## GitHub disposition writes

After PR-1 is on `dev`: thank chilung-cgu and close #6087 as fully carried, linking PR-1 and the `dev` SHA; comment on #6013 that generic pause landed and why the Anthropic pool pause and per-account threshold remain a separate slice.

After the PR-2 outcome: if it merged, thank MerryEcho on #5099, state that only the bounded Antigravity pre-output slice landed, keep #5099 open for its persistent health/recovery proposal, and explain why the dynamic 15-rotation cap was not taken; comment on #3375 with the link and the remaining items. If PR-2 was not opened or not merged, post a hold comment on #5099 naming the concrete blocker and leave #3375 unchanged apart from a status note.

Independent of either PR: leave #5956, #5879 and #3738 open with specific English hold comments, avoiding duplicates if another lane already changed their premise. Comment on the remaining lane issues (#5649, #5616, #5561, #4961, #4869, #3376) with the concrete reason and the next evidence needed. #4878 gets its P1 comment in wp2 and stays open without a controlled both-exhausted fix. #3375 and #3376 are umbrella issues and remain open unless every recorded requirement is demonstrably on `dev`.

Read back every posted comment/state and record links. If a source author materially updates a held head during this lane, re-evaluate before posting a stale verdict.

## Final report

Give merged PR numbers and `dev` merge SHAs; for each candidate state as-is/cherry-pick/squash/batch/reimplementation/hold; link closed source PRs/issues and hold comments; list local commands/results and exact-head/merge CI run URLs; name residual client, security or provider behavior that was not proven and files likely to collide with other lanes.

## Outcome (2026-09-28)

| Item | Disposition | Link |
| --- | --- | --- |
| #6087 | Squash carry with review fixes, merged as #6106 (`555ef68ac6`); closed with thanks | https://github.com/lidge-jun/opencodex/pull/6106 |
| #5099 | Narrow 401 slice reimplemented in #6132 (`ae6b0ba913`); left open for 403 rotation and the health proposal | https://github.com/lidge-jun/opencodex/pull/5099#issuecomment-5859390311 |
| #5956 | Hold | https://github.com/lidge-jun/opencodex/pull/5956#issuecomment-5858444723 |
| #5879 | Hold | https://github.com/lidge-jun/opencodex/pull/5879#issuecomment-5858134423 |
| #3738 | Hold / split | https://github.com/lidge-jun/opencodex/pull/3738#issuecomment-5858443616 |
| #6013 | Open: Anthropic pause and threshold | https://github.com/lidge-jun/opencodex/issues/6013#issuecomment-5859358304 |
| #5649 | Open | https://github.com/lidge-jun/opencodex/issues/5649#issuecomment-5858444444 |
| #5616 | Open | https://github.com/lidge-jun/opencodex/issues/5616#issuecomment-5858444200 |
| #5561 | Open | https://github.com/lidge-jun/opencodex/issues/5561#issuecomment-5858443864 |
| #4878 (P1) | Open, needs-info matrix | https://github.com/lidge-jun/opencodex/issues/4878#issuecomment-5858134108 |
| #4961 | Open | https://github.com/lidge-jun/opencodex/issues/4961#issuecomment-5858134763 |
| #4869 | Open | https://github.com/lidge-jun/opencodex/issues/4869#issuecomment-5858135029 |
| #3375 | Open umbrella, progress noted | https://github.com/lidge-jun/opencodex/issues/3375#issuecomment-5859390458 |
| #3376 | Open for initial activation | https://github.com/lidge-jun/opencodex/issues/3376#issuecomment-5858443335 |

The coordinator changed the merge gate mid-train. Per-PR hosted CI was replaced by local union verification, and the single Cross-platform CI run on the final `dev` belongs to the coordinator. #6106's earlier head `2c7aa23bf4` had every hosted check green before the last rebases. No issue was closed, because none is fully resolved by these changes.
