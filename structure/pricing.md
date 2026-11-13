# Model Price Overrides

## Configuration and API

`ProviderCostOverlay` in `src/types/provider.ts` keeps four required base rates and an optional
`promptLengthPricing` discriminated policy: `automatic`, `flat`, or `custom` with a positive
safe-integer `thresholdTokens`, `gt`/`gte` comparison and four absolute alternative `rates`.
Absent policy retains legacy automatic context behavior. `src/config/schema/leaf-validators.ts`
rejects malformed/unknown nested fields on writes and copies only validated policy fields for
display, dropping an explicit `automatic` policy so absence is the single stored form of
Automatic; load degradation drops an invalid model row without losing the provider.

`src/providers/openai-tiers.ts` accepts these same rate and policy shapes through the shared
`validCost4` predicate in the pure `src/usage/user-cost-validation.ts` module when migrating
legacy `openai-multi` overlays. It rejects unknown row
fields and malformed policies, and preserves valid policies while rewriting model keys to `openai`.
`tests/adapters/openai/openai-provider-option-migration.test.ts` covers preservation and rejection.

`src/server/management/model-routes.ts` serves `GET/PUT /api/providers/{provider}/model-costs`.
GET and successful PUT receipts retain all four rates and the optional validated policy.
A `cost: null` write removes the entire model override. Writes retain atomic persistence,
rollback and sibling-model preservation. `tests/server/model-costs-prompt-length-pricing.test.ts`
covers persistence, receipts, reset, rollback and external edits.

`src/config/live-reconcile.ts` scopes explicit pricing PUT intent to one complete model row.
After recursive reconciliation under the config mutation lock, it reapplies that row (or its
deletion) and validates the final candidate before publication. This prevents concurrent mode
changes from mixing Custom fields into Flat/Automatic policies, and honors replacement even
when the submitted base rates equal the old baseline. Unrelated saves still adopt disk edits.
`src/cli/models-runtime.ts` reads the complete policy in `cost` and projects only base rates in
`effectiveCost`. `set-price` reads the current row first and carries that model's policy into
the replacement row, so a base-rate edit never silently drops a Flat or Custom policy; its receipt
must echo the same policy, with absent and `automatic` treated as equal.

## Dialog and estimates

`gui/src/components/ModelPriceDialog.tsx` edits base rates plus Automatic, Flat rate or Custom
threshold pricing. Automatic retains catalog context rules with the saved base tuple. Flat skips
context adjustments; Custom replaces the catalog rule on both sides of its single threshold.
Parsing, draft building, per-field validation and receipt comparison live in the pure
`gui/src/components/model-price-cost.ts`; the dialog sends no policy for Automatic, validates
complete policy receipts before refreshing the model list and retains its uncertain-outcome/reload
flow. `gui/tests/models-price-editor.test.tsx` covers this behavior.
The comparison Select renders its menu inside the modal dialog so native modal inertness does
not block pointer or keyboard interaction with its options.

`src/usage/cost.ts` selects rates against inclusive `usage.inputTokens`, before subtracting cache
reads/writes for cost estimates; output is excluded from threshold selection. Alternative rates
apply to every token bucket of the request. Custom rates are standard-speed rates that stand in
for the catalog long-context rate, so a crossed threshold follows the catalog's
`confirmedPriorityRelation` for that model: `stack` (or no catalog rule) applies the Priority
multiplier once, `lower-bound` keeps the custom rates and sets `priorityLowerBound`, and
`exclusive` prices a confirmed Priority request from the base rates. Confirmation requirements are
unchanged. `customThresholdApplied` stays separate from the catalog `contextTier` marker and is
set only when the custom rates priced the request. Each Combo attempt selects its own tuple.
`tests/usage/usage-prompt-length-pricing.test.ts` pins boundaries, cached prompts, whole-request
rates, compatibility, Combo and Fast/Priority behavior.
It also verifies Automatic Haiku overrides at 99,999/100,000/100,001 inclusive prompt tokens,
including cache reads/writes and the inherited catalog band for both Anthropic OAuth pools.

`src/usage/user-cost-overlays.ts` copies the complete policy into its versioned registry:
policy-only edits invalidate price memoization and usage caches; identical reloads remain stable.
`tests/server/model-costs-pricing-cache.test.ts` exercises warmed cache invalidation and reset.
These settings affect estimates, not upstream billing or official catalog price lists.

