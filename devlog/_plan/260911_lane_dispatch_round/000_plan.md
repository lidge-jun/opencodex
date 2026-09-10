# Lane dispatch round — 260911

Freeze: `origin/dev` `6d3ad12e3` (package.json 2.51.0). Every lane branch is cut from that SHA.

## Why this round exists

`dev` did not move for 24 hours while 80 pull requests stayed open. The blocking pattern is not
reviewer capacity alone: three of the most urgent PRs (#4184, #4181, #4203) sat at
`CHANGES_REQUESTED`, and four more (#4188, #4174, #4171, #4210) were reset to draft by the
readiness gate after a push. Waiting on those forks does not land anything this round.

## What decides the lane boundaries

File ownership, not topic. `010_lane_partition.md` records the measured collisions across 27 open
PRs. Two facts fix the shape of this round: `src/server/responses/core.ts` is contended by four
open PRs and `src/providers/quota.ts` by another four, while twelve PRs touch no file any other
PR touches. Lanes are cut so that no two lanes own the same file, which is what makes unlimited
parallel agents useful rather than a rebase generator.

## Decision-free filter

This round dispatches only work whose expected behaviour is already fixed by a filed issue, so no
lane has to invent a maintainer policy. An item is in when the issue states the expected result and
no competing design is open; it is out when landing it would decide a policy the maintainer has not
decided.

Six items inside the round also left a real choice open; audit round 1 caught that and the orchestrator
 made those calls in writing (`030_audit_round1.md`), so no lane decides policy.

Excluded on purpose, with the decision that blocks each one:

- #4213 — whether unknown native-surface endpoints are forwarded upstream or keep returning 404 is a
  proxy policy decision, and the issue explicitly asks for it.
- #4198, #4179 — publishing an official container image changes a documented policy
  ("opencodex does not publish an official container image").
- #4173 — the atomic update design competes with #4185 and #4203 already in flight.
- #4204 — removed after the feasibility audit: binding the reasoning-effort clamp to the Desktop
  runtime needs `codex/runtime.ts`, `catalog/bundled.ts`, and `catalog/sync.ts`, because the catalog
  probes one selected runtime and no caller passes a consumer identity. Resolving a catalog per
  consumer is a design decision.
- Contributor feature PRs (#4183, #4100, #4111, #4193, #4033, #4042) — these need review, not
  reimplementation, and reimplementing them would discard the author's work.

## Roles

The orchestrator thread owns the round: it holds the host goal, tracks every lane, refreshes live PR
and CI state, and performs merges one at a time. Lane threads own implementation inside their file
territory and stop at a green PR; they never merge and never touch another lane's files.

## Execution rules carried from earlier rounds

These are not new. They are the rules this repository's earlier parallel rounds ran under, and they
are repeated inside every packet so a lane thread that never reads this file still obeys them.

1. **No local product suite.** No `bun test`, no `bun run test`, no `bun run typecheck`, no build, no
   install. Report those checks as `NOT RUN` and bind confidence to hosted CI. Reading source and
   running read-only `git`/`gh` is not a suite run.
2. **Push with `--no-verify`**, and prefix every mutating git command with
   `git -c core.hooksPath=/dev/null` — this repository's hooks can start a GUI install, typecheck,
   and build, which rule 1 forbids.
3. **Ordinary dependent PRs.** The first PR of a lane targets `dev`; a child targets its parent's
   head branch, and is retargeted to `dev` after the parent lands. No native GitHub stacks.
4. **Attribution.** Carrying, superseding, or reimplementing another author's work requires a
   `Co-authored-by` trailer naming that author in a branch commit, not prose.
5. **Final-head CI is the proof.** Green on an older head, a cancelled run, or a skipped job is not
   passing evidence. The exact pushed SHA must be the one that is green.
6. **Unlimited `xai/grok-4.6` subagents**, read-only. They verify, reproduce, and audit; they do not
   write files, and no finding enters a lane's work without a `path:line` anchor.

## Merge policy

Merges are serialized through the orchestrator because `dev` is protected and shared. A lane PR
merges when its exact head is green on final-head CI; the landing is proven by fetching `origin/dev`
and checking ancestry, never by the merge command's own output.
