# Integrate and publish the release

- Open a PR to dev with the repository template. Verify the exact head, required green PR CI (use ci:full because tests also consume JSON and fixtures as data), review completion and outstanding findings. Squash with the matching head guard, then verify the merge commit.
- Obtain qualifying manual dev CI for the release source, following MAINTAINERS.md and existing batch policy. Check the release workflow for any additional exact-source evidence it requires.
- Use the existing Release workflow on dev with the tested full SHA and the requested publication. Use the standard stable channel if the repository evidence supports it. Verify the workflow, GitHub release and npm dist-tag for the resolved version.
- Report failed or pending gates with the specific run and source SHA. Do not declare DONE until publication is verified.

Previous dev CI evidence: run 44072572278 failed Windows shard 7 in the uninstall race oracle. The checkout includes follow-up #8876, and newer full runs were cancelled. Fresh successful manual CI for the post-merge release source remains outstanding.

The service range gate from v2.100.4 to the current base reports `{"required":true}`. After merge, re-evaluate the range and acquire exact-source service-lifecycle CI alongside the full dev CI when required. The current release evidence policy fingerprints match the working tree.
