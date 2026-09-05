# Attribution investigation

## Competing hypotheses and falsifiers

- H1: UI groups rows using the selected provider rather than each row's provider. Falsifier: shell groups by `m.provider` and original ledger has those same provider/model pairs.
- H2: persistence keeps a stale provider after a real cross-provider route. Falsifier: persisted route decision and physical attempts both select Kimi via `default-provider`.
- H3: unmatched request selectors fall through to the default provider and remain displayed/priced as if they were confirmed served model identities. Falsifier: router rejects unknown policy selectors, or source/ledger records a distinct resolved physical model.

## Observed facts

`ProviderWorkspaceShell.tsx:214-220` groups API model rows by `m.provider`; it does not copy global rows into every provider. `src/router.ts:603-609` explicitly documents missing `policy/<id>` falling through; `:794-798` forwards the unmatched identifier unchanged to the default provider. `src/server/responses/core.ts:2069-2072` writes the actual chosen route provider/model into log context.

A read-only streaming scan of the real ledger, emitting no credentials, request bodies or account identities, found foreign-looking selectors under Kimi with `routeKind=default-provider` and Kimi physical attempts. The historical nonexistent-policy row also has a successful terminal response and measured tokens. This rejects H1 and the simple stale-provider form of H2. It proves the fallback mechanism in H3, not the identity of the actual model behind the remote endpoint. An echoed `response.model` alone is not such proof.

Historical usage must stay attributed to the recorded serving provider, not transferred to whichever provider name appears before a slash. Unknown native slash IDs must remain supported for genuine aggregators. Missing reserved policy names can be rejected without globally banning unknown model IDs.

`src/usage/cost.ts:317-329` falls back to model-level vendor price regardless of serving provider; `vendorPrefixedCost` validates the prefix against the vendor but does not prove that a default-fallback request actually ran that model. A fallback selector needs an honest distinction from confirmed model identity, not a fabricated Kimi price.

## Unresolved before audit

Choose a compact backward-compatible fallback presentation which preserves counts, tokens and requested identifiers without mispricing them. Inventory quota capability owners before finalizing 020. No user ledger mutation is authorized or planned.

## Deterministic local diagnostic (not a test suite)

Direct `routeModel` invocation with an in-memory config containing only Kimi and model `k3`, no credential or network execution: `policy/does-not-exist`, empty `policy/`, and `anthropic/claude-opus-5` all returned provider `kimi` with routeKind `default-provider`; `k3` returned `explicit-provider`. Process exited 0. This independently reproduces the saved route trace and establishes a negative-case before-state for the later HTTP/CI regressions.
