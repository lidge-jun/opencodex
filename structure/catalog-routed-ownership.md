# Routed-row authorship and combo descriptions

Catalog maintenance has to tell rows OpenCodex generated from rows Codex, Cursor or the user put
there: removal of a deleted provider's or combo's rows, baseline-shadow restoration, native
template selection, auto-review routed detection, exact-combo admission and native-residue
detection all ask that question. Historically every generated routed row answered it through its
description, which always starts with `Routed via opencodex → `.

A combo may replace its own row description (#7229, `combos.<id>.description`, validated like
`displayName`: string, at most 128 characters after trimming, no control characters; empty
clears). Such a row carries `opencodex_routed_origin: "combo-v1"` instead of the generated
prefix. `src/codex/catalog/ownership.ts` owns both signals and is the only place they are read:
`hasOcxRoutedAuthorship` accepts the exact marker or the generic prefix, and
`hasOcxComboAuthorship` accepts the marker or the combo-specific prefix. Unknown marker values
confer nothing. Callers keep their own extra conditions (slash-qualified slug, `owned_by`,
native-alias kind, exact-combo membership); the predicates replace only the text test.

`deriveEntry` sets the description and the marker together through `applyRoutedDescription`,
so a template clone never inherits another row's marker, and the Reserve native reconstruction
in `src/codex/catalog/metadata.ts` strips it. Only combo models are eligible; member
descriptions are never inherited. Rows without an override keep the generated text and no
marker, so their bytes do not change. The management API keeps a saved description when a
write omits it (the dashboard does not edit it yet), and `ocx combo set --description <text|->`
sets or clears it.

A combo row retained from the previous catalog because its fresh derivation failed (for example a
native-alias combo whose member provider is disabled) bypasses `deriveEntry`. Config-aware merges
(`src/codex/convergence.ts`, `src/codex/catalog/retained-sync.ts`) pass
`comboCatalogDescriptions(config)`, and `reapplyRetainedComboDescription` re-projects the current
value onto such rows: a set description replaces the old one with the marker, a cleared one returns
the generated combo text without it. Merges without config leave retained rows untouched.

`tests/codex-integration/combo-description-catalog.test.ts` covers ordinary, bare and native
aliases, removal and shadow restoration, foreign and unknown-marker rows, template exclusion,
auto-review, residue detection and byte-idempotent sync. `tests/routing/combo-description.test.ts`
covers validation, management API set/clear/omission/rename, CLI receipts and config salvage.
