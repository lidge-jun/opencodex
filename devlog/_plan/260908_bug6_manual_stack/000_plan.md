# Six-item manual integration stack

## Loop specification

- Archetype: satisfy the six named bug contracts, with a docs-only roadmap cycle followed by six implementation cycles and one integration cycle.
- Trigger: owner request on 2026-09-08 to use one stack, repeated PABCD, Astra high delegates, no local suites, no-verify pushes, and merge through dev.
- Goal: Go/xAI child-result compatibility, separated V2 guidance and server-owned presets, and correctly scoped reset-credit recovery.
- Non-goals: releases, main/preview, account changes, real credit consumption, unrelated cleanup, native GitHub stacks, local product tests/install/typecheck/build.
- Verifier: independent source audits and GitHub `ci.yml` at each candidate head; final dispatch `lane=all`. Docs-only verification checks numbered artifacts and whitespace without running product code. Every activation fixture and observable result is specified in the phase designs.
- Stop: every named item has a fresh terminal disposition, all nonempty layers have landed through reviewed PRs, final hosted gates pass, and fetched ancestry plus landed-tree comparison prove integration.
- Artifacts: this numbered unit, ignored `.tmp/bug6-01a07e9d/`, and session-bound `.codexclaw` ledger/receipts. New unpublished security analysis stays in scratch only.
- Outcomes: DONE requires all evidence; NOOP requires proof the full named contract already landed; unresolved work remains pending; genuine external blockers are reported without inventing proof.
- Escalation: main reclaims failed delegate slices after two distinct failures. Delegation is preplanned below. No further user approval is needed for the explicitly authorized pushes/merges. Permission/ruleset changes remain outside scope.
- Resources: existing repository/GitHub access, synthetic fixtures, gpt-6-astra high leaf agents within host concurrency. No user-set token/cost/time limit; no extra resource budget is invented. Bounded external polls and owned-job cleanup.

## Baseline and ownership

Initial integration base: `9e1468d4b7a41b498ed2aca98507ada2c741afea`.
The session remains in its managed worktree and adopts branch `codex/bug6-01a07e9d-roadmap` in place. Thirty pre-existing document files are fingerprinted in ignored scratch; they are excluded from every commit. Main owns Git operations, plan/FSM, CI decisions and merges. Source investigation lanes are disjoint Go/xAI, V2, and credit pairs. B-stage workers receive only the current audited phase scope, never speculative product-write authority.

## Work-phase map

| Cycle | Source | Deliverable | Delivery dependency |
| --- | --- | --- | --- |
| wp0 | This roadmap | Audited full file/behavior map and verification contracts | none |
| wp1 | PR #3838 | Remaining Go private-input compatibility and regression coverage | wp0 |
| wp2 | Issue #3907 | Strict xAI child-result continuation | wp1 normalization contract |
| wp3 | PR #3944 | Separate proxy V2 guidance from native policy | wp2, owner-requested cumulative chain |
| wp4 | PR #3951 | Server-owned proactive preset and dashboard semantics | wp3 policy vocabulary |
| wp5 | PR #3965 | Canonical reset operation alias settlement | wp4, owner-requested cumulative chain |
| wp6 | Issue #3973 | Account/scope/generation-bound post-reset recovery | wp5 operation identity |
| wp7 | All six | Exact-head CI, UI artifact observation, bottom-up landing and original dispositions | wp1–wp6 |

The owner explicitly chose a single chain across otherwise independent domains. Each PR contains only its own layer. No empty product PR is created for already-landed work; its verified NOOP record remains in the chain. Revalidate each decade design at its P boundary. Preserve contributor commit identity/trailers on every carried implementation.

## Verification and landing contract

`ci.yml` accepts all pull-request bases (`pull_request: {}`); manual child PRs therefore receive product CI. Its gates job runs typecheck, dashboard tests, privacy scan and the relevant build. Windows/control coverage is dispatched explicitly. A green hygiene or enforce-target check is not product evidence, and skipped/cancelled jobs are not passing tests. Runtime validation stays hosted; local checks are NOT RUN by owner instruction.

Before each merge refresh head/base, membership, reviews, required checks and actor. Authenticated actor `lidge-jun` has admin permission (live preflight); MAINTAINERS.md permits recorded maintainer integration into dev without self-approval, while retaining outstanding maintainer objections and security review. Merge bottom-up, retarget the next owned child to dev, preserve branches while referenced, and revalidate the resulting base/head. Do not alter source authors' branches. Close only fully resolved source items after landing.

## Continuity ledger

- wp0 P: live source intake and complete decade designs in progress; no product changes.
- wp0 A: independent Astra high reviewer returned PASS, zero blockers. Full source appendices remain in ignored scratch. An absent REST stack field means unknown membership, not proven absence; inspect the stacks endpoint before delivery.
- wp0 B/C handoff: all eight numbered roadmap documents are complete. Structural validation passed with 30 pre-existing user files preserved. Next cycle is wp1 Go residual implementation. Candidate cycles c1–c6 require their scoped audited delta and matching-head PR CI; c7 retains all six terminal dispositions and final integration proof.
- Remote documentation verification uses isolated `macmini-cf` scratch, not the deploy-docs workflow. Existing Node 24.20.0 is available under the remote user's nvm tree; select the repository-pinned Bun in that scratch environment and record actual versions. No live service or account state is touched.
