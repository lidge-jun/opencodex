# 36-PR lane-stack merge into dev

## Objective

Land every open lidge-jun-authored pull request on `dev` today, then close the
issues those PRs actually resolve. 36 PRs as of 2026-09-13, with `origin/dev`
at `7ca00ffe7c1299e80d650a3243b2bc7cf09109ad` when this roadmap was written.

Lane preparation is delegated to worktree-backed Codex threads. Merging is not:
the main session performs every merge itself and records maintainer integration
per MAINTAINERS.md.

## Why lanes

A strictly sequential merge is not reachable in one day. Hosted CI costs 10-15
minutes per pull request, so 36 serial gates alone exceed seven hours before any
conflict work. Lanes cut that two ways: lanes prepare in parallel, and within a
lane only the tip pays for CI.

Lanes are grouped by dominant file domain, not by disjoint file sets. An audit of
the live file lists found real cross-lane overlap in wave 1: S4 and S5 share
`src/server/auth-cors.ts`; S4 and S6 share `gui/src/api.ts`,
`src/server/index.ts`, and `src/server/ws-bridge.ts`; S4 and S2 share
`gui/src/pages/ApiKeys.tsx`, the API-keys workspace component, and
`tests/server/api-key-attribution.test.ts`; S5 and S6 share `src/config.ts`
and two config/policy test files.

That overlap does not break parallel preparation, but it does mean lanes cannot
be merged blindly. Lanes merge one at a time, and the next lane re-merges
`origin/dev` at its tip and re-runs its tip CI before it is merged. The
shrinking-diff property still holds inside a lane; across lanes the tip
re-merge is what absorbs the overlap.

## CI economy

Each lane is a cumulative stack. The bottom branch merges `origin/dev`; each
branch above merges its parent's resulting commit. Every branch therefore
contains its ancestors, so merging bottom-up produces diffs that shrink as the
lane lands.

Every non-tip branch is pushed with `[skip ci]` in its head commit subject.
Only the lane tip runs hosted CI, and that tip run is the merge gate for the
whole lane.

This works because of how `ci.yml` is triggered. It declares `pull_request: {}`
plus a `push` trigger pinned to `[main, preview, dev]`. A push to a
`codex/*` branch never triggers it directly; the run comes from the
`pull_request` synchronize event, and GitHub suppresses `push` and
`pull_request` runs when the head commit subject carries `[skip ci]`.

Three workflows still run because they use `pull_request_target`, which
`[skip ci]` cannot suppress: `enforce-pr-target`, `pr-hygiene`, and
`pr-labeler`. All three complete in under a minute, so they cost nothing worth
optimizing, and they are the checks that keep the PR descriptions honest.
`react-doctor`, `service-lifecycle`, and `issue-quality-tests` use plain
`pull_request`, so they are suppressed along with `ci.yml`.

A non-tip pull request therefore reaches merge time with no `ci` aggregate
check, and that collides with a real policy line. MAINTAINERS.md states that
pull requests require successful required CI checks before merge, and the
maintainer-integration exception waives the second maintainer's approval, not
CI. `gh pr merge --squash --admin` will merge such a pull request mechanically,
but the mechanism is not the authorization.

The repository owner authorized this tip-only model explicitly for this batch,
so the deviation is a recorded owner decision rather than an inferred one. What
makes it defensible in substance is that the stack is cumulative: the content of
every branch beneath a tip is a strict subset of what the tip's green run
actually executed. The evidence exists; it is attached to the tip pull request
instead of to each branch.

Every merge record therefore names three things: the owner authorization for
tip-only CI, the tip pull request and run id that covers this branch, and the
fact that this branch's own `ci` check never ran.

Squash commit messages must never contain `[skip ci]`. The dev-branch run
triggered by each merge is the regression gate, and losing it would remove the
only signal that a landed lane broke `dev`.

## Common principles

Pushes use `git push --no-verify`, fast-forward only. No `--force` anywhere.
Nothing is pushed to `dev`, `main`, or `preview`.

Local full-suite runs are forbidden. Allowed local checks are
`bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, and
`bun test` limited to the files a pull request touches. Hosted CI on the lane
tip is the only suite proof this goal accepts.

Each lane thread works in its own managed worktree and treats branches as
detached checkouts. Many of these branches are already checked out in other
worktrees, so a checkout by name is refused by git.

Conflicts are resolved by reading both sides and judging which matches current
behavior. A genuinely ambiguous conflict stops that link and is reported with
both sides and the reasoning, never guessed past.

Lane threads never merge, never mark a pull request ready, and never close
anything. They push and report.

## Lane map

| Lane | Doc | Chain, bottom to top | Owner model |
| --- | --- | --- | --- |
| S4 audio | 010 | 4391, 4392, 4395 | xai/grok-4.6 |
| S5 providers | 010 | 4374, 4376, 4358, 4370 | xai/grok-4.6 |
| S6 singles | 010 | 4356, 4363, 4367, 4366, 4378, 4402, 4414, 4353, 4364 | xai/grok-4.6 |
| S2 accounts | 010 | 4375, 4404, 4408, 4361, 4369, 4401, 4357 | xai/grok-4.6 |
| S1 responses | 020 | 4346, 4354, 4345, 4355, 4359, 4351 | anthropic/claude-opus-5 |
| S3 trio+remote | 020 | 4427, 4433, 4441, 4362, 4372, 4373 | anthropic/claude-opus-5 |
| S7 global tip | 030 | 4334 | main session |
| Issue closure | 040 | n/a | kimi/k3[1m] research, main session executes |

S6 groups nine pull requests that share no files. They are chained only to
collapse nine CI runs into one; no ordering dependency exists between them.

S7 is alone and last. #4334 retires Codex Spark across 34 core files and
collides with nearly every other lane, so it rebases once against a fully
landed `dev` instead of fighting each lane in turn.

## Work phases

wp1 is this roadmap. wp2 runs wave 1 (S4, S5, S6, S2), wp3 runs wave 2 (S1 then
S3), wp4 lands S7 and confirms the final dev regression run, and wp5 closes the
issues. Issue closure was added by the user after the goal was armed and
supersedes the original objective's exclusion of it.

## Risks

The stale-base pattern from #4380 is expected to recur: failures on a lane tip
that belong to `dev` drift rather than to the lane. The tip CI run on the
integrated head is what distinguishes them, and a failure that survives
integration is real and fixed before that lane merges.

Lanes prepared in parallel go stale as earlier lanes land. Each lane thread
re-merges `origin/dev` at its tip immediately before its final report, and the
main session re-checks the tip run against the head it is about to merge.

A lane merged out of order defeats the shrinking-diff property and can strand a
child on a base that no longer exists. Lane order inside a chain is fixed;
only whole lanes are interleaved.
