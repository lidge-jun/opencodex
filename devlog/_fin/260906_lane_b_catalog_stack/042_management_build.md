# 042 — Canonical provider-workspace model controls

The UI child carries the remaining source #3659 changes by gqchen, then adapts
them to the existing model-row authority. The proposed disabled-map API, parser
and server assertion were removed; their net diff from the static parent is zero.

The workspace adopts `/api/models` with the full selection/provenance response.
Actions require the current parent revision and matching custom ownership.
Delete removes one custom definition; Hide changes the represented row's
visibility. Neither adds a second mutation, an implicit unhide or a browser-only
removal marker. Namespaced identity separates account-native/custom collisions.

The implementation preserves ordinary raw-ID copying, native default badges and
the configured-fallback hint's prior condition. Missing discovery provenance
remains unknown; malformed present data and invalid action identity are rejected.
Icon-only actions expose their exact target in accessible names.

Regression additions cover real API persistence/restoration and UI response-order,
single-flight, uncertain-result, remount, count, focus and identity scenarios.
All nine locales and eight dashboard guides describe the same contract, retaining
other lanes' changes. Independent C4 source review passed; execution and actual
compiled-browser evidence remain C gates. The inherited source screenshot is
historical and must be replaced before this child is review-ready.
