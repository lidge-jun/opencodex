# Lane A — delivery

1. gpt-6-sol adversarial review of origin/dev..codex/260923-bundle-a-tests-hygiene; fold or rebut every finding.
2. Push the branch (no-verify), open one PR to dev from the repository template with Supersedes #5482 #5607 #5570 #5605 #5630 #5340, Refs #5439 with the findings, credit list, verification commands and the environment-only issue-914 note.
3. Watch exact-head CI; a run cancelled by the 2.64 release coordinator is re-dispatched after the release, never read as a failure.
4. Final report to the coordinator.
## Delivery record

- PR #5672 to dev from codex/260923-bundle-a-tests-hygiene; supersedes #5482, #5607, #5570, #5605, #5630 and #5340; refs #5439.
- Adversarial review: P2 dashboard finding withdrawn (the gap predates this branch for every desktop skip reason, and test_environment only occurs under OCX_TEST_HOME_GUARD=1), P3 EOF nits fixed.
- Exact-head CI is read from the PR head only; a run cancelled by the 2.64 release coordinator is re-dispatched after the release.
