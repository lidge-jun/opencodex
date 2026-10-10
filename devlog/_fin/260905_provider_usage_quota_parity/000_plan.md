# Provider usage and account quota parity

## Loop contract

- Archetype: spec-satisfaction repair; class C3, management contract changes receive C4 review.
- Trigger: provider detail shows foreign-looking selectors and inconsistent account quotas.
- Goal: truthful serving-provider/model accounting and consistent current/all-account quota views.
- Non-goals: rewriting user history, guessing the actual historical model, broad router strictness for custom aggregators, new providers, authentication changes, deployment or release.
- Verifier: existing remote CI for regression tests; local static type checks, GUI build/lint, privacy scan and isolated browser/API smoke. **No local tests or suites**, including git hooks. Commit/push with `--no-verify`.
- Stop: audited slices, screenshots and exact-head CI, then bottom-up admin merges and fetched-dev ancestry.
- Memory: this unit and the session-bound goalplan/ledger.
- Outcomes: DONE with evidence; external BLOCKED, authority UNSAFE/NEEDS_HUMAN, or stated-bound BUDGET_EXHAUSTED only.
- Delegation: read-only inventory/audit, bounded disjoint implementation only by P amendment; no model/effort overrides. Main reclaims after two distinct failed dispatches.
- Scope/resources: current managed checkout only; existing GitHub PR/CI credentials; sanitized read-only runtime evidence; no inference or reset-credit spending; no new paid services. 90 minutes active work per phase, 6 hours total; no explicit token budget requested.

## Dependency map

1. `roadmap`: docs-only cycle; lock all decade plans.
2. `attribution` / `010_attribution.md`: routing and accounting foundation, regression coverage; bottom stack branch `codex/provider-usage-attribution` targets `dev`.
3. `quota-api` / `020_account_quota_api.md`: credential-scoped readers and capability DTOs; `codex/provider-account-quota-api` targets the bottom branch.
4. `quota` / `030_quota_views.md`: current-account and all-account presentation consumes the account API; `codex/provider-quota-parity` targets the API branch.
5. `landing` / `040_stack_landing.md`: independently audit final stack and land bottom-up after exact-head CI.

## Existing ownership

```text
src/router.ts                         route resolution
src/usage/{log,summary,cost}.ts        append-only rows and aggregation
src/providers/quota*.ts               quota capability and reports
gui/src/provider-workspace/           pure report adapters
gui/src/components/provider-workspace/ provider tabs
structure/05_gui-and-management-api.md current contract
tests/{routing,usage,providers}/       existing regression domains
gui/tests/                            rendered component contracts
```

Reuse the existing report adapters, QuotaBars and account panels. Doing nothing keeps misleading model labels; deleting rows loses real usage; configuration alone cannot clarify historical rows. No new quota client or history database is justified.

## Baseline and verification constraints

Base HEAD `526d4bf64` matched fetched `origin/dev`; initial tree clean.
`bun run typecheck` could not run before dependencies existed (TS2688); after frozen-lock install with scripts disabled the bundled Bun wrapper requires its postinstall. `node node_modules/typescript/bin/tsc --noEmit` exited 0 and reads repository `tsconfig.json`. Use that equivalent direct checker without enabling lifecycle scripts. Remote CI owns test execution, explicitly overriding the local-suite recommendations in repo/skills.

## Design read

Keep the supplied developer-dashboard layout, existing CSS tokens, font and icon set. Variance 2, motion 1, density D8. No visual concept generation: this is a utility dashboard repair, not a redesign. Current quota must sit below usage statistics; provider-wide capacity and current-account quota are different concepts. Unknown is not zero, observed is not freshly probed, and an unsupported API is not a failed account.

## Continuity

Roadmap locked after Kant's independent audit and two repair rounds, final VERDICT: PASS.
Docs-only delivery: 000, 001, 002 and all four decade docs; no production changes.
Static source checker and GUI build passed; existing chunk-size warning only. No local tests.
Next work-phase: attribution. Open risk: unseen historical upstream model identity cannot be
recovered; we qualify only saved fallback provenance instead of guessing or rewriting rows.

Attribution D: `9a9ad98b8`, PR #3582, CI run33938837845 all four backend test shards,
GUI gates (1371 pass / 0 fail), API usage succeeded; independent Volta PASS. Remaining macOS
jobs are still mandatory at landing, not claimed green. Next quota-api P reverified 020 against
the unchanged quota/management baseline; attribution changes do not alter its signatures.
API layer branch `codex/provider-account-quota-api` starts at the verified attribution head.

Quota API D: `768e5a004`, PR #3584, run33940065554 all four backend shards/gates/API usage
successful, including explicit credential isolation, passive no-network and post-await age
regressions. Wegener full/interdiff review and Kant omitted-mode delta PASS. No local validation
was executed. Next UI P reverified 030 against that additive row contract; remaining platform
rollups remain mandatory before merge. UI branch `codex/provider-quota-parity` starts here.

## Delegation write map (locked before Build)

User reiterated no local suites during quota-api A. No local test suite has been run;
reported regression results came from GitHub Actions. From this point no further local
typecheck/build/lint/scan commands either: command-based validation is remote CI only.
Source inspection and browser observation remain scoped QA; receipts may only wrap remote
CI result checks. This supersedes the earlier local-static/build verification allowance.

- Attribution cycle: Harvey owns `src/usage`, `src/router.ts`, the identified Chat/Messages error catches, `src/server/management/shared.ts`, and corresponding existing backend regression files. Main owns the provider model annotation/share/caching UI, its GUI regressions, docs, commits and CI. No overlapping writes.
- Quota API cycle: Euclid owns quota readers/key-cache/types and relevant provider regression files. Main owns management route joins, API-route regressions and docs; clarify exact exported signatures before either writes.
- Quota UI cycle: main owns shared `types.ts`, `report.ts`, NEW ProviderAccountQuota/ProviderCurrentQuota, ProviderDetails/Overview/Usage, all locale keys, public docs and direct shared-renderer regression. Harvey owns useProviderAccountPools, Providers page refresh coordinator, shell refresh callback epoch, ProviderAuthPanel and focused hook/refresh regressions. Worker may read shared contracts but never edit them. No overlapping writes or local validation.
- Independent Kant audits plans read-only; fresh independent final implementation review remains required. No worker changes FSM, goals, branches, commits or remote state, and no worker runs local tests.
