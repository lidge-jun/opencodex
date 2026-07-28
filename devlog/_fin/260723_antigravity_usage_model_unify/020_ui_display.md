# WP2 UI display plan

## Preferred outcome

If WP1 emits canonical `model` and omits/canonicalizes Antigravity `resolvedModel`, no provider-specific UI mapping is needed. `ProviderWorkspaceShell` can continue transporting API rows unchanged.

## Hardening still recommended

`ProviderUsage` is a summary table, so row identity and display should follow the server's summary identity (`row.model`), not routing detail (`row.resolvedModel`). Change `gui/src/components/provider-workspace/ProviderUsage.tsx:87-94` to:

- use a composite stable key such as `${item.name}\0${row.model}` (or model alone after provider filtering);
- use `row.model` for expansion state and the visible label;
- if routing detail remains useful, expose differing `resolvedModel` only in the expanded detail, not as row identity.

Also review the global Usage page, which has the same preference at `gui/src/pages/Usage.tsx:487-488` and searches both fields at `gui/src/pages/Usage.tsx:598`. A server-only key collapse that retains the first `resolvedModel` is order-dependent and can display a historical alias despite canonical aggregation.

## GUI tests

- Extend a Provider Workspace source-contract/component test to ensure label/key use `model`.
- Render two canonical rows with differing optional `resolvedModel` fixtures and assert no duplicate keys or expansion collision.
- Keep this generic; do not duplicate the Antigravity reverse map in React.

## Decision gate

- If API rows contain no divergent `resolvedModel`, UI change is defensive but low-risk.
- If API rows may retain divergent `resolvedModel`, UI change is required for the stated picker/call-name contract.

## Audit amendments (A-gate round 1)

- Prefer `row.model` primary in ProviderUsage AND global Usage.tsx (`modelLabel(model.model)`), show resolved only as secondary when different.
- Row keys must not use resolvedModel alone.
- WP2 can be NOOP for code if WP1 strips antigravity resolvedModel and live UI already correct; still verify both surfaces.
