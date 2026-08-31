# wp6 — marks in the Add-Provider catalog, and stack delivery

Last because the catalog should draw the full set. Landing it before the sourcing
lanes would show a page of fallback tiles and invite a second pass over the same
file.

## The catalog draws no marks at all

`ProviderCatalog.tsx` renders each preset row as a title, an adapter chip and
badges. This is the surface a user picks a provider FROM -- a list of names where
a logo would do the most work of anywhere in the app, and the one place that has
none.

`providerIconSrc` is keyed by provider id and `CatalogPreset.id` is that same id,
so the existing map serves this surface with no new lookup. The row grows a
`ProviderIcon` before its title block, matching the rail's markup so both
surfaces share the mask decision and the fallback tile.

The `accounts` tier rows get the same treatment: they are providers too, and a
row that shows a logo next to `Cursor` and a bare tile next to `Kiro` reads as a
bug rather than a distinction.

## Guards

1. Every catalog row renders a mark element -- either the asset or the fallback
   tile, never nothing. Falsify by removing the component from the row.
2. The mark is `aria-hidden` beside a visible label, or a screen reader announces
   the provider twice. This is the rule the client marks already follow.
3. Row geometry is stable: adding a 19px mark must not push the badges out of the
   row at mobile width. Measured, not assumed.

## Delivery

Stacked parent-to-child, each PR reviewable alone:

```
wp1 roadmap ──► wp2 wire+guard ──► wp5 painting ──► wp6 catalog
                wp3 lane A ──┤
                wp4 lane B ──┘
```

wp3 and wp4 are siblings off wp2 rather than a chain: they touch disjoint asset
files and adjacent alias rows, so serializing them would only add rebases. wp5
merges after both because it measures the assets they add.

Every push uses `--no-verify`; the local full backend suite is forbidden, so
backend proof comes from CI. Each PR merges with `--squash --admin` only after
its own CI is green including the unsharded macOS job, and each child is rebased
onto the new `dev` tip after its parent lands.

## Closing

The unit moves to `_fin` with an outcome doc recording, per phase, the merge
commit and what the plan got wrong. The previous unit's outcome doc is the
template: it is worth more for the corrections than for the table.
