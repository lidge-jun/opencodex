# A3 — #1711 mark zero-credit models and combos inactive without hiding them

Raw research: `_research/1711.md`. **Scope is pending a user decision — see below.**

## Verdict

Real. Served rows are built by `deriveEntry` (`src/codex/catalog/sync.ts:315`) and
always stamped `visibility: "list"` (`:347`, `:414`, account clones `:641`).
`CatalogModel` (`src/codex/catalog/parsing.ts:96-149`) and
`deriveComboCatalogModel` (`src/codex/catalog/aggregation.ts:122-216`) carry
capability and window fields only. No quota, no reason field.

Quota remaining already exists on the routing cache —
`ProviderQuota.creditsUsd.remaining` (`src/providers/quota-types.ts:17-24`),
written on probe (`src/providers/quota.ts:3139-3141`), read fresh within 30 minutes
(`src/providers/quota-routing-cache.ts:16-24`), with the exhaustion predicate
`cachedProviderQuotaIsExhausted` (`src/combos/resolve.ts:78-92`). Combo runtime
already uses it in `targetProviderIsUsable` (`:64-70`) and throws
`NoAvailableComboTargetsError` when everything is exhausted, instead of telling the
catalog anything.

Meanwhile the catalog's only "inactive" mechanisms **remove** the row: the live
filter `filterCatalogVisibleModels` (`src/codex/catalog/provider-fetch.ts:2067-2106`),
the merge drop for disabled routed keys (`sync.ts:961`, `:1181-1184`), and native
`visibility: "hide"` (`src/codex/catalog/metadata.ts:513-531`). So there is no
field today that means "visible but quota-inactive".

## The constraint that makes this a judgment call

Codex Desktop and app-server only understand `visibility: "list" | "hide"` and hold
an in-memory roster (`src/codex/app-server-processes.ts:1224-1228`). A custom field
greys the entry for OpenCodex-aware consumers — the Dashboard — and does nothing in
the native picker. Using `hide` instead is explicitly what the issue rejects.

**Asked the user:** ship the catalog contract and reflect it in the Dashboard only,
drop it from this round, or land the field without GUI work.
**Recommendation: ship the field plus the Dashboard**, because the contract is the
part that cannot be retrofitted later without another catalog migration.

## Fix shape once scope is confirmed

Reuse `cachedProviderQuotaIsExhausted` and the `targetProviderIsUsable` rules —
including the native ChatGPT exemption (`resolve.ts:68-70`) and stale-cache-means-
not-exhausted (`:82`). A helper next to `resolve.ts:78` returns `"no_credit"` only
when every **usable** target has positive exhaustion evidence.

Stamp it on the served row after `buildCatalogEntriesFromObservedState` /
`mergeCatalogEntriesFromObservedState` **without touching `visibility`**, and mirror
it on `GET /v1/models?client_version=` (`src/server/index.ts:1574-1598`). Do not
route it through `filterCatalogVisibleModels`; that filter belongs to operator
disable. Do not reuse `ManagementModelRow.disabled`, which means operator
`disabledModels`.

Follow the **runtime** predicate, not the GUI one. `comboQuotaState`
(`gui/src/combo-workspace-data.ts:437-456`) reads `quotaStateFromReport`
(`:369-411`), which is harsher than `resolve.ts:73-91`: it treats `remaining <= 0`
as exhausted without requiring `percent >= 100` (`:407`) and ignores an elapsed
`resetAt`.

Field naming: the issue's example is `disabled_reason`; the in-tree extension style
is `opencodex_*` (see `SPAWN_PRIORITY_FIELD`, `sync.ts:96-100`). Codex ignores
unknown fields either way (`:96-99`) and `ensureStrictCatalogFields` does not strip
extras (`parsing.ts:526-593`). Pick the `opencodex_`-prefixed name for consistency.

## Regression test

New `tests/codex-integration/catalog-zero-credit-picker.test.ts` (`catalog-*` maps
to `codex-integration`), registered in `layout.json` `explicit` and
`tests/fixtures/test-layout-expected.json`. Seed quota with
`setCachedProviderQuotaForTests` (`quota-routing-cache.ts:27-31`) and build through
`buildCatalogEntriesFromObservedState`.

- every usable target at `{ remaining: 0, percent: 100 }`, `updatedAt = now` → row
  present, `visibility === "list"`, inactive reason `"no_credit"`
- one target with `remaining > 0`, or a cache entry older than 30 minutes → no field
- refill to `remaining > 0` → field gone
- operator `disabledModels` still drops or hides, and never uses this path

## PR

`feat(catalog): mark quota-exhausted models and combos inactive` — branch
`lane-b/4-1711`, PR base `lane-b/3-3859`. Closes #1711.
