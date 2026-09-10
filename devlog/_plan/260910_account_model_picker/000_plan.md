# Selective Codex account models

Understood as: register selected account/model pairs in OpenCodex for review harnesses while preserving common pool-routed native models; validate locally and submit an upstream dev PR.

## Scope and rationale
Some models are available only to particular accounts. Review automation needs an explicit eligible-account selector without multiplying every model by every account. This feature selects catalog entries; it grants no provider entitlement and promises no change to refusals.

Reuse existing account namespaces and exact-account routing. Add an optional per-selector model allowlist to settings, extend the existing advanced-settings control, and keep common native rows visible in selective mode. Existing configurations without an allowlist retain their legacy projection until selection is saved. No credentials, routing policy, Daybreak wire normalization, or running service changes.

## Plan and audit
- Configuration validates public selector keys and bare native model IDs; absent means legacy all, empty object means none.
- GET/PUT settings exposes choices and persists selections with existing rollback and catalog convergence.
- Catalog consumers filter generated rows by the same allowlist. Selective mode leaves bare rows visible. Entitlement gates and exact-account failures remain unchanged.
- UI reuses the existing card, toggle, forms and locale files; account/model choices expand beneath the toggle. Quiet developer settings: variance 2, motion 1, density D5. No new visual system.
- Tests: configuration validation, save/rollback, selected-only catalog and common rows, exact-account regression, UI save/toggle/failure; local typecheck/full tests, GUI checks/build, docs build, privacy scan; independent security/correctness review and browser screenshots before PR.

Audit: a display allowlist must never become an authorization source. Unknown/deleted selectors must not be advertised. Disabling visibility must not remove routing bindings. Main means current main login, not a permanently pinned email identity.

User refinement: the original switch keeps its original default/legacy behavior. A second Customize per account toggle opts into selective projection; switching it off restores legacy behavior.
