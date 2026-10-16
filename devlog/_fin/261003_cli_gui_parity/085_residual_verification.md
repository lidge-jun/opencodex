# WP8 residual workflow verification

The three residual task gaps are implemented in source checkpoint `70de53256d`. Log filtering selects a bounded raw window before applying dashboard predicates; model search changes only displayed model rows; companion usage applies saved display preferences to two independently observed ranges; explicit API-key quota reads preserve the existing per-key server owner. Public help, operating recipes, English/Korean CLI documentation and the CLI structure owner were updated together.

This record describes executed local checks. It is not a claim that final publication or all six current-head CI runs have completed. Those receipts remain separately required by 080–082.

## Integration and provenance

Pinned `dev` `0818ea1812a028e1c14cd0b0511b44863407bc52` was merged into the foundation and propagated through all six existing manual branches. Every child contains its actual refreshed parent. No rebase, force push, native stack registration or PR merge was performed. The first five updated branches were pushed for fresh per-PR checks.

The expected-layout fixture exceeded the repository size threshold in the preflight union. Sixteen pairs of existing bookkeeping lines were joined at the foundation. A duplicate-key-rejecting JSON parse verified identical values and key order; a string/escape-aware tokenizer verified identical bytes after removing only whitespace outside strings. No test registration, expectation, seed or cap changed. The final five new test registrations are present in both maps. The refreshed tip fixture is 1991 lines, below the strict 2000-line boundary.

The WP7 hosted failure was a root-help wording regression. Restoring “Read or follow request logs” retained existing navigation expectations and the new leaf commands. The original navigation suite passed without weakening its assertion.

## Executed checks

All fixtures use isolated homes and synthetic transport/provider dependencies. No live account, credential, proxy, paid provider request or application configuration was used.

| Command | Observed result | Scope |
| --- | --- | --- |
| `bun run typecheck` | exit 0 | Integrated source including all residual repairs. |
| `bun test tests/cli/cli-log-view-filter.test.ts tests/cli/cli-account-key-quota.test.ts tests/cli/cli-observe-snapshot.test.ts tests/cli/cli-usage-model-search.test.ts tests/cli/cli-companion-usage.test.ts tests/cli/cli-usage-report.test.ts tests/cli/cli-usage-hub.test.ts tests/cli/cli-usage-scope.test.ts` | 193 pass, 0 fail, 1473 assertions | New workflows, actual DTO/handler fixtures, GUI conformance, existing usage render/scope/self behavior. |
| `bun test tests/cli/cli-help-navigation.test.ts tests/cli/cli-log-follow.test.ts tests/cli/cli-injection-follow.test.ts tests/cli/cli-usage-scope.test.ts tests/cli/cli-usage-hub.test.ts tests/cli/cli-usage-report.test.ts tests/server/management-route-registry.test.ts` | 155 pass, 0 fail, 1493 assertions | Navigation, legacy streams, usage and registry. This earlier working-tree run predates the final model-view rendering adjustment; the 193-test run above covers that later rendering. |
| `bun test tests/cli/cli-capability-data.test.ts tests/cli/cli-capability-operation-workflows.test.ts tests/ci-workflows/skill-ocx-generated.test.ts tests/ci-workflows/skill-ocx-workflows.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | 130 pass, 0 fail, 2277 assertions | Pure discovery, generated reference, recipes and both test maps. |
| `bun run structure:check` | exit 0 | Source ownership and structure links. |
| `bun run skill:surface:check` | exit 0; all 9 generated files current | Generated command reference. |
| `bun run privacy:scan` | exit 0 | Candidate source/fixtures; final published tree is checked separately. |
| `bun scripts/file-size-ratchet.ts` | exit 0 | Candidate file sizes; no cap increase. |
| `git diff --check` | exit 0 | Source checkpoint whitespace. |
| `cd docs-site && bun install --frozen-lockfile && bun run build` | exit 0; 561 pages, 78,073 internal links checked | Public CLI docs at the source checkpoint. |

Counts overlap and must not be added as unique tests. Historical source phases retain their own evidence in their numbered verification documents. The quota mutation dropping forwarding and the log mutation changing the speed upper bound each failed their targeted regression before restoration; these are narrow mutation observations, not a whole-suite mutation score.

## Remaining closing evidence

Independent security/correctness review at the source checkpoint reported no blocking issues. Its two direct focused runs passed 125 and 110 tests, with 1045 and 762 assertions respectively; they overlap main's proof and are not added to it. The report binds 18 source/test hashes and separately limits its claims to the reviewed implementation.

Candidate root-CLI QA passed 49/49 invocations in 10 groups, including 26 negative cases. Each invocation retained stdout, stderr, exit status, request trace, file-state comparison and process/sandbox teardown. The source identity remained equal from start to end at the checkpoint, with documentation work still dirty. Controlled discovery/transport fixtures drove real CLI handlers and transformations; actual DTO/handler acceptance is separate test evidence. This candidate is not the final frozen-tree receipt.

Final task-ledger validation and negative fixtures, independent functional/docs acceptance, frozen root-CLI QA, source-bound receipt and six current-head hosted CI receipts complete the acceptance contract. Any failure remains open until its cause is resolved. The archive location itself is not passing evidence.
