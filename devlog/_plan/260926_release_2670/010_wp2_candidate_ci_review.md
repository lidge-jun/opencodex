# 010 — wp2: candidate CI and regression review

## Candidate

`CAND=08fd8a62844738c960e2da71681b9a064b2fede3` (`origin/dev` at round start). Cross-platform CI
lane=all run `36208751784` (`workflow_dispatch`, headSha = CAND) was dispatched at round start.
The previous full run on `f353aac859` (`36170156438`) passed; the only failure since v2.66.0 on
`dev` was `windows 7/9` on `ca74738bc5`, fixed by #5863.

Acceptance: every job `success` at its latest attempt; aggregate `ci` success. Rerun and defect
rules are cross-cutting rules 2 and 3 in 000.

## Regression review

Four kimi read-only leaves review `v2.66.0..CAND`, split by surface:

| Lane | Commits |
|---|---|
| standalone | #5761 worker embedding, `e830d8adee`, `f67993645e`, `3ed77e964f` |
| chat | #5844, #5843, #5845, `b603a5ce78`, #5863 |
| ops | #5856, #5840, #5841, #5842, #5756, #5758, #5790, `43345e3c0e` |
| features | #5850, #5870, #5872 |

Each reports severity, file:line, failure scenario, evidence and a RELEASE-OK/BLOCK verdict.
Main synthesizes accept/rebut per finding (REVIEW-SYNTHESIS-01): a finding is accepted only when
confirmed at the candidate by reading the code or by a failing test. Accepted blockers become fix
PRs under rule 3; accepted non-blockers are listed as follow-ups in 030 and left on `dev`.

## Local proof

At CAND in a `/tmp` worktree: `bun run typecheck` plus the focused test files named by any
accepted finding. The lane=all run is the full-suite evidence; a full local `bun run test` is not
repeated (it is the same suite on three OSes in CI).

## Exit

Record run ID, job count, reruns, and the finding dispositions below this line, then close wp2.

Sweep #5858 (merge `ca74738bc5`) is the union of twelve PRs, all already in the lanes above:
#5761 (standalone); #5844, #5843, #5845 (chat); #5856, #5840, #5841, #5842, #5756, #5758, #5790 (ops);
#5850 (features). Its integration commits `43345e3c0e` and `3ed77e964f` are in ops and standalone.
The remaining commits in the range (#5857 devlog, #5852 version pre-move) carry no runtime code.
Before wp2 exits, re-read the `dev` run list to confirm no new failure since this was written.

## Status at wp1 close (01:36Z)

Run `36208751784` in progress: skipped=1, success=20 of 37 jobs, no failure yet. Four kimi regression leaves
(standalone, chat, ops, features) dispatched in wp1's P as read-only discovery; their reports are
synthesized in wp2.
