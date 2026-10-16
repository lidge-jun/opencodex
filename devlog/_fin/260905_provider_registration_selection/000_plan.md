# Provider registration model-selection onboarding

## Loop specification

- Archetype: spec-satisfaction. Trigger: confirmed interview in this session.
- Goal: a newly registered non-OAuth provider with >=20 usable models starts with
  exactly the Models group's **all model switches OFF**, while the provider stays
  ACTIVE. OAuth/ChatGPT login keeps its defaults. Both receive useful onboarding.
- Non-goals: request ACLs, provider disablement, retroactive existing-user resets,
  global new-model policy changes, account/credential behavior changes, releases,
  deployments, live user-home mutations, unrelated UI redesign.
- Verifier: independent audits; committed boundary/integration regressions run in
  exact-head GitHub CI; local TypeScript, lint/i18n, builds, and isolated manual UI
  smoke. No local test suites. Existing direct typecheck command
  `bun node_modules/typescript/bin/tsc --noEmit` exited 0 at P; tsconfig includes
  src. `git diff --check` is whitespace-only, not behavioral proof.
- Stop: all phase criteria, resolved blockers, green exact-head CI, authorized
  no-verify push/admin merge and fetched-dev ancestry. No prior Astra CI waiver.
- Memory: this unit, .codexclaw/plan/260905_provider-registration-selection.md,
  bound goalplan and receipts. Continue after compaction from these records.
- Terminal outcomes: DONE/NOOP only with proof; external dependency BLOCKED,
  missing authority NEEDS_HUMAN, unapproved risk UNSAFE, three-hour wall bound
  BUDGET_EXHAUSTED. No explicit token cap or new paid-service budget.
- Tool/write scope: current managed worktree, existing git/GitHub/cxc/browser
  access, isolated test homes and read-only reviewers. No port-10100 experiments.
- Escalation: reclaim after two failed independent reviewer packets; additional
  delegated writes require a P amendment. Main owns code and every FSM edge.

## Confirmed interview decisions

1. New provider registrations only. Existing registrations, re-login, account
   additions, key rotation and force overwrite preserve choices.
2. OAuth exemption follows effective connection mode, not provider family.
   Native ChatGPT `forward` is exempt; API-key mixed-auth connections are not.
3. OFF means the screenshot's Models-tab **모두 끄기**, not provider disablement or
   a new API-request prohibition.
4. Unknown initial model count withholds model exposure until reliable discovery;
   registration itself remains saved and the provider remains active.
5. GUI completion popup directs users to Models, including OAuth registrations.
6. CLI prints model-management CLI commands, not browser-opening instructions.
7. User authorized complete implementation, --no-verify push and admin merge only
   after CI passes; no local suites.

## Current owners and reuse decisions

| Owner | Current behavior / consequence |
| --- | --- |
| src/providers/new-model-policy.ts:38 | First baseline hides nothing; keep later-arrival behavior separate. |
| src/server/management/model-routes.ts:626 | Group OFF appends canonical selectors to disabledModels, leaves provider active. Reuse semantics. |
| src/codex/catalog/provider-fetch.ts:1991 | Empty selectedModels means all; never use [] as none. Shared public visibility filter. |
| src/codex/convergence.ts:445 | Mutable discovery projection before catalog preparation; authoritative versus degraded results already exist. |
| src/codex/convergence.ts:668 | Discovery metadata/disabledModels publish only after admitted catalog commit. Extend same ownership. |
| src/server/auth-cors.ts:760 | Exhaustive provider-field policy; internal initialization metadata must not become editor authority. |
| src/cli/provider.ts:214 | Force overwrite replaces provider row; explicitly retain selections and initialization state. |
| src/oauth/login-cli.ts:135 | Existing key-row merge preserves costs only; add selection preservation. |
| src/oauth/index.ts:1435 | OAuth upsert rebuilds provider; preserve selections without changing auth/key rules. |
| gui/src/pages/Providers.tsx:472 | Registration completion currently closes Add and shows a toast. Own popup here. |
| src/cli/models-runtime.ts:17 | Existing `ocx models live`, `enable`, `disable`, and provider on/off commands; no new model command needed. |

Doing nothing or changing only defaults cannot change first-registration behavior.
Changing existing arrival bootstrap globally would alter existing users. Reuse
visibility/convergence and add a narrowly owned, opt-in registration marker.

## Dependency-ordered work phases

- wp0: docs-only roadmap cycle, including complete 010 and 020 documents; no code.
- wp1 / 010: registration-state contract, policy, creation boundaries, pending
  visibility and convergence persistence, regression tests. Independent core proof.
- wp2 / 020: consume that state for GUI popup and CLI instructions, i18n/docs,
  rendered proof, final CI and delivery.

Publication: two dependent PR layers if size requires it. Core PR may be opened
after wp1 but is not landed until user-facing onboarding is ready, to avoid
shipping unexplained all-OFF registration. Use merge commits for a live stack so
parent ancestry is preserved, land bottom-up, retarget the child to dev and check
its exact-head CI again. Do not rewrite or move this managed worktree.

## OPEN ASSUMPTIONS retained from interview

- Count unique usable Models-tab switch rows from complete successful discovery
  or an intentional static catalog before visibility filtering. Use the same
  canonical selector dedupe as the management inventory; metadata overrides must
  not remove a row from the count. A distinct catalog ID with its own switch counts;
  display-only alias labels on the same row and duplicate selectors do not.
  19 preserves defaults; 20 triggers all-OFF.
  The earlier physical-ID-only interpretation was an unconfirmed implementation
  assumption, not a user requirement; keeping count and switch targets aligned
  avoids a separate hidden counting policy.
- Static catalogs participate even though the existing new-model-arrival helper
  skips `liveModels:false`.
- Initial state must be separate from known-model baselines. Overwrite paths must
  actually preserve selectedModels/modelPreset/newModelPolicy and state, not only
  avoid calling the new initializer.
- Later-arrival policy stays independent. It may expose later arrivals if set ON;
  this task changes initial registration, not that existing policy.
- JSON completion adds structured next steps without prose; no-wait results remain
  pending rather than claiming successful authentication.
- Browser QA uses fake local providers/test credentials and isolated homes.

## Enforcement limits

This is user-facing initialization/visibility policy, not an authorization barrier.
Tier: runtime config/catalog behavior with tests (E8), not agent permission control.
Executing surfaces: registration writers, convergence, visibility filters.
Known bypass: trusted operator edits raw config or submits explicit model IDs;
residual: OFF does not reject direct model requests, by confirmed scope.
Final authorization layer: none added. Do not describe it as API access control.
