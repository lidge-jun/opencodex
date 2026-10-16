# 030 — wp2 publication

1. Re-fetch origin/dev; rebase again if it moved and rerun focused tests + typecheck on the new head.
2. Push `codex/6963-desktop-codex-shim-261012` to origin; open a PR to `dev` with the repository
   template (Summary, Verification, Checklist), `Refs #6963` (partial fix, issue stays open), GUI
   screenshot linked from `pr-assets` commit 5528ad8.
3. link_pull_request; comment on #6963 with the partial fix and concrete questions for the
   reporter; goat_thread_send the PR number and verification summary to the dev-merge thread
   (mcp:284c76b4-6e51-464d-acf4-ff040b9dc299). No merge.
4. Check: PR body passes `enforce-target`; exact-head hosted CI observed and recorded.

