# Restore roster registration after Claude first-party setup

First-party setup can report success without regenerating the selected OpenCodex agents. Reconcile the existing roster at the successful setup boundary so a subsequent Claude session can discover its routed workers. This fixes a demonstrated missing lifecycle step; it does not claim to explain every missing-agent report.

## Loop specification

- Class: C4 care for the management API surface; one satisfy-spec PABCD cycle, wp1.
- Trigger and goal: reported missing third-party subagents after Claude 1P connection; restore registration and merge a focused PR to dev.
- Non-goals: no new settings, catalog schema, GUI redesign, account changes, release, installation or live configuration mutation.
- Verifiers: isolated management/first-party regression tests observe generated files and rejected writes; typecheck checks the TypeScript tree; privacy and structure gates check repository contracts; exact-head hosted CI gates merge. No live provider request needed.
- Stop: reviewed fix, passing required CI and verified dev merge. DONE requires that evidence; unresolved failure is reported honestly, never as passing.
- Artifact: this unit and 010_registration.md; scratch command output stays in .tmp/claude-1p.
- Escalation: new routing/auth semantics or an irreconcilable client-specific report requires a revised scope. No token/cost/wall-clock budget was supplied; use existing local tools and authenticated repository access only.

## Evidence and decisions

- D1: accept existing syncClaudeAgentDefsBestEffort as the registration owner. The dedicated CLI 1P return at src/server/management/agent-settings-routes.ts:1681 bypasses its ordinary call at line 1952.
- D2: preserve all rejection/rollback, disabled integration/injection and sibling-ownership behavior. Do not change low-level first-party settings reconciliation.
- D3: cover the equivalent Desktop first-party apply success boundary if confirmed; no gateway behavior changes.
- Architect: inherited V1 agent 01a0fff4-fd56-73e3-8aaf-1d9c594927ed. Initial GUI navigation proposal rejected because no hidden-control gate was demonstrated. Runtime tracing identified the skipped registration step instead. Reflection: ALIGNED; main folded exact Desktop placement, pre-existing-file preservation and best-effort wording into 010. Independent audit pending.
- Main verified buildClaudeAgentDefs can build the configured roster without writing files. This does not establish why startup did not leave files in a particular installation.

## Delivery

One ordinary PR to dev. Main owns branch/commits/CI/merge. Inherited worker owns runtime and tests; main owns documentation and independent review coordination. No new dependencies. The user subsequently prohibited all local testing. Final acceptance is exact-head hosted CI plus source-only review; no further local tests, builds, typechecks or QA are permitted.

Baseline verifier evidence: `bun run test -- tests/claude-integration/claude-management-api.test.ts tests/claude-integration/claude-desktop-first-party.test.ts tests/claude-integration/claude-agents-inject.test.ts tests/claude-integration/claude-agent-startup-sync.test.ts` exited 0 (123 pass, 0 fail). Each explicit argument observes an owning route/generator/startup surface. Initial wrapper failure was the unexecuted pinned Bun dependency postinstall after ignore-scripts; running its checked-in dependency installer restored the wrapper. No lockfile changed.

Independent A review: inherited reviewer 01a0fffb-254e-7563-8a0f-77ab1d70ca03 returned PASS with no blockers. Explicit security scope covered management admission, refusal/rollback exits and helper ownership gates. No auth or credential format changes are planned.

## Verification correction

The user prohibited local tests during C. The in-progress full suite was terminated (exit 143), not counted as passing. Local checks reported above predate this correction and are historical only. Remaining verification and final acceptance use GitHub Actions against the PR head. The implementation remains the audited two-call reconciliation fix.
