# 050 — wp2 publication plan

1. Confirmation review of the final rebased commit by a different model family (GPT-6.1-Sol; the builder is Claude), with the code-review round 1 findings and dispositions in the brief.
2. Fold any finding, amend the single commit, re-run the focused verifiers from 040.
3. Push `codex/6671-windows-health-recovery-261012` to `origin`; open a PR to `dev` with the repository template (Summary, Verification, Checklist), `Closes` not used because the issue stays open for the Bun 1.4.2 re-check; draft until hosted CI and review are green.
4. Inspect exact-head CI, including the Windows legs that run `tests/service/service-health-sentinel-process.test.ts` (the kernel32 handle path).
5. Link the PR to the thread; send PR number, head SHA and verification to the merge-management thread; post nothing to the issue without need.

Local full-suite note: `bun run test:changed` waited more than 30 minutes behind other worktrees' runs on the machine-wide test lock and was stopped; the focused set (342 tests across 19 files) plus `tests/service` and `tests/lib` were run directly, and the full suite is left to hosted CI.
