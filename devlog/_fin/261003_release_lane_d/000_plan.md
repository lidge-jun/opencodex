# Child pairing release stabilization

Public source: [PR #6076](https://github.com/lidge-jun/opencodex/pull/6076), which requires operator pairing before Child join and supplies standalone enrollment. This unit prepares that existing contribution for integration while keeping its authorship and review history.

## Phase order

1. Document scope and verification boundaries; independently review the roadmap.
2. Carry the contribution onto current `dev` and verify the affected pairing, session and link behavior.
3. Exercise isolated CLI mint, HTTP redemption, paired dashboard, Child join and restart; distinguish component tests from operational evidence.
4. Publish a focused pull request with independent review, applicable exact-head CI and a handoff to the integration coordinator.

## Authority

The lane uses its own `codex/release-261003-d` branch. It may commit, push that branch, prepare its pull request and run its required CI. Merging, releasing, source-PR closure, account or credential settings, branch protection and installed-app replacement remain outside this lane.

## Verification boundaries

Focused regression tests, typecheck, privacy and structure checks are required. Dashboard changes also need the relevant GUI tests, lint, build and rendered evidence. Concurrent release worktrees justify a documented full-local-suite exception; the exact commands, results and remaining hosted coverage belong in the PR.

A source audit or synthetic join test does not establish native SSH enrollment or successful process replacement. Required CI must run successfully for the proposed head; absent, skipped, pending or cancelled checks are not passing evidence. Existing maintainer objections and independent security review remain explicit gates. The coordinator owns final integrated regression and serial integration.

Detailed working evidence is kept in ignored `.tmp/release-stabilization/report.md`. Unpublished security investigation belongs only in ignored scratch space; this public record contains scope and verification boundaries, not findings or reproduction instructions.
