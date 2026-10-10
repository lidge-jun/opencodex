# Phase 1 (wp2): review and land the ten PRs

## Review lane per PR

One independent `gpt-6.1-sol` leaf reviewer per PR, each in its own detached worktree at
`.tmp/prs/pr-<n>` (gitignored). Reviewer output: verdict (MERGE, MERGE_AFTER_FIXES,
REIMPLEMENT, DO_NOT_MERGE), findings with path:line, security verdict, exact-head CI
evidence, rebase onto `origin/dev`, focused tests, file-size ratchet and test-layout guards
when relevant, `bun run typecheck`, and prepared local fix commits. Spawns are staggered
because a burst of eleven hit HTTP 429.

## Landing procedure

1. Main reads each verdict and checks the cited spans that decide it.
2. MERGE: confirm the head SHA is unchanged, required checks completed successfully on that
   head, no outstanding maintainer `CHANGES_REQUESTED`; run
   `scripts/ci/assert-mergeable-review.sh --maintainer-integration <n>` immediately before the
   merge to revalidate the live actor permission and the PR's current `dev` base; for the
   security-review PRs in `000_plan.md`, require a recorded PASS security verdict; post the
   integration comment; `gh pr merge <n> --squash --admin --match-head-commit <sha>`.
3. MERGE_AFTER_FIXES: push the reviewer's fix commits to the PR branch when
   `maintainerCanModify` is true, wait for exact-head CI, then step 2. Otherwise open a
   maintainer PR carrying the commits with a `Co-authored-by` trailer and close the
   original with a link.
4. REIMPLEMENT: same as the maintainer-PR path in step 3.
5. DO_NOT_MERGE: post a review comment with the concrete reason and leave it open.

## Union risks between the ten

User steering (2026-09-30): Cross-platform CI runs once, on the final `dev` tip, and must be
made green there. Per-PR Cross-platform runs are not waited on; ones triggered by maintainer
pushes are cancelled. The per-PR merge gate is the reviewer's local rebase evidence plus a
local integration merge onto the current `origin/dev` with `bun run typecheck` and
`bun run test:changed` passing. Existing exact-head runs are cited when they exist.

Merge sequentially. After each merge, re-check `mergeable` for the rest. Before merging a PR
that touches a file listed in `tests/fixtures/file-size-baseline.json` or adds a test file,
rebase it on the new tip and rerun the ratchet and layout guards; two PRs can each fit a cap
and overflow it together.

`mergeable` alone does not prove the union compiles. For each PR after the first, merge it
locally onto the current `origin/dev` tip and run `bun run typecheck` plus its focused tests,
and check for exhaustive unions, registries, locale catalogs and hand-written counts that
another landed PR changed (`AGENTS.md`, "Anything exhaustive over a union").

## Acceptance

Each PR is merged with review and CI evidence, or open with a posted reason.
