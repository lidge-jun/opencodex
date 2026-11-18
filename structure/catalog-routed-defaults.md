# Routed catalog row defaults

`routedCatalogDefaults` (#6872) is a top-level `config.json` block that sets four serialized
fields on every freshly derived routed Codex catalog row. The owner-approved allowlist is the three
prompt-block flags `include_skills_usage_instructions`, `include_apps_usage_instructions` and
`include_plugin_usage_instructions`, plus `default_verbosity`. The config spellings are
`includeSkillsUsageInstructions`, `includeAppsUsageInstructions`,
`includePluginUsageInstructions` (all optional booleans) and
`defaultVerbosity` (`"low"`, `"medium"` or `"high"`). It is config-only; no Dashboard control or
management route writes it.

## Validation

`src/types/routed-catalog-defaults.ts` declares `OcxRoutedCatalogDefaultsConfig`, which
`OcxConfig` references by type import. `src/config/schema/routed-catalog-defaults.ts` owns the
strict schema (checked against that type with `satisfies`), the shape hint and
`routedCatalogDefaultsConfigError`. `src/config/schema/config-schema.ts` degrades a malformed
block to absence (the whole block, not single fields), `warnDegradedTopLevelOptIns` in
`src/config/load-degrade.ts` warns once per load, `src/config/diagnostics.ts` reports it from the
raw file and `validateConfigCandidate` rejects it on writes. Unknown keys, including the
serialized snake_case spellings and other row fields such as tool mode, search, truncation or auto
review, are rejected rather than ignored.

## Derivation

Catalog writers capture the block once per build with `resolveRoutedCatalogDefaults`, which
returns a frozen copy or `undefined` for an absent, empty or malformed block, and pass it as
`routedCatalogDefaults` on `ObservedCatalogEntryBuildInput` in
`src/codex/catalog/build-entries.ts`. Derivation never reads config itself. The three callers are
the convergence writer (`src/codex/convergence.ts`), the retained-sync writer
(`src/codex/catalog/retained-sync.ts`) and Codex-shaped HTTP discovery
(`src/server/codex-model-list.ts`, through the positional `buildCatalogEntries`). Only the
routed `goModels` and native-alias combo calls of `deriveEntry` receive it; native and
account-bound builds do not.

`deriveEntry` in `src/codex/catalog/derive-entry.ts` calls `applyRoutedCatalogDefaults`
(`src/codex/catalog/routed-defaults.ts`) on both routed paths: after `normalizeRoutedCatalogEntry`
on the template clone, and after the tool-mode stamp on the no-template fallback. Both points are
before `applyCatalogMetadata` and `applyCatalogModelMetadata`, so precedence is: concrete
provider/model declarations, then these defaults, then inherited template values, then the
`ensureStrictCatalogFields` fallbacks. Verbosity support (`support_verbosity`) is never an operator default: it stays
the provider's, model's or template's own value, and the final strict pass deletes
`default_verbosity` whenever `support_verbosity` is false, so `defaultVerbosity` only reaches rows
that already support verbosity.

Rows that mirror native contracts are excluded: native rows, account-bound native clones, and
Codex-forward native-capability aliases (`codexForwardNativeCapabilityAlias`) keep their native
values. Rows retained from disk while their provider is degraded bypass derivation and keep their
previous values until a successful gather regenerates them. Because the defaults only overwrite
fields on a fresh clone, repeated syncs are byte-identical and removing the block restores the
original derivation on the next sync. The block confers no tool authorization and leaves the routed
tool-discovery, search, truncation, review and identity normalization unchanged.

Coverage: `tests/config/config-routed-catalog-defaults.test.ts` (validation, degradation,
diagnostics) and `tests/codex-integration/catalog-routed-defaults.test.ts` (precedence, both
derivation paths, native non-interference, retained rows, convergence, retained sync, live list,
idempotence and clearing).
