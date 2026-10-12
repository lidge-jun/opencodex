# Merge topology discovered in flight

The first lane exposed a fact the roadmap had assumed away: not every pull
request in this batch targets `dev`. Seven of them are stacked children whose
base is another open pull request's head branch, which AGENTS.md sanctions as a
review workflow and `enforce-target` exempts from the wrong-base gate.

## What that changes

Merging a stacked child does not land anything on `dev`. It squashes that
child's content into its **parent's branch**. Only a pull request whose base is
`dev` lands on `dev`.

The audio lane proved it. #4395's base was `codex/audio-streaming`, not `dev`.
Merging it produced `091e0c0a3` on that branch and left `dev` untouched.
The lane only landed once #4392, the `dev`-based root, was merged.

## Live base map

| Child PR | Base branch | Parent PR |
| --- | --- | --- |
| #4404 | `codex/260912-60plus-accounts-history-identity` | #4375 |
| #4408 | `codex/260912-60plus-accounts-history` | #4404 |
| #4376 | `codex/260912-60plus-models-capabilities` | #4374 |
| #4373 | `codex/260912-60plus-operations-totals` | #4357 |
| #4372 | `codex/260912-60plus-remote-runtime` | #4362 |
| #4433 | `codex/260912-ws-stage-instrumentation` | #4427 |
| #4441 | `codex/260912-native-main-reauth-api` | #4433 |

Every other open pull request in the batch targets `dev` directly.

## Corrected merge order

Inside a lane that contains a base chain, merge from the top down: the deepest
child first, so its content collapses into its parent's branch, then that parent,
and so on until the `dev`-based root is merged last. Each of those merges closes
one pull request, so the whole chain still reports `MERGED` rather than being
closed as superseded.

That inverts the roadmap's original bottom-up instruction for chained lanes.
Bottom-up still applies to lanes whose members all target `dev`, where each
merge is independent.

## Cross-lane coupling

#4373 sits in the trio-remote lane but its base is #4357's branch, which the
roadmap put at the top of the accounts lane. The two lanes are therefore coupled
through that pair: #4373 must merge into `codex/260912-60plus-operations-totals`
before #4357 lands on `dev`. Treat #4357 and #4373 as one unit and merge them
together, after both lanes are otherwise ready.

## Re-merge cost of squash

A squash merge rewrites the parent's commits into one, so a child that carried
those commits becomes conflicted the moment its parent lands. #4392 went
`DIRTY` immediately after #4391 squashed to `dev`.

The resolution is mechanical rather than a judgment call: `dev` gained only the
squashed form of content the child already carries, so every conflict is the
same change landing twice and the child's side is a strict superset. Resolve to
the child's side, then verify that nothing the parent introduced went missing
before pushing.

Doing the child merges top-down first, and only then landing the root, keeps
this to one re-merge per lane instead of one per link.

## Audio lane result

| PR | Outcome | Commit |
| --- | --- | --- |
| #4391 | merged to `dev` | `afe987cff` |
| #4395 | merged into `codex/audio-streaming` | `091e0c0a3` |
| #4392 | merged to `dev`, carrying #4395 | `4a49d7f34` |

Hosted evidence: Cross-platform CI run 34731037202 `success` on stack tip
`ec9e3734e`. The dev regression run for the landing is 34731971757. The run for
#4391's intermediate landing was cancelled by the concurrency group when #4392
pushed, which is expected and is not a failure.

