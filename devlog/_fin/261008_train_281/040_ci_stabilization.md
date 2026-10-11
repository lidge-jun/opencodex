# 040 wp5: Cross-platform CI stabilization

Known failure: run 37735258668 (workflow_dispatch lane=all, dev `aeebf11e5a`), `windows 3/9`:
`tests/claude-integration/claude-picker-startup.test.ts` afterEach `rmSync` EBUSY on the temp root after
`await handle?.stop()`. Read-only investigation report: `.tmp/train281/ci/report.md` (scratch).

Attribution (report, 2026-10-08): 91 prior passes of the same case in 1,298 Windows job logs since Oct 3, no
prior EBUSY in this file; the shard ran the 1.4.0 test runner; PR runs for #6725 and #6713 passed the case.
Source-supported candidate: `loadConfig()` starts an unawaited `hardenSecretDirAsync(root)` (icacls) flight
(`src/config.ts:212`, `src/config/paths.ts:38-48`) through the intercept controller's `readConfig`; intercept
`stop()` does not drain it (the full server does, `src/server/index.ts:790`), and the fixture removes the root
immediately with `rmSync`. Precedent fixtures drain first (`tests/cli/cli-config-default-show.test.ts:54-59`).

Fix (wp7, independent of wp3/wp4): in `tests/claude-integration/claude-picker-startup.test.ts` afterEach, stop
every handle, `await flushConfigDirHardeningAndReaps(dir)` for each root, then `removeTreeWithRetry(dir)`;
restore env in `finally`. No assertion or deadline changes. Activation: on Windows CI the case runs with a
pending hardening flight. A green shard alone does not prove the drain, so wp7 adds a regression in the same
file (or a registered sibling) that injects a blocked ACL runner, following
`tests/providers/nous-oauth.test.ts:34-68`: removal must stay pending until the runner is released, and env
restoration must run when removal throws. That test passing on the PR head, plus the Windows shard passing
on the PR head and on the final dev tip, is the evidence. The handle owner remains a candidate, not proven.

Per failing job: attribute with evidence (prior occurrences, open handles, commits in range). Product defect:
fix PR to dev with a regression test. Fixture defect: repair the test, using `tests/helpers/remove-tree.ts`
only when the handle is proven transient. Unattributed flake: one rerun of the failed job, both attempts
recorded; a second identical failure is treated as real. A failure followed by a green retry is recorded as
"unattributed, retried green" with both run/attempt ids and stays an open item in the release notes of this
unit unless repair evidence exists; it never substitutes for wp7's activation test. Never cancel runs.

Final gate: after wp3, wp4 and wp7 land, `gh workflow run ci.yml --ref dev -f lane=all` on the final dev tip; every
job green, skips only where the workflow conditions them.
