# Verification strategy and observed baseline

Baseline: `9f89b7265b754eb681215ad327fc9459af37b9e1`, the completed CLI-help stack on dev. This unit starts on `codex/cli-parity-foundation` in the existing managed worktree.

Before implementation, the following ran successfully:

| Command | Result | What it observes |
| --- | --- | --- |
| `bun run typecheck` | exit 0 | The repository TypeScript graph, including src/cli. |
| `bun run structure:check` | exit 0 | Structure manifest, declared source ownership, existing paths and invariant bindings; not prose correctness. |
| `bun run skill:surface:check` | exit 0 | Generated skill reference compared with src/cli/capabilities.ts. |
| `bun test tests/cli/cli-capabilities.test.ts tests/cli/cli-capabilities-arguments.test.ts tests/server/management-route-registry.test.ts tests/ci-workflows/skill-ocx.test.ts` | 62 pass, 0 fail, 1180 assertions | Capability parsing, leaf-module import boundary, management declaration reconciliation and shipped-skill command/consent boundaries. |

Raw evidence is in the ignored `.tmp/cli-parity/baseline-*.log` files. The source-map command is unavailable in the installed plugin (it requires a codexclaw development checkout); bounded file inventories and exact source anchors replace it.

## Per-unit proof

Each implementation phase owns focused regression files with exact expected HTTP method/path/body, safe structured output, error/exit mapping and no-request assertions for rejected inputs. Tests use isolated homes and injected RuntimeApiDeps or a disposable loopback fixture; they do not mutate the operator's running proxy, credentials, client applications or accounts.

Acceptance includes real CLI subprocess invocations with separated stdout/stderr, recorded exit codes and plain/pipe output. Help/version paths must remain offline and write-free. For mutations, run an equivalent isolated management-route contract scenario where appropriate; mocking a request records transport shape but does not by itself prove server acceptance. Input files/stdin, cancellation and confirmation paths receive explicit reachable scenarios. Each QA-owned temporary server/process has a teardown receipt.

Existing global gates remain intact. New test files enter both test-layout maps. Source changes update their owning structure docs; public behavior updates CLI docs and the operating skill. Generated output is regenerated from its actual registry owner and checked for drift. Prose/UX semantics receive independent human-style review, not a test that only looks for a phrase.

## Broad verification and publication

Focused tests and type/static/document gates run locally. Full-suite and platform coverage use the current-head hosted PR CI for every layer; the repository's full suite has tens of thousands of tests and concurrent worktrees make repeated local full/changed runs disproportionate. This is the resource-scoped verification plan, not permission to ignore failing focused tests. Record exact commands and the coverage left to CI in each PR.

The preceding CLI-help task recorded four local full-suite failures, all reproduced on its untouched baseline (three restart-lease failures and a pre-request directory snapshot EISDIR). Those records are history, not current-unit passing evidence. If this unit encounters a failure, inspect it and attribute or repair it with fresh source/command evidence. No skip, threshold relaxation, retry-as-fix or unrelated suite substitution is allowed.

Each PR must retain its own current-head CI run, event, attempt, expected executed jobs, checkouts actually tested and open-review dispositions. Canceled/skipped/missing jobs are not passing tests. The stack remains open for review at completion; merge/release is not part of this request.
