# wp2 — publish the lane branches

wp1 closed with the round unit merged into `dev` (`0aa685031`, PR #4217) and seven lane worktrees
holding a committed packet. The packets exist only locally, which leaves two real gaps: a lane thread
cannot open a pull request until its branch exists on `origin`, and a lost worktree would take its
packet with it.

## What this phase does

1. Push each of the seven lane branches to `origin` with `--no-verify` and
   `git -c core.hooksPath=/dev/null`. Audit confirmed each branch is exactly one commit on top of
   `6d3ad12e3` touching only its own packet file, and that no `codex/260911-l*` ref exists on
   `origin` yet, so no push overwrites anything.
2. Verify each pushed ref from the remote with `git ls-remote`, not from the local tree.
3. Record the pushed heads in `060_ledger.md` on the follow-up branch
   `codex/260911-round-ledger-1`, and open that as a pull request targeting `dev` with the full PR
   template, since `enforce-target` rejects a thin description.

## Acceptance

- `git ls-remote origin 'refs/heads/codex/260911-l*'` lists all seven refs, and each remote SHA equals
  the local head of its worktree at `~/.codex/worktrees/260911-l1/opencodex` through
  `~/.codex/worktrees/260911-l7/opencodex`.
- Each pushed commit's diff against `6d3ad12e3` contains only its own
  `devlog/_plan/260911_l<N>_<slug>/000_packet.md`.
- `060_ledger.md` on `codex/260911-round-ledger-1` carries the live remote head per lane, replacing
  the stale seed SHAs, plus the `gh pr list --head` snapshot and its capture time. A lane pull request
  opened after that capture supersedes the snapshot; the ledger says so rather than pretending the
  value is durable.

## Out of scope

No lane implementation. No pull request for a lane branch: a lane thread opens its own so the
description and checklist come from the thread that did the work. No merge of a lane branch.

## Why this is safe

Pushing a `codex/260911-l*` ref touches none of the protected branches, and `enforce-target` is a
pull-request gate rather than a push gate. The only policy surface in this phase is the ledger pull
request, which targets `dev` and fills the template.

## Local checks

`NOT RUN`, as everywhere in this round. The pushed branches carry documentation only, so hosted CI
has nothing to run on them until a lane pushes code.

