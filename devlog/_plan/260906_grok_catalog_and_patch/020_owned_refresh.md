# 020 Converge already-owned Pi/Aside catalogs

Depends on 010 filtered loader. Loop spec-satisfaction repair. Goal: a model visibility/selection change and explicit sync refresh existing connected Pi/Aside files. No adoption of unowned/manual files, no recreation of removed blocks, no override of drift.

NEW src/integrations/catalog-refresh.ts: bounded helper refreshOwnedCatalogIntegrations(input, clientIds) defaults clientIds to [pi, aside]; callers may supply an explicit list including mcode. It passes a lazy cached models loader to refreshOwnedIntegration, catches per-client errors and returns existing outcome shape. Use existing ownership store, mutation flight and coordinated writer; never bypass fingerprints. The later Aside-profile layer delegates Aside to its server-owned profile engine; direct CLI sync passes [mcode, pi] here and invokes the Aside server helper once separately, including an explicit unavailable-server diagnostic.
MODIFY src/server/management/model-routes.ts: local async convergence helper calls existing convergeCodexCatalog then new owned refresh for pi/aside with port from URL/config and lazy loadExportModels(config); attach clientIntegrations outcome to disabled-models, model-visibility, selected-models and model-preset writes. Keep successful config persistence even when one file refuses refresh; return warning outcome.
MODIFY src/server/management/config-routes.ts and src/cli/dispatch.ts: expand current MCode-only owned refresh to mcode/pi/aside via helper; preserve native Grok/Desktop gates and refused-sync behavior.
MODIFY existing tests/clients/sync-client-integrations.test.ts and tests/server/management-integration-routes.test.ts: fake IO/store or isolated home seeds owned pi/aside with two models, refresh with selected one, assert hidden row removed and other provider fields preserved. Prove unowned, removed and drifted configs untouched; one failure does not block other client. Add route-driven visibility refresh coverage using injected convergence.
UPDATE structure/09_client-integrations.md and owning docs page with ownership/refusal semantics.

Verification: standalone isolated writer probe using synthetic models and temp homes, then exact-head hosted CI. C4 care for automatic owned-file writes: independent review must confirm ownership/no-clobber and per-client failure boundaries. Final enforcement is existing coordinated writer; refresh helper is an early caller, not a permission boundary. Known bypass: manually calling writer with explicit adoption; no such call in this unit. Stop when file projection converges or produces truthful refusal.

## Audit amendment: overlapping refreshes

The existing constant refresh mutation-flight key incorrectly joins different model selections. MODIFY src/integrations/owned-refresh.ts to use a unique per-refresh operation key (crypto.randomUUID), making overlapping refreshes explicitly busy rather than reporting another desired catalog as success. Implicit refresh never joins an explicit HTTP mutation. Add controlled overlap with distinct old/new rosters: second call reports integration_mutation_busy; first result describes only its own write. Subsequent retry applies the new roster. Return per-client failures; never retry stale snapshots automatically.

Add a ManagementApiDeps refreshOwnedCatalogIntegrations seam for route verification, defaulting to the real helper. Creation: exported helper/deps type; consumption: model routes and explicit sync. No serialization/deserialization: runtime-only dependency injection. Tests use fake IO/store or temporary home, never actual user-owned files.

## P revalidation and implementation interface

010 b8010aebd passes the four standalone visibility probes and source review; all original hosted-CI/merge criteria are retained under the terminal stack cycle, not marked complete. Helper signature: refreshOwnedCatalogIntegrations(input: Omit<OwnedIntegrationRefreshInput, "clientId">, clientIds: readonly IntegrationClientId[] = ["pi", "aside"]): Promise<OwnedIntegrationRefreshOutcome[]>. Memoize the lazy model load per fan-out; no owned record means no catalog load. Catch and redact each failure. Explicit sync passes [mcode,pi,aside]. Visibility routes attach both catalogRefresh and clientIntegrations; native Codex failure does not undo an already persisted selection.

Delegate tests only to one worker: tests/clients/sync-client-integrations.test.ts owns helper refresh+overlap coverage; main owns implementation and route regression tests. The worker has no production writes, suite execution, FSM or git mutations.

## Implementation audit synthesis

Averroes found an indirect source-oracle dependency: codex-convergence-contract.test.ts counts direct convergence calls and two preset calls. The shared visibility helper changes direct count but preserves fourteen logical paths. Update the inventory to subtract the helper definition and add its five callers, assert exactly one Codex convergence inside the helper, and preserve the marker-only custom preset negative. Run that affected file remotely in addition to the writer/route tests. No runtime blockers in the ownership audit.
