# 000 — WP11 PR #526 final rerun and merge plan

## Objective

Finish PR #526 after its two dev-baseline blockers were repaired:

- WP9 merged PR #550 to remove broken devlog gitlinks that prevented checkout.
- WP10 merged PR #552 to fix the unrelated Windows Desktop 3P path regression
  that made the rebased PR #526 hosted `windows-latest` job red.

This work-phase targets PR #526 only. It must rebase the existing
`codex/catalog-written-signal` branch onto the current `origin/dev`, repair any
direct PR #526 test-contract drift exposed by audit, push the current head, wait
for the latest hosted checks on PR #526, and squash merge only if the latest head
is clean.

## Loop-spec

- Loop archetype: spec-satisfaction repair; verifier is PR #526 latest hosted
  checks plus already-audited local targeted tests from WP1.
- Write scope: existing PR #526 branch `codex/catalog-written-signal`; no new
  production code unless the rebase exposes a conflict or direct regression.
  Test-only repair is allowed for direct #526 contract drift. Current allowed
  repair: add required `comboOmissions: []` to the
  `tests/injection-model-api.test.ts` `syncCatalogModels` mock return.
- Out-of-scope: PR #527 process restart behavior, PR #528 image bridge,
  security/auth/permission/data migration, main/preview/release branches.
- Remote branch handling: do not delete `codex/catalog-written-signal` on merge
  because PR #527 may depend on it.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP11 | `010_phase1.md` | Rebase PR #526 onto current dev, rerun local smoke, push, wait hosted checks, squash merge if green. | WP9 + WP10 merged to `origin/dev` |

## Accept criteria

- PR #526 branch is rebased onto current `origin/dev@7c74e0a22ec96dd5849d3d7253758f0ab15d9737` or newer current dev.
- Local targeted verification still passes after rebase:
  `bun test tests/codex-refresh.test.ts tests/codex-sync-api.test.ts tests/injection-model-api.test.ts`,
  `bun x tsc --noEmit`, and `git diff --check origin/dev`.
- PR #526 latest hosted checks all pass on the latest head after push.
- PR #526 is squash-merged to `dev` only if latest head/checks remain clean at
  merge time.
- The remote `codex/catalog-written-signal` branch is preserved.
- Immediate pre-merge stale-base gate passes:
  - PR head equals the pushed rebased SHA.
  - remote `refs/heads/dev` still equals the rebase base SHA.
  - all checks are completed successfully for that exact head.
  - `mergeable` is `MERGEABLE` and `mergeStateStatus` is `CLEAN`.
  - If dev advanced, restart from fetch/rebase/local tests/push/hosted checks.
