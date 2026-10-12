# Delivery

1. Adversarial gpt-6-sol review of the whole branch and a security re-review of the rebuilt #5000 commit. Fold every accepted finding as a follow-up commit; record rebuttals in the PR.
2. Push codex/260923-bundle-f1-provider-registry and open one PR to dev with the repository template: Summary, Verification (exact focused commands and counts, full suite not run by owner instruction), Checklist, Closes #5097, Supersedes lines for the fully carried PRs (#5362, #5314, #5349, #5188), #5000 listed as partial (not superseded), #5147 and #5146 listed as excluded with the reason, and every Co-authored-by credit.
3. Watch exact-head CI. A run cancelled by the 2.64 release coordinator is re-dispatched after the release; real failures are fixed on the branch.
4. Final report to the coordinator.
