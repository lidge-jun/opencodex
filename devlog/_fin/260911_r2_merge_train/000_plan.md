# 260911 R2 merge train — land #4244, #4248, #4246, #4247 on dev

## Objective

Four open PRs authored on 2026-09-11 (`codex/260911-r2-*`) are each 65 commits behind
`origin/dev` at `18e553a52`. All four were green at their pre-rebase heads, and two of
them have since gone `CONFLICTING`. This unit rebases each onto the current `dev`,
re-proves it, and merges it — one at a time, as a serialized train.

The train is serialized rather than parallel for one concrete reason: #4246 and #4248
both append to `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`. Those two files are sorted registries that
`tests/test-layout.test.ts` and `tests/test-layout-tooling.test.ts` enforce, so two
branches that each add one line to the same sorted block will conflict textually no
matter how trivially compatible the changes are. Rebasing the second one only after the
first is already on `dev` turns a two-sided conflict into a one-sided replay.

## Scope

In scope: the files already touched by the four branches, their conflict resolutions
against `dev`, and this planning unit.

Out of scope: every other open PR (#4256, #4258, #4259 and all third-party PRs), any new
feature work, any promotion of `main` or `preview`, any force-push to a protected
branch, and any edit to another author's branch.

## Authority

The user explicitly authorized rebase, force-push to these four PR branches, and merge
into `dev` in this session. `MAINTAINERS.md` permits a maintainer with `maintain` or
`admin` access to integrate their own PR into `dev` through a PR without a second
approval, provided the decision and exact-head CI evidence are recorded. This document
plus the per-phase records below are that record.

That authority stops at `dev`. It does not cover `main`/`preview` promotion, releases,
branch deletion beyond the merged PR branches, or any other author's work.

## Work-phase map (dependency-ordered)

| Phase | PR | Branch | Pre-state | Doc |
|-------|----|--------|-----------|-----|
| wp1 | — | — | this roadmap | `000_plan.md` |
| wp2 | #4244 | `codex/260911-r2-catalog-pool` | MERGEABLE, clean replay | `010_phase1_pr4244.md` |
| wp3 | #4248 | `codex/260911-r2-pool-account-attribution` | MERGEABLE, clean replay | `020_phase2_pr4248.md` |
| wp4 | #4246 | `codex/260911-r2-client-display` | CONFLICTING, registry-only | `030_phase3_pr4246.md` |
| wp5 | #4247 | `codex/260911-r2-docs-locales` | CONFLICTING, substantive | `040_phase4_pr4247.md` |

Order is cheapest-and-safest first. #4244 and #4248 replay cleanly onto `dev`
(`git merge-tree --write-tree` exits 0 for both, and `dev` has no commits touching their
source files since the merge base), so they land first and shrink the train before the
two conflicting branches are touched. #4246's conflict is a single sorted-registry line.
#4247's is the only one where `dev` and the PR edited the same prose and the same test
oracle, so it goes last, when nothing else is queued behind it.

## Verification protocol (every implementation phase)

Each of wp2–wp5 runs one full PABCD cycle and clears the same gate before its merge:

1. `git rebase origin/dev` on the PR branch, conflicts resolved by hand, PR intent preserved.
2. `bun run typecheck` — exit 0.
3. The PR's own test files, run by path. Whenever `layout.json` or
   `test-layout-expected.json` is in the touch set, add `tests/test-layout.test.ts` and
   `tests/test-layout-tooling.test.ts`; those two are the guards that a hand-resolved
   registry conflict can silently break.
4. `git push --force-with-lease` to that PR branch only.
5. `gh pr checks <n>` green at the exact new head SHA — not at a previous head.
6. A comment on the PR recording the maintainer-integration decision and the exact head
   SHA that CI verified. `MAINTAINERS.md:59-64` permits a maintainer with `admin` or
   `maintain` access to integrate their own PR into `dev` without a second approval, and
   requires that the choice and the exact-head verification be recorded in the PR
   description or a comment. The account driving this train holds `admin`.
7. `gh pr merge <n> --merge` only after steps 5 and 6.
8. `git fetch origin` and re-check the remaining branches' mergeability, because the
   merge just moved the base out from under them.

The merge method is `--merge`, not `--squash`. The repository allows both, but every
recent integration on `dev` is a merge commit (`18e553a52`, `42184ead0`, `6d8ed37ad`,
`5557612d4`, ...) with the branch's individual commits preserved beneath it. Squashing
these four would break that convention and, for #4246, would discard the two review-round
commit messages that explain what the adversarial review changed.

`AGENTS.md` reserves the repository-wide `bun run test` for the PR-ready gate and for
touch sets whose dependencies are not visible to Bun's module graph. Every phase here is
already a published PR, so CI runs the full suite on three platforms at step 5 regardless;
the local runs above exist to catch a bad conflict resolution before it costs a CI cycle.

## Acceptance

DONE when all four PRs are merged into `dev`, each with green required CI recorded at its
own rebased head SHA, and no target PR is left open or conflicting.

BLOCKED if a conflict cannot be resolved without changing what the PR meant, or CI fails
at a rebased head for a reason the rebase did not introduce, and the same blocker survives
three goal turns.

NEEDS_HUMAN if merging requires authority this session does not hold — for example a
branch protection rule that refuses the maintainer self-integration path.
