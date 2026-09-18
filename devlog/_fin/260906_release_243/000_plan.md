# Release 2.43.0

Loop archetype: spec-satisfaction release operation; one PABCD cycle.
Trigger: owner explicitly requests readiness audit, preview/main merges and release.
Goal: promote RC af50c6d3451078a7d298b044c08fd2684c9e8eeb into preview/main and publish 2.43.0-preview.20260906 and 2.43.0 with matching registry gitHead, tags and successful exact-SHA release workflows.
Scope: GitHub release/version PRs, required CI workflows, npm OIDC release, local isolated release worktree. Preserve original checkout and existing dirty devlogs. No unrelated open PR integrations or local service reconfiguration.
Verifier: gh run view/list (executed, exit 0, reports exact SHA job results); git ls-remote (executed exit 0, observes remote heads); git tree comparison; registry metadata and GitHub release readback after publish. No local full suite: hosted CI is the full gate.
Stop: both releases and artifacts verified. If a real release blocker emerges, record it and resolve only scoped operational/version defects; broader code repair requires replan. Terminal: DONE, BLOCKED or NEEDS_HUMAN with explicit evidence. No silent gate bypass.
Memory: this unit plus scratch release evidence; one release operation cycle, not separate implementation units.
Resources: existing gh credential and OIDC workflow only; no secret reads; repository branch/PR/tag/release writes approved by request. No purchased compute or external messages. Hosted CI bounded to one active release per channel and one evidence-based flaky retry. Wall-clock checkpoint at two hours; do not claim completion at timeout.
Authoritative policies: MAINTAINERS.md, scripts/release.ts, release.yml, dev-version-bump.yml, service-lifecycle.yml from pinned RC.
Baseline: main 48f8186647d9ffb108d226dcfa91a64225aae2a7 v2.42.0; preview 0748cf50b67103bdc93123acae0d0c545a8cf902 version 2.43.0-preview.20260904 (not yet assumed published). RC push CI 33974061890 success; no exact RC Service lifecycle yet.
Escalation: release gate failures are blocking. Maintainer administrative PR merge is authorized by owner's merge-and-release instruction; record bypass use in PR description if required by rulesets, never fake approval. An external maintainer decision outside this scope is reported.

Readiness refresh: RC Service lifecycle run 33976119109 passed linux-systemd, macos-launchd and windows-schtasks. Full Windows test matrix remains excluded by ci.yml:643-656; installed/keyring Windows smokes passed. Open draft fixes 3669/3672/3673 document edge-case existing behavior; do not claim these are fixed. PR 3671 has an already-public policy-boundary report and is pending explicit security review; implicated assemble.ts is unchanged between released main and RC (last changed #1681). No new change to that boundary is proposed by this promotion. This audit is release readiness, not a claim that the entire product is defect-free.
