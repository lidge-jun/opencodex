# A1 — Config-backed routed removal

Depends on wp0. Carry all #6530 behavior from `451bcd43e` without inherited #6537 work.

## File changes

- NEW src/codex/catalog/routed-removal.ts: source #6530 helper contents; `UnconfiguredRoutedRemoval { namespaces }`, namespace authorship/native alias/account-bound filtering, `configEnablesRoutedNamespace`, `unconfiguredRoutedRemoval`, `routedRemovalBackedByConfigFile`, count-only warning.
- MODIFY src/codex/catalog/build-entries.ts: export existing `isOcxAuthoredRoutedEntry`; preserve predicate.
- MODIFY src/codex/catalog/retained-sync.ts: before replacement compute removal; hold existing C inside K through snapshot admission and replacement; missing/fallback/enabling snapshot or busy C returns unchanged/refused with count. Extend result skippedReason and count fields.
- MODIFY src/codex/convergence.ts: candidate state captures removal; existing K→C guarded commit revalidates snapshot and returns refused/unbacked-routed-removal before fixedCommit.
- MODIFY src/codex/refresh.ts: propagate skippedReason/count and suppress cache invalidation for every refusal.
- MODIFY src/codex/sync.ts: both sync variants print count-only warning and preserve it in result.
- NEW tests/codex-integration/codex-catalog-routed-removal.test.ts: carry source helper tests.
- MODIFY tests/codex-integration/codex-catalog-sync-hardening.test.ts, codex-convergence-contract.test.ts, codex-sync-api.test.ts: carry source regressions; existing deletion cases save their driving config as real deletion does. Preserve all original assertions.
- MODIFY scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json: register new tests with normal one-entry-per-line formatting.
- MODIFY structure/codex-home.md: removal rule and warning, explicit restore exception, K→C interval.

Result field chain: created by retained sync/commit, projected through refresh/sync, consumed by sync/API warning; in-memory candidates have no disk serialization. Snapshot source is existing diagnostics discriminator; no new config schema. Refusal result is serialized by existing response machinery.

## Acceptance and commands

Run `bun test tests/codex-integration/codex-catalog-routed-removal.test.ts tests/codex-integration/codex-catalog-sync-hardening.test.ts tests/codex-integration/codex-convergence-contract.test.ts tests/codex-integration/codex-sync-api.test.ts tests/codex-integration/codex-sync-new-model-policy.test.ts tests/codex-integration/codex-models-cache-invalidate.test.ts` plus common gates.

Trigger missing, unreadable/salvaged and still-enabled saved configs: catalog/cache remain byte-identical with refusal. Hold C in parent while child sync runs: same refusal. Persist deletion/disabled provider: rows removed. In-namespace model deletion, foreign rows, trusted account rows, combo/native aliases, fresh native catalogs and restore remain supported. A source test failing on old behavior and passing on the replacement demonstrates activation.

Layer: runtime cooperative guard in K→C, bypassable by a process directly editing files. Residual same-OS-user writer risk remains; no malicious-process isolation claim. Final enforcement: cooperative writers only.
