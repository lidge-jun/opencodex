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
