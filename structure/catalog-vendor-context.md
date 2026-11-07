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

`src/codex/catalog/gather-capture.ts` fills registry numeric capability maps on the detached
provider before enrichment. `applyRegistryCapabilitySeedFill` bounds registry context seeds by
an explicitly configured positive provider-wide window, then overlays explicit per-model windows
using the static resolver's case-aware map merge for both context and output limits.
Thus enrichment cannot promote a registry default above the operator's limit; explicit per-model
settings still win and smaller observed windows remain authoritative. Capture, hints and Codex
serialization are covered by `tests/codex-integration/catalog-context-window-ladder.test.ts`,
including OAuth xAI's 500k ladder with a 300k provider limit and smaller key-auth limits.

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
serves less. Tests: `tests/codex-integration/vendor-context.test.ts`.

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

The first-party DeepSeek catalog retains `deepseek-v4-pro`: its retirement plan was withdrawn, and the official models endpoint still advertises it. `src/codex/catalog/parsing.ts` does not exclude that first-party row; third-party exclusions remain provider-specific. `src/providers/registry/entries-core.ts` restores its text-only capability, context window, reasoning controls and inbound-scoped Responses route while retaining Flash as the default. Evidence: [official service continuation notice](https://api-docs.deepseek.com/updates/), checked 2026-10-23.

## Published context ladders

A lane may publish a selectable window ladder instead of one number. The Grok CLI subscription
lane (`cli-chat-proxy.grok.com`) reports its default rung in `context_window` and the ladder in
`context_windows`; PR #7701 reports a 2026-10-24 observation in which all four rows (grok-4.5, grok-4.6, grok-4.7,
grok-4.7-build-fast) read `context_window: 256000` with `context_windows: [256000, 500000]`.
`catalogHintsFromModelsApiItem` in `src/codex/catalog/model-hints.ts` reads the widest valid
rung, so the 500k the registry already carries survives a lane that reports its default rung as
the effective window. Configuration cannot restore that: `clampObservedModelLimits` only lowers
an observation, so a lane-reported short window was previously sticky.

The read sits immediately above the `context_window` fallback — a ladder outranks the default rung
beside it, while every other recognized field keeps the precedence it already had, and a lane that
publishes no ladder is unaffected. Inspection is bounded to eight rungs. A ladder is the model's
capacity, not evidence that the configured tier serves it; the same rule as above applies, and an
operator who is entitled to only the short rung sets a lower window or an enabled Context cap.
Covered by `tests/codex-integration/catalog-context-window-ladder.test.ts`.

Independent subscription overflow probes recorded a 500000-token rejection ceiling for 4.7 and
build-fast (`devlog/_fin/260930_grok47_build_unify/010_probe-evidence.md`); this is not a successful
near-limit generation test for every model or account. The [official API model table](https://docs.x.ai/developers/models.md)
also lists 500k context tokens for 4.5, 4.6 and 4.7 (checked 2026-10-26), independently of subscription entitlement.
No equivalent 4.5/4.6 boundary probe is recorded here. Effort and Fast/Flex policy projection remain
independent of context parsing; xAI rows retain `supportsFlexTier: false` unless explicitly eligible.
