# 060 — Review, privacy review, PR, CI (wp7)

1. Issue: feature proposal via `.github/ISSUE_TEMPLATE/feature_request.yml` (headings exact).
2. Independent code review (DeepSeek task, fresh) on the full diff vs `origin/goat/telemetry-06-dashboard`; fold
   P0/P1 and correctness/security P2; re-review on a fresh task before merge.
3. Separate privacy/security review (DeepSeek task) focused on: linkage to install identifiers, secret exposure,
   consent bypass by agents, data minimisation, deletion completeness, collector abuse. Notes in `.tmp/` only.
4. PR against `goat/telemetry-06-dashboard` with the template (Summary, Verification, Checklist), `Closes #N`,
   screenshots via `pr-assets` commit SHA, `ci:full` label (collector, docs-site and GUI tests are partly invisible to
   `test changed`). Link with `pull_request.link`, watch with `pull_request.watch`.
5. Push with `--no-verify` (disclosed). After the stack lands: retarget to `dev`, merge `dev` in only on conflict,
   merge with `gh pr merge --squash --admin --match-head-commit <sha>` when every rule in the brief holds.

