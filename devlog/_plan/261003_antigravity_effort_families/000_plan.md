# Antigravity discovered effort families

New Claude 5.5 Opus and Sonnet tiers currently appear as separate models because discovery only collapses families listed in the bundled catalog. This unit makes complete discovered low/medium/high families one model with selectable effort, including future versions, while preserving explicit suffix requests.

- Class: C3, one cohesive PABCD work-phase (wp1); satisfy-spec.
- Trigger/goal: group the new Antigravity models and retain grouping during automatic refresh; publish and merge one ordinary PR into dev.
- Non-goals: upstream API invention, authentication changes, release, deployment, running-service restart, unrelated UI changes.
- Scope: current managed worktree; existing GitHub identity for authorized PR publication/integration. No user token/cost/wall-clock cap was set.
- Verifiers: focused parser/wire/catalog/new-model-policy regressions, typecheck, structure/privacy/layout gates, docs build, exact-head hosted CI and merge receipt. Existing wire baseline: 61 pass, 0 fail (`bun test tests/adapters/google/google-antigravity-wire.test.ts`). Tests name source arguments directly; typecheck includes src and tests through tsconfig.
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
