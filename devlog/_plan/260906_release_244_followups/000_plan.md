# Release 2.44 follow-up integration

## Loop contract

- Archetype: spec-satisfaction repair; class C4 for governance, replay and release; C3 for bounded client changes.
- Trigger: owner authorized the named backlog, bottom-up stacked PR integration, --no-verify pushes, admin merges, maintainer dev policy and release on 2026-09-06.
- Goal: publish the verified next release after these narrowly scoped fixes.
- Non-goals: new providers, authless Desktop defaults (#3689), Anthropic replay/cache redesign (#3719), unrelated branch cleanup, direct live Kiro calls.
- Verification: GitHub Actions only for all test/typecheck/build/privacy commands. Local reads, git diff --check, JSON validation and review are allowed. User prohibition overrides local verification defaults. Existing ci.yml dispatch lane=all is the Windows six-shard authority; service-lifecycle.yml has workflow_dispatch. Command existence checked by reading workflow inputs and scripts, not running prohibited suites.
- Stop: every mapped criterion proved, final npm/tag/provenance validation complete. A red gate is repaired, never relabeled green. Old bug reports without current reproduction receive explicit evidence-limited outcomes.
- Memory: numbered unit docs and session-bound .codexclaw goalplan/ledger. Sensitive log analysis and draft security reviews stay in .tmp/release-244.
- Delegation: xai/grok-4.6 only, bounded disjoint workers and independent reviewers. Main owns every FSM edge, commits, pushes and GitHub writes. Reclaim after two distinct failed agents; delegation changes enter at P.
- Resources: existing GitHub account, repository and release OIDC only; no new credentials/purchases. Unlimited requested-model delegation within available concurrency; no owner token/cost cap. Each subprocess <=30 minutes, CI polls <=60 seconds, each phase investigation checkpoint at 60 minutes with evidence-based continuation. No implicit exhausted outcome.

## Snapshot and sequence

Baseline dev: af344a28eabcee09a5e04c48ab897449792719c2, version 2.44.0. Latest published stable is 2.43.0. Refresh before every layer.

| Work phase | Design | Dependency / independent proof |
|---|---|---|
| roadmap | this unit | Lock all decade designs; docs only |
| policy | 010_policy.md | Establish truthful maintainer integration authority |
| task-input | 020_task_input.md | Shared Responses parser contract |
| task-guidance | ../260906_stateful_task_guidance/010_raw_boundary.md | Review follow-up: align stored raw guidance before Kiro resumes |
| kiro-results | 030_kiro_results.md | Consume parsed tool-result sequence |
| opaque-recovery | 040_opaque_recovery.md | Retry and terminal semantics on composed routing |
| combo-recovery | 050_combo_recovery.md | Route recoverable parsed payloads |
| grok-terminal | 060_grok_terminal.md | Client terminal reconstruction on composed relay |
| quota-proxy | 070_quota_proxy.md | Refresh network-path evidence on integrated runtime |
| usage-source | 080_usage_source.md | Attribute actual selected transport after routing |
| dashboard | 090_dashboard.md | Presentation on integrated behavior |
| release | 100_release.md | Final ancestry, Windows, lifecycle, publish |

One work-phase is one PABCD cycle. Publish short dependency stacks; use merge commits for parents with live children, squash bounded terminal carries if safe, and recascade after any squash. Independent presentation/governance slices remain their own PRs even though execution is sequential. Every carried contributor receives account-linked Co-authored-by credit. Preserve snapshots of source heads.

## Evidence boundaries

#3735/#3734 are public current-SHA reports; independently inspect code, author local-pass statements remain reports. Kiro proof is recorded-log shape plus synthetic CI tests, never a live quota-consuming request. #3644 has a network A/B report and landed diagnostic #3693; do not claim a Windows runtime reproduction from mocked tests. Detailed private logs are never committed.

## Owner steering: asynchronous CI

From the Grok unit onward, implementation/review and PR publication proceed
without waiting for hosted CI. Each cycle records exact-head CI submission; its
runtime acceptance criterion stays open under release convergence. CI failures
are handled asynchronously and stacks cascade after repairs. Bottom-up merges
and release publication still require successful checks on their final heads.
This changes scheduling only; no test, platform or release criterion is removed.
