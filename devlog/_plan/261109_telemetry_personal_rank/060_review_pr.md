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


## Execution notes (wp7 P, 2026-11-09)

- Issue: #8372 (feature proposal template).
- Reviews run in parallel on DeepSeek (`command-code/deepseek-deepseek-v4.1-flash-fast` → `hyds/deepseek-v4.1-flash-free`
  → `mistral/deepseek-v4-1-flash-1017` on HTTP 401, default model if all fail); the model that ran is reported.
- Full `bun run test` in isolated homes runs alongside; `codex-cli-update-apply` fails locally only because this machine
  has live Codex sessions (`blocked_active_session`) and is left to hosted CI.
- PR screenshots: `.tmp/shots/profile-card-connect.png` and `profile-card-connected.png`, uploaded to the `pr-assets`
  branch and linked by commit SHA.
