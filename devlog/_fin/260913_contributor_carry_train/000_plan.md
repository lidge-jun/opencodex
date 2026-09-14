# Contributor carry train — 60+ scored work into dev

## Objective

Land the highest-value contributor work that is still open on this repository.
Seventeen open pull requests score 60 or higher by maintainer review once the
maintainer's own #4462 is set aside; 16 of them are dispatched here and #3389 is
deferred for a recorded reason. Eight issues score 60 or higher with no pull
request owning them. The goal also closes everything those landings actually
resolve. `origin/dev` was `2df82f412` when this roadmap was written.

This unit follows the 36-PR lane-stack merge in
`devlog/_plan/260913_lane_stack_merge/`, which landed the maintainer-authored
backlog. That batch is the precedent for the mechanism here; what changes is the
authorship. Every branch in this train belongs to someone else, so attribution is
a correctness requirement rather than a courtesy.

## Selection

Candidates come from the maintainer's own `## 리뷰 · 우선순위 NN / 80` comments,
harvested live from every open issue and pull request through the GraphQL API on
2026-09-13. All 73 open pull requests and all 58 open issues carry a score, so
the 60 cut is a real threshold rather than a sample.

The inventory and its verification live in `001_candidate_inventory.md`.

## Attribution is a gate, not a footnote

`AGENTS.md` requires a `Co-authored-by` trailer naming the original author on any
landing that reimplements, supersedes, carries, or rebases their pull request.
`CREDITS.md` records 27 landings that failed this and explains why prose credit is
not equivalent: GitHub reads the trailer, and nothing reads a sentence in a commit
body.

Two rules follow for every lane in this unit:

- The trailer address is taken from the author's GitHub account, in the numeric
  `users.noreply.github.com` form, not from the commit metadata on their branch.
- The trailer is verified in the **actual landing commit** after the squash, not
  in the pull request description. A custom squash message silently drops text
  that was only in the body.

## CI economy

Unchanged from the previous batch and re-verified there. Each lane is a cumulative
stack: the bottom branch merges `origin/dev`, each branch above merges its parent's
resulting commit, so merging bottom-up produces shrinking diffs. Every non-tip head
commit carries `[skip ci]`, which suppresses `ci.yml`, `react-doctor`,
`service-lifecycle` and `issue-quality-tests`. Only `enforce-pr-target`,
`pr-hygiene` and `pr-labeler` still run, because `pull_request_target` ignores the
skip marker.

Only the lane tip runs the full matrix, and that tip run is the merge gate for the
whole lane. Squash messages never contain `[skip ci]`, because the dev-branch run
each merge triggers is the regression gate.

This is an owner-authorized deviation from the MAINTAINERS.md requirement that
every pull request carry its own successful required check. Each merge comment
states it explicitly: the owner authorization, the tip pull request and run id
that covers the branch, and the fact that this branch's own `ci` check never ran.

## Common principles

Pushes use `git push --no-verify`, fast-forward only. No `--force` anywhere.
Nothing is pushed to `dev`, `main` or `preview`.

Local full-suite runs are forbidden. Allowed local checks are `bun run typecheck`,
`bun run structure:check`, `bun run privacy:scan`, and `bun test` limited to the
files a pull request touches. Hosted CI on the lane tip is the only suite proof
this goal accepts.

Each lane thread works in its own managed worktree and may fan out unlimited
`xai/grok-4.6` subagents inside that worktree. Subagents share their parent's
checkout, so a lane's subagents never run branch-level git operations concurrently.

Lane threads never merge, never mark a pull request ready, and never close
anything. They push and report. The main session performs every merge.

Conflicts are resolved by reading both sides and judging which matches current
behavior. A genuinely ambiguous conflict stops that link and is reported with both
sides and the reasoning, never guessed past.

## Lane map

| Lane | Doc | Contents, bottom to top | Owner model |
| --- | --- | --- | --- |
| R responses/core | 010 | 4455, 4086, 4409, 4387 | anthropic/claude-opus-5 |
| C chat + adapters | 010 | 4438, 4389, 4457 | anthropic/claude-opus-5 |
| L cli + hub | 010 | 4382, 4413, 4170 | xai/grok-4.6 |
| B bridge + images + auth | 010 | 4381, 4388, 4460 | xai/grok-4.6 |
| S security-review hold | 010 | 4447 | xai/grok-4.6 |
| X small carries | 010 | 4077 copy fix, 4171 dedupe | xai/grok-4.6 |
| I1 Windows issues | 010 | 4425, 4442 | kimi/k3[1m] |
| I2 config + account issues | 010 | 4430, 4435 | xai/grok-4.6 |
| H context history | 030 | 3663 | anthropic/claude-opus-5 |
| I3 routing compatibility | 030 | 3775, 4436, 4429 | xai/grok-4.6 |
| I4 encrypted history regression | 030 | 4454 | anthropic/claude-opus-5 |

Wave 1 prepares R, C, L, B, S, X, I1 and I2 in parallel. Wave 2 is I3, I4 and H.

Wave 2 is not parallel throughout. I3 prepares alongside, but I4 and H must be
serialized in that order: both land in the routed Responses request path, so H
rebases onto I4 rather than preparing beside it. Preparing them as peers would
put two `src/server/responses/core.ts` writers in one wave, which is the exact
thing lane R exists to prevent.

Lane S is prepared in wave 1 but is deliberately not merged in wp3. `#4447`
touches CORS and the management provider routes, which is inside the
MAINTAINERS.md security-review boundary, and a tip merge would have landed it on
a CI signal that was never meant to certify it. Splitting it out of lane B keeps
lane B's tip at `#4460` and keeps the hold visible at merge time rather than
three documents away.

## Work phases

wp1 is this roadmap. wp2 prepares wave 1, wp3 merges it, wp4 prepares wave 2
against landed `dev`, wp5 merges wave 2 and confirms the dev regression run, and
wp6 closes what landed and records the outcome.

## Risks

Five of the carried pull requests touch `src/server/responses/core.ts`: #4455,
#4086, #4409 and #4387 in lane R, plus #3663 in lane H. Issue #4454 lands in the
same path without being a pull request at all. #3389 is a sixth `core.ts`
toucher and is deferred for an unrelated reason recorded in
`001_candidate_inventory.md`. Lane R serializes its four; H and I4 serialize
after R. A lane merged out of order defeats the shrinking-diff property.

GitHub had not computed `mergeable` for most of these branches when the roadmap
was written, so lane assignment rests on file overlap rather than a proven
conflict-free merge. Each lane thread discovers its real conflicts at prepare time
and reports them.

All four issue lanes — I1, I2, I3 and I4 — have no branch to carry at all. Those
are ordinary implementations by the lane thread, and they carry no
`Co-authored-by` trailer because there is no source branch; the reporter is
credited in the description instead.