Only reported or estimated usage is priced by `src/usage/cost.ts`. Partial tokens on an unreported or unsupported attempt do not establish its full cost. `src/usage/summary.ts` marks a multi-attempt request unpriced when any potentially billed attempt lacks measured usage, while a refusal before generation without usage remains a known zero. Measured attempts retain their individual estimates.

## Automatic prices and sources

Price resolution in `src/usage/cost.ts` runs in a fixed order and `MatchedPrice.source` records the
winner: `user` (`providers.<name>.modelCosts`, shown as manual) > `expected` or `jawcode` (verified
official override, bundled jawcode bundle, expected overlay, jawcode model-level vendor price, shown
as official) > `models-dev` > `openrouter` > unknown. The last two tiers run only where the
model-level fallback would otherwise return null, and only when the caller leaves
`allowModelLevelFallback` on. A catalog price has `status: "verified-derived"`, so `estimated` is
true; `sourceRef` is the feed URL and `verifiedAt` the fetch time. A user price, including explicit
all-zero rates, is never replaced or scaled.

`src/usage/price-catalog.ts` owns the two public lists. A model matches a row by
`priceCatalogKey`: the `cn:` channel prefix, any `vendor/` or `zd/` prefix, case, dots versus
hyphens and a `[...]` suffix are ignored. Within one source, two rows with the same key and
different prices make the key ambiguous and store nothing for it. models.dev rows count only for the
model's own vendor providers (resellers are ignored); its rates are already per 1M tokens. OpenRouter
rows come from `data[]`, skip ids that contain `:` (such as `:free`) or start with `openrouter/`,
and multiply the per-token strings by 1,000,000. Rows with both input and output zero, or any invalid
rate, are skipped. Lookup is synchronous from `<configDir>/price-catalog-cache.json` (loaded lazily,
a missing or corrupt file means no catalog) and never touches the network.
`src/usage/price-catalog-version.ts` holds the version counter that
`userCostOverlayVersion()` folds in, so the estimate memo and the usage caches rebuild when a
snapshot changes.

Refresh rules, all in the background and never on a request path:

- Daily: `refreshPriceCatalogs` replaces a source older than 24 hours wholesale. Concurrent callers
  share one fetch per source. A failed source keeps its previous snapshot and is not retried for 60
  seconds; the status carries a short error code and never a body. Fetches use `redirect: "error"`,
  no credentials, a 15 second timeout and a 32 MiB cap.
- Miss-driven: a model no tier could price is queued by `notePriceCatalogMiss`. All misses in one
  tick share one fetch per source (the feeds are whole-table GETs), and only the queued keys are
  merged into the existing snapshot, adding missing keys and leaving every other row alone. A key
  still unfound afterwards cools down for 6 hours (persisted in the cache file) and a source gets at
  most one miss-driven fetch per 6 hour window. The resolver returns null at once and the next
  lookup after the fetch finds the price.
- `GET /api/models` and `GET /api/usage` arm the miss path and start the daily refresh;
  `POST /api/pricing/refresh` forces both sources and clears cooldowns. Under `NODE_ENV=test` nothing
  fetches unless a test injects a fetcher with `setPriceCatalogFetchForTests`.

`providers.<name>.priceMultiplier` (finite, greater than 0, at most 1000; absent means 1, stored
sparse) scales every non-user price for that provider's configured name. It is validated by
`priceMultiplierConfigError`, dropped with a warning by `sanitizeModelCostsForLoad`, and set with
`PUT /api/providers/{provider}/price-multiplier` (`{ multiplier: number | null }`; `null` deletes the
key; the write rolls back when persistence fails). `GET /api/providers/{provider}/model-costs` returns
`priceMultiplier` when set. A provider is a subscription when its effective auth (`authMode`, else
the registry) is `oauth` or `forward`, or it is an exact Codex account identity; its non-user prices
carry `apiEquivalent`. `refreshUserCostOverlays` collects the multipliers and the subscription set
and includes both in the change signature, so editing either bumps the version.
`src/server/management/model-row-price.ts` projects the effective price onto each non-combo
`/api/models` row as `price` (`manual`, `official`, `models-dev` or `openrouter`; absent when
unknown). `costResult` adds `online_price_catalog`, `relay_price_multiplier` and
`subscription_api_equivalent` to the estimate reasons.

Tests: `tests/usage/price-catalog.test.ts` (matching, parsing, cache),
`tests/usage/price-catalog-miss.test.ts` (miss, cooldown, merge),
`tests/usage/price-catalog-resolution.test.ts` (tiers, multiplier, subscription, reasons) and
`tests/server/price-catalog-management-api.test.ts` (both routes, load, row `price`).
