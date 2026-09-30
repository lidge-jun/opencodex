# 020 — Phase 2: PR, exact-head CI, merge

1. Commit wp2 in small commits on `codex/codex-credits-bar`; rebase onto latest
   `origin/dev` if it moved; rerun focused gates after rebase.
2. Capture a GUI screenshot (switch on, main + pool rows) from a local proxy started with
   an isolated `OPENCODEX_HOME` or the live dashboard after deploying nothing; upload it
   through the `pr-assets` branch and link by commit SHA (never commit it to the PR branch).
3. Open the PR against `dev` with `.github/PULL_REQUEST_TEMPLATE.md` sections (Summary,
   Verification, Checklist) filled, screenshot embedded.
4. Watch required checks on the exact PR head; fix failures at root cause; never treat
   skipped/cancelled/queued as passing.
5. Merge (owner authorized) once required checks are green on the exact head; record the
   merge SHA; close the unit into `devlog/_fin/` in a follow-up only if the repo
   convention requires it.

6. Security review gate (010.A item 4): an independent reviewer reads the final diff for
   credential-bound publication, config serialization and logging before merge; its verdict
   is quoted in the PR Verification section.
