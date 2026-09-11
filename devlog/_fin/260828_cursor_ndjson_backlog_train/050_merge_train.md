# 050 — cursor PR merge train (wp map for the merge-round loop)

User instruction (2026-08-28): merge the cursor rounds one at a time; the
instruction is the maintainer approval for these session-authored PRs.

## Rounds (dependency-first)

| R | PR | head | gate |
|---|---|---|---|
| R1 | #2774 backlog coalesce | codex/runturn-backlog-coalesce 286a1e5a5 | checks 25 SUCCESS + 1 SKIPPED — green; sol-medium pre-merge review |
| R2 | #2795 midstream echo | codex/cursor-midstream-echo | retarget to dev post-R1; CI re-run green |
| R3 | #2769 failed_precondition | codex/claude-classified-error-status 16cb875b8 | checks green; review |
| R4 | #2801 umbrella core | codex/cursor-umbrella-core 54965ef03 | CI FAIL: test 1/4 update-stop-first launcher-recovery timeout (46.8s, waitForProxy false) — UNRELATED to catalog diff (no update/launcher files touched); same infra-flaky class dev itself shows (dev run 33134096643 fails a different macos test). Gate: causal fix or evidence-backed unrelated-flake disposition + fresh green run; never rerun-until-green without a cause |
| R5 | #2802 umbrella wire | codex/cursor-umbrella-wire | retarget to dev post-R4; CI green |

## Per-round procedure

1. Exact head SHA + full check rollup via gh.
2. sol-medium reviewer: independent diff review, VERDICT line.
3. Blockers folded or rebutted with rationale; repairs get focused tests.
4. gh pr merge --squash --delete-branch; record merge SHA.
5. Child retarget (gh pr edit --base dev) + verify checks restart.
6. Post-merge: origin/dev log + no new cursor-test failures.

## Round log

- R1 (#2774): reviewer PASS (Tesla, sol-tier; coalescing phase-safe, consumers
  checked). MERGED squash 5511a424c via --admin (user merge instruction =
  maintainer approval; branch policy requires review). Head branch deleted.
  SIDE EFFECT: base deletion auto-closed stacked #2795, which GitHub cannot
  reopen (base ref gone). Recovery: cherry-picked 58ee805/a652f0d/e167311
  onto origin/dev (990a83f5e; 17 tests + tsc green on rebased head),
  force-pushed the branch, opened successor PR #2803 vs dev.
  LESSON for R4/R5: retarget the child to dev BEFORE merging the parent with
  --delete-branch, or merge parent without branch deletion.
- R2 (#2803, successor of #2795): CI 23 ok / 0 fail (CodeRabbit status
  marker non-required); prior audits stand (cherry-pick clean). MERGED
  squash via --admin, branch deleted.
- R3 (#2769): reviewer PASS (Avicenna; precedence + claude derivation +
  72 focused tests + clean merge simulation). MERGED squash via --admin,
  branch deleted.
- R4 (#2801): CI failure root-caused by investigator (Zeno): update-stop-first
  45s readiness deadline exhausted on loaded runners (46-47s failures on 4+
  unrelated PRs; catalog diff has no launcher imports, isolated shard).
  Causal fix 22c073e03 raised the deadline to 90s (derived budget + pinned
  arithmetic keep it honest). Fresh CI fully green (0F, macos SUCCESS).
  MERGED squash 7232a60a7. #2802 retargeted to dev BEFORE branch deletion
  (R1 lesson applied) — but the parent squash still made the old chain
  CONFLICTING; wire branch cherry-picked onto dev (874f59734, 116 tests +
  tsc green) and force-pushed; #2802 stayed OPEN base=dev.
- R5 (#2802): fresh CI on the rebased head fully green (0F, macos SUCCESS).
  MERGED squash fbb5b0216, branch deleted.

## Train outcome: DONE

All five cursor PRs landed on dev: #2774 5511a424c -> #2803 922d53424
(successor of #2795) -> #2769 1e46430e3 -> #2801 7232a60a7 (with causal
flake fix 22c073e03) -> #2802 fbb5b0216. No open cursor PRs remain; all
train branches deleted. Squash-merge over a stacked child invalidates the
child's chain even after retargeting — cherry-pick onto dev is the reliable
restack (applied twice: R2, R4->R5).
