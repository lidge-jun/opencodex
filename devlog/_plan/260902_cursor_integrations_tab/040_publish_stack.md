# 040 — Publish the stack and land it bottom-up

Stack (rebased onto origin/dev 8fb4e6e79):

| PR | Branch | Head | Base |
|---|---|---|---|
| 1 | codex/cursor-integration-status | ef68bd1f2 | dev |
| 2 | codex/cursor-integration-tab | 598f24f57 | codex/cursor-integration-status |
| 3 | codex/cursor-integration-docs | e848b12ee | codex/cursor-integration-tab |

## Steps

1. `git push --no-verify -u origin <branch>` for all three (push approved; local suite forbidden).
2. `gh pr create` with the repository template (Summary / Verification / Checklist), a stack map
   in each body, and the two PNGs from `assets/` embedded in PR 2 (body mentions gui).
3. Wait for exact-head CI: `gh pr view --json headRefOid,statusCheckRollup`; every check on
   the exact head must be SUCCESS/NEUTRAL/SKIPPED. Address Codex/CodeRabbit findings that are
   correct; rebut the rest in-thread.
4. Admin squash-merge PR 1. Retarget PR 2 to dev, wait for CI on its head, merge. Same for PR 3.
5. Proof: `git fetch origin dev && git merge-base --is-ancestor <mergeSha> FETCH_HEAD` x3.
6. Move the devlog unit to `_fin` in a follow-up if the maintainer wants; not part of this PR.

## Constraints

Never touch the 10100 service. No `bun run test` locally. Admin bypass covers approval only —
CI, privacy scan and reviewer threads are still required evidence.
