# 040 — Publish the stack and land it bottom-up

Stack (rebased onto origin/dev 8fb4e6e79). Heads are resolved with `git rev-parse` at push
time and recorded in the ledger; the table is the shape, not the evidence.

| PR | Branch | Base |
|---|---|---|
| 1 | codex/cursor-integration-status | dev |
| 2 | codex/cursor-integration-tab | codex/cursor-integration-status |
| 3 | codex/cursor-integration-docs | codex/cursor-integration-tab |

## Steps

1. `git push --no-verify -u origin <branch>` for all three (push approved; local suite forbidden).
2. `gh pr create --base <base>` in order 1 → 2 → 3 with the repository template (Summary /
   Verification / Checklist) and a stack map in each body. PR 2 mentions gui, so its body embeds
   the two PNGs as `![alt](https://raw.githubusercontent.com/<owner>/<repo>/<commit>/...)` pinned
   to the commit that carries them (a bare link does not satisfy pr-quality.cjs).
3. Security lane (MAINTAINERS.md: credential handling needs explicit review): the status route
   reads credential *presence* (`configuredApiAuthToken`, `apiKeys`) to choose `apiKeyMode`. A
   read-only security reviewer checks that no key value is serialized, the route is
   session/admin-gated, the UA recorder is bounded, and detection reads only well-known paths.
   Its verdict is pasted into PR 1 and is a GATE: `SECURITY: PASS` is required before PR 1
   merges; on FAIL the findings are fixed, the stack restacked, and the review re-run.
4. Wait for exact-head CI: `gh pr view --json headRefOid,statusCheckRollup`; every check on
   the exact head must be SUCCESS/NEUTRAL/SKIPPED. Address Codex/CodeRabbit findings that are
   correct; rebut the rest in-thread.
5. Land bottom-up. `ci.yml` runs on `pull_request: {}` default types, which do not include the
   base-change `edited` event, so a retarget alone reruns nothing. For each child after its
   parent squashes: `gh pr edit --base dev` → rebase the child's unique commits onto the new
   `origin/dev` → `git push --force-with-lease --no-verify` → fresh exact-head CI → admin
   squash-merge. Repeat for PR 3.
6. Approval: the repository has one active maintainer and the user explicitly authorized admin
   merge for this stack. `gh pr merge --admin` posts nothing, so before each merge run
   `gh pr comment <n> --body` stating the user-authorized owner bypass, the exact head SHA
   merged, the CI rollup result, and (for PR 1) the security verdict. Admin covers approval
   only; CI, privacy scan, the security lane and reviewer threads remain required evidence.
7. Proof: `git fetch origin dev && git merge-base --is-ancestor <mergeSha> FETCH_HEAD` x3.
8. Move the devlog unit to `_fin` in a follow-up if the maintainer wants; not part of this PR.

## Constraints

Never touch the 10100 service. No `bun run test` locally.
