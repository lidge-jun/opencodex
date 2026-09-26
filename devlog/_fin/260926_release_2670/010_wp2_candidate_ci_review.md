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

## Regression review synthesis (REVIEW-SYNTHESIS-01)

| Lane | Verdict | Findings and disposition |
|---|---|---|
| standalone | RELEASE-OK | none; compiled binary built and a policy worker ran inside it on macOS arm64 |
| chat | RELEASE-OK | orphan legacy `function` results now fail with 400 (ADR-0111, intended) — release note |
| ops | RELEASE-OK | Remote Workspace RPC v2 fails closed against v1 peers (documented in f19ef3dbfe) — release note; Kiro injected-`saveCredential` rollback skip is test-surface only — follow-up |
| features | RELEASE-BLOCK | F1-F3 below, all rebutted |

- F1 hard-lock 429 without `Retry-After` when a blocking window has no future reset: rebutted. It is
  the #5870 design (`260926_main_hard_lock_any_window/010_plan.md`), pinned by
  `main-account-hard-lock-policy.test.ts`; a `Retry-After` at the 5h reset would promise an unlock
  the weekly window may still refuse.
- F2 retained weekly block could persist: rebutted. `runMainAccountHardLockRecovery`
  (`src/codex/auth-api/pool-mode-gate.ts`) force-refreshes WHAM every 60 s while blocked, and a
  measured secondary window replaces the retained tuple.
- F3 `validateForwardAdmissionCredential` now below the Devin search dispatch: rebutted. The guard
  protects bearer forwarding; the Devin path forwards no caller header, and `resolveApiAuth` already
  admitted the request in `serve-options.ts` before `handleSearch`. Residual: no pin test for a
  Devin-routed request with the admission secret as bearer — follow-up.

An independent kimi audit confirmed all three rebuttals (NEAR-PASS; residuals are missing pin tests).

## Candidate run 36208751784

`windows 2/9` failed once: `provider outbound GET transport > proxy mode reaches one real proxy`
timed out at 15 s after the fixture logged a local DNS failure (runner stall signature). One job rerun
per rule 2 once the run finishes.

## Owner steering (2026-09-26): land #5866 before the candidate

The owner asked to merge #5866 (owner-authored, "independent first-party switch for the Claude Code
CLI", 68 files) and then continue. Its PR CI passed at head `a79b8625` on base `ca74738bc5`, five
commits behind `dev`. Before merge: union worktree `/tmp/ocx-union-5866` (`dev` + #5866) passes
`bun run typecheck` and `bun run test:changed`, and a kimi regression review of the diff finds no
accepted blocker. Merge with `gh pr merge 5866 --squash --admin --match-head-commit a79b8625...`.
The candidate becomes the new `dev` tip; a new lane=all run on it replaces `36208751784` as the
candidate evidence.

## Owner steering (2026-09-26): #5866 merged, then #5875

- #5866 merged as `03aa39340b` (squash, admin, match-head `a79b8625`). Union evidence before merge:
  `bun run typecheck` exit 0 on `dev`+#5866; kimi review RELEASE-OK (default-off verified, no
  credential exposure, union gates clean). The union `test:changed` run had 24 failures, all in
  service ownership, native Grok/Codex toggle, and remote Linux sandbox files that #5866 does not
  touch (this Mac's installed service and missing bubblewrap). The owner then asked that no further
  local suites run; CI is the test evidence from here.
- Run `36208751784` (old candidate) was cancelled as superseded; lane=all `36209738124` started on
  `03aa39340b`.
- The owner then asked to include #5875. It conflicted with #5872 in `QuotaSummaryBar.tsx`; resolved
  in `/tmp/ocx-5875` by keeping #5875's `ref={publishStickyTop}` on the section and #5872's
  `QuotaSummaryChips`, root and GUI `tsc` plus GUI lint exit 0, pushed as `90a556debf`. Merge
  after its exact-head PR CI passes and a kimi review finds no blocker; the candidate then moves to
  the new `dev` tip with a new lane=all run.

- #5875 exact-head PR CI at `90a556debf`: every check pass (skips by path); kimi review RELEASE-OK (defaults-only
  shadow-intercept users gain `gpt-6-luna`; a hand-written `sourceModels` list replaces defaults — release note).
  Merged as `dac1d25f48`. Run `36209738124` on `03aa39340b` was cancelled as superseded after `windows 7/9`
  failed five `cli-connect-readiness` cases on a 15 s spawnSync kill (`status: null`, cold-spawn warmup 17 s),
  the stall signature; that shard passed on `08fd8a6284`. The new candidate run is its one retry.

## Final candidate

`CAND=dac1d25f48fad18420aa856631ff9ee9c1775b0f`, lane=all run `36210914271`.

Result: run `36210914271` completed `success` at CAND, attempt 1: 39 jobs success, `privacy gate` skipped by
design, no reruns. `windows 7/9` passed, so the earlier `cli-connect-readiness` timeouts were the runner stall.
wp2 exits with no accepted blocker.
