# A2 — Owner admission, intent and identical-byte writes

Depends on A1. Carry the ownership/intent/idempotence portions of #6537; exclude audit append and timers.

## File changes

- NEW src/codex/codex-home-owner.ts: current home canonicalization, bounded read-only journal ownership inspection and injection binding selection, based on source #6537. Proven missing binding is legacy/unbound; same physical directory owned; extant foreign binding refused; proven vanished binding recoverable. Unknown inspection cannot authorize takeover.
- MODIFY src/codex/journal.ts: optional `opencodexHome` persists on snapshot and mark-injected; preserve existing owner across native snapshot replacement; fill legacy and replace proven stale only.
- MODIFY src/codex/catalog-write-serialization.ts: options `{intent, writer}` mandatory at every acquisition; registration stores intent/writer; accessor requires live permit; owner refusal before callback; re-evaluate each call. Source intent union refresh/cache/pull/restore. No audit dependency in this slice.
- MODIFY src/codex/internal/catalog-writer.ts: return written/unchanged/refused; compare exact bytes; refresh all-routed-clear requires file config; restore and pull keep own authority; cache intent cannot replace catalog. Config admission plus write remains inside existing lock order. No append code yet.
- MODIFY src/codex/catalog/routed-removal.ts: source row-count/namespace-count helpers and path-free owner warning.
- MODIFY src/codex/convergence.ts, catalog/retained-sync.ts, catalog/remote.ts, catalog/restore.ts, inject/restore.ts, refresh.ts, sync.ts: pass explicit intent; propagate owner/refusal/no-op receipts accurately and preserve restore completion.
- MODIFY src/cli/dispatch.ts and src/server/index.ts: cache intent at existing calls; sync-cache human output explains owner refusal, JSON preserves structured failure. No new startup work.
- NEW tests/codex-integration/codex-home-owner.test.ts and tests/codex-integration/codex-catalog-intent.test.ts: owner and low-level intent/idempotence behavior, independent of future audit output.
- MODIFY catalog-remote-pull, catalog write-serialization/writer, convergence account selectors/contract, models-cache invalidation, retained-root serialization tests: mandatory intent and accurate receipts; preserve assertions and saved-config realism.
- MODIFY both test registries and structure/codex-home.md; clarify cooperative boundary and reevaluation.

Field chain: journal writer → JSON → read-only inspector → K and future healer. Optional absent field remains legacy compatible. Intent: call sites → live in-memory permit WeakMap → funnel; no persistence. New result reasons: K → retained/convergence/remote/CLI → existing serializers; update every exhaustive consumer found by symbol search. Receipt unchanged: writer → convergence receipt → management outcome.

## Acceptance

Run owner/intent, serialization/writer, restore, remote-pull, models-cache and convergence-focused files plus common gates. Activate same-home/symlink, legacy, stale, foreign valid providerless config, unreadable binding, and native snapshot replacement. Foreign call never reaches callback and leaves catalog/cache untouched. Legitimate owning restore/deletion succeeds. Identical catalog/cache bytes preserve mtime and do not restart app-server. Refresh clear without saved config refuses; valid saved file allows; cache permit cannot replace catalog; pull preserves hub authority.

Layer: cooperative runtime ownership check, not OS isolation. Direct file edits can bypass it. No automatic seizure of active foreign home. Unknown owner checks refuse and later calls retry.

Architect refinement: check owner again after K acquisition; read errors are unavailable evidence rather than legacy ownership. Owner comparison canonicalizes both paths. Update remote pull to accept unchanged cache outcome as success while retaining compensation on failed cache publication. Add source reviewer sync-cache human warning fix; unknown ownership shares safe refusal but documentation does not call it proof of foreign ownership. Tests cover all four intents and owner recheck.

A2 lifecycle coverage refinement: MODIFY src/codex/inject.ts alongside the planned journal and restore modules, using the same ownership policy at preflight and final mutation. Both asynchronous and synchronous restore refuse foreign active and unknown homes; journal reconciliation/cleanup retain unknown or foreign evidence. Successful deliberate config/profile restoration releases the binding at the existing release point; catalog-only restore keeps it. Tests invoke injection preflight, full restore variants, reconciliation, and explicit catalog failure after successful native restoration. Refusal results remain observable; catalog failure remains a failed artifact and does not masquerade as successful catalog restoration. Detailed investigation stays in ignored scratch.

A2 release decision: preserve the existing successful native config/profile restore release point. Do not introduce deferred journal deletion or change client rollback orchestration outside this lane. Early and final ownership checks protect active homes. A catalog failure after native restore can retain the existing custom-path retry limitation; this series does not claim to solve that independent recovery contract. Architect ALIGNED with this replacement for the earlier deferred-release proposal.
