# Antigravity discovered effort families

New Claude 5.5 Opus and Sonnet tiers currently appear as separate models because discovery only collapses families listed in the bundled catalog. This unit makes complete discovered low/medium/high families one model with selectable effort, including future versions, while preserving explicit suffix requests.

- Class: C3, one cohesive PABCD work-phase (wp1); satisfy-spec.
- Trigger/goal: group the new Antigravity models and retain grouping during automatic refresh; publish and merge one ordinary PR into dev.
- Non-goals: upstream API invention, authentication changes, release, deployment, running-service restart, unrelated UI changes.
- Scope: current managed worktree; existing GitHub identity for authorized PR publication/integration. No user token/cost/wall-clock cap was set.
- Verifiers: focused parser/wire/catalog/new-model-policy regressions, typecheck, structure/privacy/layout gates, docs build, exact-head hosted CI and merge receipt. Existing wire baseline: 61 pass, 0 fail (`bun test tests/adapters/google/google-antigravity-wire.test.ts`). Tests name source arguments directly; typecheck includes src through tsconfig; Bun executes the targeted test files.
- Stop: implementation and independent review complete, relevant checks green, PR merged into dev. DONE needs these proofs; unresolved external checks remain unmet, never passed by assumption.
- Evidence: this unit and local .codexclaw receipts. Escalate only new authority or genuine unresolved design blockers.

## Findings and decisions

`src/providers/antigravity-models.ts:127` and `:207` require a bundled picker ID before recognizing a full suffix family. `src/codex/catalog/provider-models.ts:756` then publishes an empty effort ladder for newly discovered models even when their wire map is exact. Existing base-URL scoped discovery mappings already route effort and are generation-fenced.

Reuse those owners. No new provider registry version list or GUI grouping implementation is needed. Saved suffix IDs remain wire-authoritative. Incomplete ladders stay directly routable; unknown single-wire/tiered semantics remain unknown. Existing explicit configuration overrides retain precedence.

## Consultation

Architect proposal/reflection pending from handle 01a10104-3fca-79a2-8f9c-a410eb64d57e (V1 logical read-only architect, inherited model). Main owns integration; independent reviewer will audit the final plan before implementation.

Architect D01/D02/D03/D05/D06 accepted. D04 amended: carry exact discovered family evidence with CatalogModel; normalize only discovery baseline and base disabled state through the existing reconciliation/persistence path. Keep provider selectedModels unchanged; a read-only shared visibility projection recognizes selected suffixes. Preserve raw default/combo references. No provider configuration migration or extra persistence surface. All-disabled suffixes transfer disabled status once; any enabled known suffix preserves an enabled base. A previously known base and explicit base disable win on later refreshes.

Reflection: D01/D02/D03/D05/D06 ALIGNED; D04 gap (retained suffix IDs reappearing as new arrivals) folded into final plan by normalizing both policy input and baseline. Same architect recheck requested; no implementation before resolution and independent A audit.

Final same-architect reflection: ALIGNED for D01-D06, no remaining material design gap. Baseline additionally passed typecheck and 29 listing/policy tests. Proceed to independent A audit.

A round 1: FAIL, one accepted blocker: final merge independently filters raw selectedModels. Added retained-sync and convergence consumers and final-merge regression. No other material design blocker. Same reviewer re-audit requested.

## Build and verification

Implemented the audited plan. A bounded worker owned the family helper/policy/tests; main integrated parser, catalog, both final-merge selection callers and management projection. Discovery tests first failed 8/8 on the original source and passed after the fix. Existing future-family expectations were updated to assert the requested grouping. OpenCodex's existing synthetic ultra orchestration level remains separate from upstream low/medium/high; no unsupported synthetic max is added to the discovered ladder by default.

Focused verification: 43 isolated test files, 830 pass / 0 fail, covering all Google adapter tests, family/policy/persistence, management and final merge, layout, file-size and optional-Lab import boundaries. The initial combined-process run had 803 pass / 2 fail: new test names disagreed with seed ownership (fixed by provider-prefixed names); an unchanged gemini-web-search mock replaced the listing test's OAuth token across files (each file passes in its own process). Full local suite is disproportionate for this bounded catalog change and shared workstation; repository resource exception uses these affected regressions, with full platform coverage left to exact-head hosted CI. Local logs stay in ignored scratch.

Typecheck passed. Docs build passed (561 pages and 77,923 internal links). Structure and privacy scans passed. Structure catalog was already at its 600-line budget, so the shared family contract lives in providers-and-adapters with a link from the existing catalog paragraph.

## Reviewed implementation outcome

Independent implementation reviewer checked commit `916bd9d600723375c3c5667f4fe7b085af962c4d`, found no concrete regression, and independently ran all 28 new family tests with zero failures. The parser, cache, compatibility, policy projection, both final merge filters, and public list callers are covered. No live upstream model request was made; tests exercise the supplied wire-ID contract with controlled CCA discovery fixtures.

Implementation is complete and published in PR #6501: https://github.com/lidge-jun/opencodex/pull/6501. The PR's live Verification section carries the final hosted-CI and authorized maintainer-integration receipt. Final goal completion additionally requires that exact-head gate and verified dev merge; neither publication nor this archived implementation record claims those external steps already passed.

## External-review corrections

The initial PR head passed hosted CI, but external review found a restart/outage defect that the in-memory tests missed. Accepted and corrected: a bounded exact-family snapshot now precedes synthetic catalog publication, restores routing after restart, and cannot revive after generation invalidation or an authoritative empty/partial replacement. Private no-follow atomic replacement and destination hashes keep URLs and credentials out of the snapshot. Write failure retains prior coherent discovery state. Overlapping family identities are preserved in public rows, policy and original-only selection projection.

The same architect confirmed the revised D05 design ALIGNED. Independent code/security re-review closed both findings and passed 35 then-current focused tests. Main subsequently added two boundary assertions and confirmed 839 tests across 44 affected files (per-file isolation plus the final focused additions), with typecheck and structure checks passing. Restart tests use separate processes and the actual Google adapter while discovery throws, including each tier, medium default, corruption, size bounds, destination/home separation, tombstones and write-failure publication. Process restart is verified; power-loss durability is not claimed. Final updated-head hosted CI and merge receipt remain in the PR's Verification section.
