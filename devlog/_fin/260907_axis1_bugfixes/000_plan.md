# Axis 1: measured bug fixes and failure diagnostics

Completed: see [031_delivery_record.md](031_delivery_record.md) for merged commits, final CI, attribution and deferrals.

Archetype: satisfy existing contracts. Trigger: owner assigned axis 1 (#3809, #3464, #3661). Goal: deliver reviewable fixes through a manual PR chain and merge the verified scope. Non-goals: new account/retry policy, auth defaults, multipart recovery, releases, native stacks, sibling edits. Stop: merged feasible scope plus explicit unresolved dispositions. Escalation: defer a policy-dependent or unreproducible slice; reclaim a worker slice after two failed packets. Evidence: this unit plus ignored `.tmp/axis1/` and `.codexclaw` receipts. Resources: task-owned worktree/branches and GitHub repository access; Astra high leaves within host capacity; no caller-specified token or wall-clock budget.

Baseline: origin/dev 137d6a727; source PR #3809 at 4a1012359a522ddd6d7ff77203c9e5f3632d605c. Assigned 5cc8 checkout has pre-existing changes and remains untouched. Code lives in /tmp/ocx-axis1-20260907.

## Cycle map
1. wp0: docs-only scope, source audit and dependency roadmap; no runtime changes.
2. wp1: bounded quota, version-guidance and recovery-diagnostic changes; independent source/security review and structural checks. Runtime verification deferred explicitly to wp2.
3. wp2: publish ordinary PR chain, run final cumulative hosted CI, resolve findings, admin merge bottom-up and verify dev ancestry. Lower CI only if final CI fails.

## Delivery contract
The owner explicitly requests a manual delivery chain even where units are independent: quota -> CLI guidance -> recovery reasons, with each layer carrying its own tests and credit. This order is an integration order, not a fabricated runtime dependency. No native registration. Lower commits carry [skip ci] to defer duplicate workflow runs; final head does not. Skipped lower runs are never called passing. No local tests/typecheck/build suites and no hook-triggered suites; task pushes use --no-verify. Hosted ci.yml on the final head must cover all changed runtime/tests; lower-level runs are diagnostic only after final failure. Merge with --admin under the explicit owner exception; preserve original commits/trailers with merge commits, retarget each child to dev, and check integration trees against final evidence. Concurrent dev changes require fresh combined verification.

## Work boundaries
- Quota: src/providers/quota.ts, src/oauth/anthropic-routing.ts, src/oauth/health.ts, src/server/responses/core.ts, src/images/loop.ts, src/web-search/loop.ts, focused quota tests/layout, provider documentation.
- CLI: src/cli/version-skew.ts and relevant status/doctor consumers, tests/cli/cli-version-skew.test.ts, troubleshooting documentation. No service restart or repair behavior changes.
- Recovery: src/server/responses/agent-task-recovery.ts, agent-task-recovery-cache.ts, src/lib/bounded-body.ts and existing focused tests, Responses error projection if needed, recovery documentation. No expanded admission/retry.
- Main owns shared core.ts integration and test-layout files. Workers must not touch each other's paths or git index.

## Verification and acceptance
No local suite commands are executed. Source mapping, git diff --check and documentation structural checks are local evidence only. Hosted Cross-platform CI at final head provides runtime/typecheck/privacy and affected platform proof; inspect jobs for skipped coverage. Build completion is provisional until that run and independent audit succeed. Original PR author(s) must be named in commit Co-authored-by trailers, sourced from original commits/API; report authors may also be acknowledged accurately. Source-of-truth sync uses relevant existing structure and docs-site pages.
