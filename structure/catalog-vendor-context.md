# Custom-provider context estimates

`src/codex/catalog/vendor-context.ts` supplies a missing-window estimate from bundled
`src/generated/model-metadata.ts` rows only for custom provider names whose config sets
`inferContextWindow: true`. The flag is off by default so id-only custom rows keep the #1073
conservative fallback (enabled cap as the window, else 128k). Registry names and metadata
aliases are excluded; the registry-name set is captured at module initialization, not after a gather
await. `src/codex/catalog/model-hints.ts` keeps observed/configured limits (the smaller value wins),
then Azure metadata, then this estimate, then an enabled context cap as the window, then the existing
128k parser fallback. The provider cap still clamps the chosen window. Native and built-in rows
retain their existing policies; OpenAI API metadata used for a custom relay is not Codex subscription
capacity. The lookup changes no configuration, credentials, pricing, or request model identity.

Management reads, strict boolean/null PATCH updates, and same-name overwrite preservation of the
optional flag follow the [provider API contract](gui-and-management-api.md#api-ownership).

Original-vendor tables precede aggregator tables. Exact model spellings win within a tier;
case-folding and dot-to-hyphen aliases are accepted only without conflicting windows. Aggregator
rows may supply a bare last-segment alias; floating `~` rows are excluded. Conflicting keys do not
fall through to a lower tier. The source provider, original model ID, original window and source
class accompany every inferred value. These are bundled estimates, not live gateway measurements.

`src/codex/catalog/parsing.ts` defines `CatalogModel.contextWindowInference`;
`src/codex/catalog/routed-gather.ts` preserves it through custom-row gap filling and cache projection; explicit
custom windows clear it. Re-hinting recomputes inferred windows and cap annotations rather than
promoting the old estimate to an observation. Custom-only rows fill only missing context fields,
leaving explicit modalities and reasoning unchanged. `src/codex/catalog/effort.ts` writes the
estimate under `inferred_context_window` / `context_window_inference` in capability provenance,
not `context_window`, so routing requirements still see unknown capacity. Existing asserted
modality/tool evidence remains usable. Shared client catalogs, Claude context markers and exports
consume the estimated window; operators must configure a lower window or Context cap when a relay
serves less. The Codex catalog tells Codex `unlistedModelsToldContextWindow` percent (default 40) of that window for a routed model whose window is not configured; capability provenance and Claude Code keep the full window. Tests: `tests/codex-integration/vendor-context.test.ts`.

## Native maximum windows

`src/codex/catalog/parsing.ts` preserves native `max_context_window` independently of the
default `context_window`. Only configured hard limits narrow that maximum: the exact model's
window overrides the provider window, then the provider context cap bounds either. Both paths
share validation and precedence through `nativeOpenAiConfiguredContextLimit` in
`src/codex/catalog/metadata.ts`. Strict normalization preserves the maximum for trusted
account-selector native rows too; ordinary routed rows remain bounded by their effective window.
Compaction and max input still follow the effective default
window, including retained lower soft budgets. Native capacity remains defined by the
[native passthrough contract](catalog.md#native-passthrough). Covered by
`tests/codex-integration/catalog-native-max-context.test.ts`.
